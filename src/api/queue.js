'use strict';
// Work queue for record processing (CORE-00 §2.6: capture never waits for AI).
//
// Capture writes the evidence (content-addressed) and a job, and returns. Workers run the
// Record Engine. With a data directory every job is a file, so a restart loses nothing:
// queued jobs are picked up again, and a job that was running when the process stopped is
// run again. That is safe because each job carries a pre-assigned entry_id — if its draft
// was already stored, the job is completed from the stored draft instead of being re-run.
//
// Failures where every provider was down or timed out are retried with backoff; anything
// else fails at once. When the queue is full, capture is refused (503 + Retry-After) rather
// than letting latency grow without bound.
//
//   job: { id, tenant, status: queued | running | retrying | done | failed, attempts,
//          entry_id, created_at, started_at, finished_at, next_attempt_at,
//          input: { evidence: [{ id, media_type, role }], text, context }, auto_lock, … result }

const RETRYABLE = /NO_PROVIDER|TIMEOUT|HTTP 5\d\d|HTTP 429|ECONNRESET|ETIMEDOUT|fetch failed/;
const OPEN = new Set(['queued', 'running', 'retrying']);

/**
 * createQueue({ store, run, workers, maxDepth, retries, backoffMs, ttlMs, now, log })
 *   run(job) → result fields merged into the job (status 'done'); throw to fail / retry
 *   resume(job) → result fields if the job's work is already stored, else null
 */
function createQueue({ store, run, resume = () => null, workers = 2, maxDepth = 1000, retries = 2, backoffMs = [30000, 120000], ttlMs = 7 * 86400000, now = () => Date.now(), log = () => {} }) {
  const ready = [];                 // job ids, oldest first
  const timers = new Set();
  const waiters = new Map();        // job id → [resolve]
  let running = 0, closed = false, submitted = 0;
  const iso = t => new Date(t).toISOString();

  function save(job) { store.putJob(job); }

  function enqueue(job, delayMs = 0) {
    if (delayMs > 0) {
      const t = setTimeout(() => { timers.delete(t); ready.push(job.id); pump(); }, delayMs);
      t.unref?.();
      timers.add(t);
    } else ready.push(job.id);
  }

  function depth() { return store.jobs().filter(j => OPEN.has(j.status)).length; }

  /** Accept a job (already holding its input). Throws { code: 'QUEUE_FULL' } when full. */
  function submit(job) {
    if (depth() >= maxDepth) throw Object.assign(new Error('queue is full'), { code: 'QUEUE_FULL' });
    if (++submitted % 200 === 0) prune();
    Object.assign(job, { status: 'queued', attempts: 0, created_at: job.created_at || iso(now()) });
    save(job);
    enqueue(job);
    pump();
    return job;
  }

  function pump() {
    while (!closed && running < workers && ready.length) {
      const job = store.getJob(ready.shift());
      if (!job || !OPEN.has(job.status)) continue;
      running++;
      work(job).finally(() => { running--; pump(); });
    }
  }

  async function work(job) {
    Object.assign(job, { status: 'running', started_at: job.started_at || iso(now()), attempts: (job.attempts || 0) + 1 });
    save(job);
    try {
      const result = (await resume(job)) || (await run(job));
      finish(job, { status: 'done', ...result });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 500);
      const retryable = RETRYABLE.test(`${e.code || ''} ${msg}`);
      if (retryable && job.attempts <= retries) {
        const wait = backoffMs[Math.min(job.attempts - 1, backoffMs.length - 1)];
        Object.assign(job, { status: 'retrying', error: msg, next_attempt_at: iso(now() + wait) });
        save(job);
        log({ type: 'job_retry', id: job.id, attempt: job.attempts, in_ms: wait, error: msg });
        enqueue(job, wait);
      } else {
        finish(job, { status: 'failed', error: msg });
        log({ type: 'job_failed', id: job.id, attempts: job.attempts, error: msg });
      }
    }
  }

  function finish(job, fields) {
    Object.assign(job, fields, { finished_at: iso(now()) });
    delete job.input;                    // the evidence stays in the store; text and context go
    delete job.next_attempt_at;
    if (fields.status === 'done') delete job.error;
    save(job);
    for (const w of waiters.get(job.id) || []) w();
    waiters.delete(job.id);
  }

  /** Resolve when the job finishes or after ms, whichever comes first. */
  function wait(id, ms) {
    const job = store.getJob(id);
    if (!job || !OPEN.has(job.status)) return Promise.resolve();
    return new Promise(resolve => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      if (!waiters.has(id)) waiters.set(id, []);
      waiters.get(id).push(done);
    });
  }

  /** Forget finished jobs older than ttlMs (their records stay in the store). */
  function prune() {
    for (const job of store.jobs()) {
      if (!OPEN.has(job.status) && now() - Date.parse(job.finished_at || job.created_at) > ttlMs) store.deleteJob(job.id);
    }
  }

  /** After a restart: drop expired finished jobs, run every open one again. */
  function recover() {
    let resumed = 0;
    prune();
    for (const job of store.jobs().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
      if (!OPEN.has(job.status)) continue;
      if (!job.input) { finish(job, { status: 'failed', error: 'job input was lost' }); continue; }
      if (job.status === 'running') log({ type: 'job_resumed', id: job.id, note: 'was running when the process stopped' });
      job.status = 'queued';
      save(job);
      enqueue(job);
      resumed++;
    }
    pump();
    return resumed;
  }

  /** Queue figures, optionally for a subset of jobs (one tenant). */
  function stats(which = () => true) {
    const open = store.jobs().filter(j => OPEN.has(j.status) && which(j));
    const queued = open.filter(j => j.status !== 'running');
    const oldest = queued.reduce((m, j) => Math.min(m, Date.parse(j.created_at)), Infinity);
    return {
      workers, running: open.length - queued.length, queued: queued.filter(j => j.status === 'queued').length, retrying: queued.filter(j => j.status === 'retrying').length,
      max_depth: maxDepth, oldest_wait_ms: Number.isFinite(oldest) ? Math.max(0, now() - oldest) : 0,
    };
  }

  function close() { closed = true; for (const t of timers) clearTimeout(t); timers.clear(); }

  return { submit, wait, recover, stats, close, pump, prune };
}

module.exports = { createQueue, RETRYABLE };
