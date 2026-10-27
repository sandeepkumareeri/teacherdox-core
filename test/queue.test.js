'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tdx = require('../src/tdx');
const E = require('../src/engine');
const { createApi, createStore } = require('../src/api');
const { createQueue } = require('../src/api/queue');
const { telemetry } = require('../src/api/telemetry');
const { BOARD, wav, mockMeta, fakeGemini, engine } = require('./helpers');

const key = tdx.generateKey('k_q', { validFrom: '2026-01-01T00:00:00Z' });
const registry = { keys: [key.publicEntry] };
const TOKENS = { 'tok-a': { tenant: 't_a' }, 'tok-b': { tenant: 't_b' } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tdx-q-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const context = (over = {}) => ({ educator_ref: 'e_1', institution_ref: 'i_1', institution_type: 'school', country: 'IN', locale: 'en-IN', date: '2026-10-28', captured_at: '2026-10-28T05:00:00Z', ...over });
const photo = { media_type: 'image/jpeg', data: BOARD.toString('base64') };
const never = { process: () => new Promise(() => {}), PIPELINE_VERSION: 'test' };

async function server({ eng, store = createStore(), ...opts } = {}) {
  const api = createApi({ engine: eng, store, key, registry, tokens: TOKENS, ...opts });
  const srv = await api.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token = 'tok-a') => {
    const res = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };
  return { api, call, close: () => { api.close(); srv.closeAllConnections?.(); return new Promise(r => srv.close(r)); } };
}
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(15); }
  throw new Error('timed out waiting');
}

test('queue: transient failures retry with backoff; other failures fail at once', async () => {
  const store = createStore();
  let calls = 0;
  const q = createQueue({ store, backoffMs: [10, 20], retries: 2, run: async job => {
    calls++;
    if (job.kind === 'flaky' && calls < 3) throw Object.assign(new Error('no provider could structure: meta: HTTP 503'), { code: 'NO_PROVIDER' });
    if (job.kind === 'bad') throw new Error('engine: context.date is required');
    return { ok: true };
  } });
  const flaky = q.submit({ id: 'j1', kind: 'flaky', input: {} });
  await q.wait('j1', 2000);
  assert.equal(flaky.status, 'done');
  assert.equal(flaky.attempts, 3);
  assert.equal(flaky.input, undefined, 'input is dropped once the job is finished');

  const bad = q.submit({ id: 'j2', kind: 'bad', input: {} });
  await q.wait('j2', 2000);
  assert.equal(bad.status, 'failed');
  assert.equal(bad.attempts, 1);

  calls = -10;   // keep failing: retries run out
  const down = q.submit({ id: 'j3', kind: 'flaky', input: {} });
  await q.wait('j3', 2000);
  assert.equal(down.status, 'failed');
  assert.equal(down.attempts, 3);
  q.close();
});

test('queue: finished jobs are forgotten after the TTL; open ones are kept', async () => {
  const store = createStore();
  let t = Date.parse('2026-10-28T00:00:00Z');
  const q = createQueue({ store, ttlMs: 1000, now: () => t, run: async job => (job.hang ? new Promise(() => {}) : {}) });
  q.submit({ id: 'done1', input: {} });
  q.submit({ id: 'open1', hang: true, input: {} });
  await q.wait('done1', 1000);
  t += 5000;
  q.prune();
  assert.equal(store.getJob('done1'), null);
  assert.equal(store.getJob('open1').status, 'running');
  q.close();
});

test('queue: refuses work beyond its depth; stats show the backlog', async () => {
  const store = createStore();
  const q = createQueue({ store, workers: 1, maxDepth: 2, run: () => new Promise(() => {}) });
  q.submit({ id: 'a', input: {} });
  q.submit({ id: 'b', input: {} });
  assert.throws(() => q.submit({ id: 'c', input: {} }), e => e.code === 'QUEUE_FULL');
  const s = q.stats();
  assert.equal(s.running, 1);
  assert.equal(s.queued, 1);
  q.close();
});

test('durable queue: jobs survive a restart, are re-run, and a stored draft is never made twice', async () => {
  const dir = tmp();
  // 1st process: accepts two captures, then "crashes" with both unfinished (the engine never returns).
  const s1 = await server({ eng: never, store: createStore({ dir }), workers: 1 });
  const a = await s1.call('POST', '/v1/records', { evidence: [photo], text: 'P1', context: context() });
  const b = await s1.call('POST', '/v1/records', { text: 'P2', context: context({ session: { label: 'P2' } }) });
  assert.equal(a.status, 202);
  assert.equal((await s1.call('GET', `/v1/jobs/${a.json.job.id}`)).json.status, 'running');
  assert.equal((await s1.call('GET', `/v1/jobs/${b.json.job.id}`)).json.status, 'queued');
  await s1.close();
  assert.equal(fs.readdirSync(path.join(dir, 'jobs')).filter(f => f.endsWith('.json')).length, 2);

  // Simulate a crash right after job b's draft was stored, before the job was marked done.
  const preStore = createStore({ dir });
  const jobB = preStore.getJob(b.json.job.id);
  const eng = engine({ meta: mockMeta() });
  const draft = (await eng.process({ text: 'P2', context: { ...jobB.input.context, entry_id: jobB.entry_id } })).capsule;
  preStore.putCapsule(draft);

  // 2nd process: recovers both; a is re-run from its stored evidence, b is completed from its draft.
  const meta = mockMeta();
  const s2 = await server({ eng: engine({ meta }), store: createStore({ dir }) });
  const ja = await until(async () => { const j = (await s2.call('GET', `/v1/jobs/${a.json.job.id}`)).json; return j.status === 'done' && j; });
  const jb = await until(async () => { const j = (await s2.call('GET', `/v1/jobs/${b.json.job.id}`)).json; return j.status === 'done' && j; });
  assert.equal(ja.entry_id, a.json.job.entry_id, 'the pre-assigned entry id is kept');
  assert.equal(jb.capsule_id, draft.capsule_id, 'b was completed from the stored draft, not re-run');
  assert.equal((await s2.call('GET', `/v1/records/${jb.entry_id}`)).json.capsules.length, 1);
  assert.ok(meta.calls.some(c => c.path === '/responses'), 'a was re-run with its photo read back from the store');
  assert.equal(meta.calls.filter(c => c.json?.messages?.[0]?.content?.[0]?.text?.includes('P2')).length, 0);

  // Transcripts and other volatile results never reach the disk; finished jobs keep no input.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', `${a.json.job.id}.json`), 'utf8'));
  assert.equal(onDisk.status, 'done');
  assert.equal(onDisk.input, undefined);
  assert.equal(onDisk.transcripts, undefined);
  assert.equal(onDisk.volatile, undefined);
  await s2.close();
});

test('API: a full queue answers 503 with Retry-After', async () => {
  const s = await server({ eng: never, workers: 1, maxQueue: 1 });
  assert.equal((await s.call('POST', '/v1/records', { text: 'P1', context: context() })).status, 202);
  const full = await s.call('POST', '/v1/records', { text: 'P2', context: context() });
  assert.equal(full.status, 503);
  assert.equal(full.headers.get('retry-after'), '30');
  await s.close();
});

test('telemetry: steps, providers, fallback rate, cost where known, capture latency — per tenant', async () => {
  const eng = E.createRecordEngine({ meta: { apiKey: 'k', fetch: mockMeta().fetch }, fallback: E.fromGenerate(fakeGemini().generate) });
  const s = await server({ eng });
  const voice = { media_type: 'audio/wav', data: wav().toString('base64') };
  await s.call('POST', '/v1/records?wait=1', { evidence: [photo, voice], context: context() });
  await s.call('POST', '/v1/records?wait=1', { evidence: [voice], context: context({ locale: 'ml-IN' }) });            // Malayalam → fallback
  await s.call('POST', '/v1/records?wait=1', { text: 'P5', context: context({ date: '2026-10-29' }) });

  const t = (await s.call('GET', '/v1/telemetry')).json;
  assert.equal(t.records, 3);
  assert.equal(t.decisions.auto_lock, 3);
  assert.equal(t.fallback_rate, 0.333);
  const listen = t.steps.filter(x => x.step === 'listen');
  assert.deepEqual(listen.map(x => `${x.provider}/${x.model}`).sort(), ['gemini/gemini-test', 'meta/muse-voice-transcribe-1.0']);
  const asr = listen.find(x => x.provider === 'meta');
  assert.equal(asr.cost_usd, 0.0007);                 // 14 s at Meta's $0.18/h
  assert.equal(asr.calls_with_unknown_cost, 0);
  const read = t.steps.find(x => x.step === 'read' && x.provider === 'meta');
  assert.equal(read.calls, 3);
  assert.deepEqual(read.tokens, { input: 4800, output: 1200 });
  assert.equal(read.calls_with_unknown_cost, 3, 'Muse Spark price unknown → counted, never estimated');
  assert.equal(t.per_record.cost_usd.records_with_unknown_cost, 3);
  assert.ok(t.providers.meta.share > 0.8 && t.providers.gemini.steps === 1);
  assert.equal(t.capture.done, 3);
  assert.equal(t.capture.capture_to_draft_ms.n, 3);
  assert.equal(t.queue.queued, 0);

  assert.equal((await s.call('GET', '/v1/telemetry?from=2026-10-29')).json.records, 1);
  assert.equal((await s.call('GET', '/v1/telemetry?educator_ref=nobody')).json.records, 0);
  assert.equal((await s.call('GET', '/v1/telemetry', null, 'tok-b')).json.records, 0, 'tenant-scoped');
  assert.equal((await s.call('GET', '/v1/telemetry?from=28-10-2026')).status, 400);

  // Locked copies repeat the draft's provenance; telemetry still counts each engine run once.
  const list = (await s.call('GET', '/v1/records?educator_ref=e_1&date=2026-10-28')).json.records;
  for (const r of list) await s.call('POST', `/v1/records/${r.body.entry_id}/lock`);
  assert.equal((await s.call('GET', '/v1/telemetry')).json.records, 3);
  await s.close();
});

test('telemetry() percentiles and empty input', () => {
  const empty = telemetry({ capsules: [] });
  assert.equal(empty.records, 0);
  assert.equal(empty.per_record.model_ms.p50, null);
  const { dist } = require('../src/api/telemetry');
  assert.deepEqual(dist([5, 1, 3, 2, 4, 100]), { n: 6, mean: 19, p50: 3, p95: 100, max: 100 });
});
