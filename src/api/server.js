'use strict';
// TeacherDox Core REST API (/v1) on node:http — no framework.
//
// Public (no token): health, the key registry, verification, the verifier page.
// Everything else needs `Authorization: Bearer <token>`; each token belongs to one tenant
// and only ever sees that tenant's records.
//
//   POST /v1/records                          evidence + context → job (202), or the draft with ?wait=1
//   GET  /v1/jobs/:id                         job status / result
//   GET  /v1/telemetry?from=&to=&educator_ref=  cost, latency, fallback and routing figures from provenance
//   GET  /v1/records?educator_ref=&date=      the educator's entries for a day
//   GET  /v1/records/:entry_id                effective capsule, history, countersignatures, message
//   POST /v1/records/:entry_id/lock           auto-lock a draft the policy allows to auto-lock
//   POST /v1/records/:entry_id/confirm        educator confirms (optionally with corrections) → confirmed_locked
//   POST /v1/records/:entry_id/amend          correction to a locked record → new capsule
//   POST /v1/records/:entry_id/countersign    approver attests the record
//   GET  /v1/days/:educator_ref/:date         the day's chain + seal + countersignatures + verification (exportable)
//   POST /v1/days/:educator_ref/:date/seal    signed Merkle seal over the day
//   POST /v1/days/:educator_ref/:date/countersign   approver countersigns the sealed day (the register)
//   GET  /v1/days/:educator_ref/:date/proof/:capsule_id   inclusion proof against the latest seal
//   POST /v1/verify                           verify anything (public)
//   GET  /v1/keys, /.well-known/tdx-keys.json  published key registry
//   GET  /verify                              public verifier page (verifies in the browser)

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tdx = require('../tdx');
const packs = require('../packs');
const { verify, buildBrowserBundle } = require('../verifier');
const { createQueue } = require('./queue');
const { telemetry } = require('./telemetry');

const MAX_BODY = 30 * 1024 * 1024;
const MAX_EVIDENCE = 10;
const MEDIA = /^(image\/(jpeg|png|webp)|audio\/(ogg|wav|x-wav|mpeg|mp4|aac|webm|amr))$/;
const EDITABLE = {
  session: ['label', 'cohort', 'subject', 'course', 'unit', 'starts_at', 'duration_min'],
  content: ['title', 'topics', 'summary', 'method', 'assignments', 'next', 'materials', 'notes'],
  curriculum: ['framework', 'tags'],
};
const PAGE_DIR = path.join(__dirname, '../../verifier');

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

/**
 * createApi({ engine, store, key, registry, tokens, workers, maxQueue, retries, backoffMs, log })
 *   engine:   from createRecordEngine (needed only for POST /v1/records)
 *   key:      { keyId, privateKeyPem } — the custodial signing key
 *   registry: { keys: [...] } — published; must contain key's public entry
 *   tokens:   { [token]: { tenant } }
 */
function createApi({ engine, store, key, registry, tokens = {}, workers = 2, maxQueue = 1000, retries = 2, backoffMs, log = () => {} }) {
  if (!store || !key || !registry) throw new Error('createApi: store, key and registry are required');
  const tokenHashes = Object.entries(tokens).map(([t, v]) => [crypto.createHash('sha256').update(t).digest(), v]);
  let bundle = null;

  // ── auth ──────────────────────────────────────────────────────────────────────
  function auth(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'missing bearer token');
    const h = crypto.createHash('sha256').update(m[1]).digest();
    const hit = tokenHashes.find(([th]) => crypto.timingSafeEqual(th, h));
    if (!hit) throw new HttpError(401, 'invalid token');
    return hit[1];
  }

  // ── per-day lock: chain appends for one educator-day happen one at a time ────────
  const chains = new Map();
  function serial(scope, fn) {
    const prev = chains.get(scope) || Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(scope, run.catch(() => {}));
    return run;
  }

  // ── work queue (durable with a data directory — see queue.js) ──────────────────
  async function runJob(job) {
    const { evidence, text, context } = job.input;
    const ev = evidence.map(e => {
      const bytes = store.getEvidence(e.id);
      if (!bytes) throw new Error(`evidence ${e.id} is missing from the store`);
      return { bytes, media_type: e.media_type, role: e.role };
    });
    const r = await engine.process({ evidence: ev, text, context: { ...context, entry_id: job.entry_id } });
    store.putCapsule(r.capsule);
    job.volatile = { transcripts: r.transcripts.map(t => ({ language: t.language, text: t.text })) };   // returned, never written to disk
    return complete(job, r.capsule, r.routing);
  }
  // The process stopped after the draft was stored: finish the job from the stored draft.
  function resumeJob(job) {
    const list = store.byEntry(job.entry_id);
    return list.length ? complete(job, list[0], { confirm_fields: [], reasons: [], ...list[0].body.provenance?.routing }) : null;
  }
  async function complete(job, draft, routing) {
    const list = store.byEntry(draft.body.entry_id);
    let capsule = effective(list);
    if (job.auto_lock && routing.decision === 'auto_lock' && !lockedOf(list).length) {
      capsule = await lockEntry(job.tenant, draft.body.entry_id, 'auto_locked', {});
    }
    log({ type: 'record', entry_id: draft.body.entry_id, decision: routing.decision });
    return {
      entry_id: draft.body.entry_id, capsule_id: capsule.capsule_id, state: capsule.body.lifecycle.state, routing,
      message: packs.describe({ routing, capsule: draft }, {}),
      steps: draft.body.provenance.steps.map(s => ({ step: s.step, provider: s.provider, model: s.model, status: s.status, ms: s.ms, cost_usd: s.cost_usd })),
    };
  }
  const publicJob = j => {
    const { input, tenant, auto_lock, volatile, ...rest } = j;
    return { ...rest, ...(volatile ? { transcripts: volatile.transcripts } : {}) };
  };

  // ── record helpers ──────────────────────────────────────────────────────────────
  function entryCapsules(tenant, entryId) {
    const list = store.byEntry(entryId);
    if (!list.length || list[0].body.tenant !== tenant) throw new HttpError(404, 'no such record');
    return list;
  }
  const lockedOf = list => list.filter(c => tdx.LOCKED.has(c.body.lifecycle.state));
  function effective(list) {
    const locked = lockedOf(list);
    if (!locked.length) return list[list.length - 1];
    const amended = new Set(locked.map(c => c.body.amendment?.amends_capsule_id).filter(Boolean));
    return locked.filter(c => !amended.has(c.capsule_id)).pop();
  }

  async function lockEntry(tenant, entryId, state, { changes, by, channel = 'api' }) {
    const list = entryCapsules(tenant, entryId);
    if (lockedOf(list).length) throw new HttpError(409, 'record is already locked; send a correction to /amend');
    const d = list[list.length - 1];
    const routing = d.body.provenance?.routing || {};
    if (state === 'auto_locked' && routing.decision !== 'auto_lock') {
      throw new HttpError(409, `this record needs the educator's confirmation (${routing.decision || 'no routing'})`, { confirm_fields: routing.confirm_fields || [], reasons: routing.reasons || [] });
    }
    const edited = changes ? changedFields(changes) : [];
    const body = changes ? merge(structuredClone(d.body), changes) : d.body;
    const attestation = state === 'auto_locked'
      ? { policy_profile: routing.policy_profile, policy_version: routing.policy_version, auto_accepted_fields: routing.auto_accepted_fields || [] }
      : { policy_profile: routing.policy_profile, policy_version: routing.policy_version, auto_accepted_fields: (routing.auto_accepted_fields || []).filter(f => !edited.includes(f)),
          confirmed_fields: [...new Set([...(routing.confirm_fields || []), ...edited])], edited_fields: edited,
          confirmation: { by: by || d.body.actor.educator_ref, at: new Date().toISOString(), channel } };
    const scope = tdx.chainScope(d);
    return serial(scope, () => {
      const c = tdx.lock({ body }, { key, prev: store.lastLocked(scope), state, attestation });
      mustValidate(c);
      store.putCapsule(c);
      return c;
    });
  }

  function mustValidate(c) {
    const v = tdx.validateCapsule(c);
    if (!v.ok) throw new HttpError(400, 'the change would make an invalid record', { errors: v.errors.slice(0, 10) });
  }

  function day(tenant, educatorRef, date) {
    const scope = [tenant, educatorRef, date].join('|');
    const capsules = store.day(scope);
    const seal = store.latestSeal(scope);
    const cs = [
      ...capsules.flatMap(c => store.countersignaturesFor('capsule', c.capsule_id)),
      ...store.countersignaturesFor('day_seal', scope),
    ];
    return { scope, capsules, seal, seals: store.seals(scope), countersignatures: cs };
  }

  // ── routes ──────────────────────────────────────────────────────────────────────
  const routes = [
    ['GET', /^\/v1\/health$/, false, () => ({ ok: true, service: 'teacherdox-core', spec_version: tdx.SPEC_VERSION, pipeline_version: engine?.PIPELINE_VERSION || null })],
    ['GET', /^\/(v1\/keys|\.well-known\/tdx-keys\.json)$/, false, () => registry],

    ['POST', /^\/v1\/verify$/, false, async ({ body }) => {
      const input = body && body.input !== undefined ? body.input : body;
      return verify(input, body?.registry || registry);
    }],

    ['POST', /^\/v1\/records$/, true, async ({ body, tenant, query }) => {
      if (!queue) throw new HttpError(503, 'no record engine configured');
      const input = parseRecordInput(body, tenant);
      const evidence = input.evidence.map(e => {
        const id = tdx.sha256(e.bytes);
        store.putEvidence(id, e.bytes, e.media_type);
        return { id, media_type: e.media_type, ...(e.role ? { role: String(e.role) } : {}) };
      });
      const job = { id: tdx.uuidv7(), entry_id: tdx.uuidv7(), tenant, auto_lock: !!body.auto_lock, input: { evidence, text: input.text, context: input.context } };
      try { queue.submit(job); } catch (e) {
        if (e.code === 'QUEUE_FULL') throw new HttpError(503, 'the processing queue is full; try again shortly', { retry_after_s: 30 });
        throw e;
      }
      if (query.get('wait') === '1' || query.get('wait') === 'true') {
        await queue.wait(job.id, 120000);
        if (job.status === 'done') {
          const list = store.byEntry(job.entry_id);
          return { status: 201, body: { job: publicJob(job), record: effective(list) } };
        }
      }
      return { status: 202, body: { job: publicJob(job), status_url: `/v1/jobs/${job.id}` } };
    }],

    ['GET', /^\/v1\/telemetry$/, true, ({ tenant, query }) => {
      const filter = { from: query.get('from'), to: query.get('to'), educator_ref: query.get('educator_ref') };
      for (const k of ['from', 'to']) if (filter[k] && !/^\d{4}-\d{2}-\d{2}$/.test(filter[k])) throw new HttpError(400, `${k} must be YYYY-MM-DD`);
      return telemetry({
        capsules: store.capsules(tenant), jobs: store.jobs().filter(j => j.tenant === tenant),
        queue: queue ? queue.stats(j => j.tenant === tenant) : null, filter,
      });
    }],

    ['GET', /^\/v1\/jobs\/([0-9a-f-]{36})$/, true, ({ params, tenant }) => {
      const job = store.getJob(params[0]);
      if (!job || job.tenant !== tenant) throw new HttpError(404, 'no such job');
      return publicJob(job);
    }],

    ['GET', /^\/v1\/records$/, true, ({ tenant, query }) => {
      const educatorRef = query.get('educator_ref'), date = query.get('date');
      if (!educatorRef || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'educator_ref and date (YYYY-MM-DD) are required');
      return { records: store.entriesOn(tenant, educatorRef, date).map(e => effective(store.byEntry(e))) };
    }],

    ['GET', /^\/v1\/records\/([0-9a-f-]{36})$/, true, ({ params, tenant, query }) => {
      const list = entryCapsules(tenant, params[0]);
      const eff = effective(list);
      const routing = eff.body.provenance?.routing;
      const message = eff.body.lifecycle.state === 'draft' && routing
        ? packs.describe({ routing: { confirm_fields: [], reasons: [], ...routing }, capsule: eff }, { locale: query.get('locale') || eff.body.locale })
        : null;
      return { entry_id: params[0], effective: eff, capsules: list, countersignatures: lockedOf(list).flatMap(c => store.countersignaturesFor('capsule', c.capsule_id)), message };
    }],

    ['POST', /^\/v1\/records\/([0-9a-f-]{36})\/lock$/, true, async ({ params, tenant }) =>
      ({ status: 201, body: await lockEntry(tenant, params[0], 'auto_locked', {}) })],

    ['POST', /^\/v1\/records\/([0-9a-f-]{36})\/confirm$/, true, async ({ params, tenant, body }) =>
      ({ status: 201, body: await lockEntry(tenant, params[0], 'confirmed_locked', { changes: checkChanges(body?.changes, false), by: body?.confirmed_by, channel: body?.channel }) })],

    ['POST', /^\/v1\/records\/([0-9a-f-]{36})\/amend$/, true, async ({ params, tenant, body }) => {
      const list = entryCapsules(tenant, params[0]);
      if (!lockedOf(list).length) throw new HttpError(409, 'record is not locked yet; confirm it with corrections instead');
      const changes = checkChanges(body?.changes, true);
      if (!body?.reason) throw new HttpError(400, 'reason is required');
      const orig = effective(list);
      const scope = tdx.chainScope(orig);
      const c = await serial(scope, () => {
        const a = tdx.amend(orig, changes, {
          key, prev: store.lastLocked(scope), reason: String(body.reason).slice(0, 500), amendedFields: changedFields(changes),
          amenderRef: body.amended_by || orig.body.actor.educator_ref,
          attestation: { confirmation: { by: body.amended_by || orig.body.actor.educator_ref, at: new Date().toISOString(), channel: body.channel || 'api' } },
        });
        mustValidate(a);
        store.putCapsule(a);
        return a;
      });
      return { status: 201, body: c };
    }],

    ['POST', /^\/v1\/records\/([0-9a-f-]{36})\/countersign$/, true, ({ params, tenant, body }) => {
      const list = entryCapsules(tenant, params[0]);
      if (!lockedOf(list).length) throw new HttpError(409, 'only locked records can be countersigned');
      const cs = tdx.countersign(effective(list), countersignArgs(body));
      store.putCountersignature(cs);
      return { status: 201, body: cs };
    }],

    ['GET', /^\/v1\/days\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/, true, async ({ params, tenant }) => {
      const d = day(tenant, decodeURIComponent(params[0]), params[1]);
      const verification = await verify({ capsules: d.capsules, seal: d.seal, countersignatures: d.countersignatures }, registry);
      return { ...d, registry_url: '/v1/keys', verification: { ok: verification.ok, errors: verification.errors } };
    }],

    ['POST', /^\/v1\/days\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/seal$/, true, ({ params, tenant }) => {
      const scope = [tenant, decodeURIComponent(params[0]), params[1]].join('|');
      return serial(scope, () => {
        const capsules = store.day(scope);
        if (!capsules.length) throw new HttpError(409, 'no locked records on this day');
        const seal = tdx.sealDay({ scope, hashes: capsules.map(tdx.capsuleHash), key });
        store.putSeal(seal);
        return { status: 201, body: seal };
      });
    }],

    ['POST', /^\/v1\/days\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/countersign$/, true, ({ params, tenant, body }) => {
      const scope = [tenant, decodeURIComponent(params[0]), params[1]].join('|');
      const seal = store.latestSeal(scope);
      if (!seal) throw new HttpError(409, 'seal the day first');
      if (seal.count !== store.day(scope).length) throw new HttpError(409, 'records were added after the seal; seal the day again');
      const cs = tdx.countersign(seal, countersignArgs(body));
      store.putCountersignature(cs);
      return { status: 201, body: cs };
    }],

    ['GET', /^\/v1\/days\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/proof\/([0-9a-f-]{36})$/, true, ({ params, tenant }) => {
      const scope = [tenant, decodeURIComponent(params[0]), params[1]].join('|');
      const seal = store.latestSeal(scope);
      if (!seal) throw new HttpError(404, 'day is not sealed');
      const hashes = store.day(scope).slice(0, seal.count).map(tdx.capsuleHash);
      const c = store.getCapsule(params[2]);
      const i = c ? store.day(scope).findIndex(x => x.capsule_id === c.capsule_id) : -1;
      if (i < 0 || i >= seal.count) throw new HttpError(404, 'record is not covered by the latest seal');
      return { capsule_id: c.capsule_id, capsule_hash: hashes[i], proof: tdx.merkleProof(hashes, i), merkle_root: seal.merkle_root, seal };
    }],

    ['GET', /^\/verify$/, false, () => ({ redirect: '/verify/' })],
    ['GET', /^\/verify\/$/, false, () => ({ raw: fs.readFileSync(path.join(PAGE_DIR, 'index.html')), type: 'text/html; charset=utf-8' })],
    ['GET', /^\/verify\/tdx-verify\.js$/, false, () => ({ raw: (bundle ||= buildBrowserBundle()), type: 'text/javascript; charset=utf-8' })],
    ['GET', /^\/verify\/keys\.json$/, false, () => registry],
    ['GET', /^\/verify\/samples\/(day-demo|keys-demo)\.json$/, false, ({ params }) =>
      ({ raw: fs.readFileSync(path.join(PAGE_DIR, 'samples', `${params[0]}.json`)), type: 'application/json; charset=utf-8' })],
  ];

  function countersignArgs(body = {}) {
    if (!body.approver_ref || !body.role) throw new HttpError(400, 'approver_ref and role are required');
    if (body.decision && !['approved', 'returned'].includes(body.decision)) throw new HttpError(400, 'decision must be approved or returned');
    return { key, approverRef: String(body.approver_ref), role: String(body.role), decision: body.decision || 'approved', note: body.note ? String(body.note).slice(0, 500) : null };
  }

  // ── request handling ──────────────────────────────────────────────────────────────
  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const t0 = Date.now();
    try {
      const route = routes.find(([m, re]) => (m === req.method || (m === 'GET' && req.method === 'HEAD')) && re.test(url.pathname));
      if (!route) {
        if (routes.some(([, re]) => re.test(url.pathname))) throw new HttpError(405, 'method not allowed');
        throw new HttpError(404, 'not found');
      }
      const [, re, needsAuth, fn] = route;
      const who = needsAuth ? auth(req) : null;
      const body = req.method === 'POST' ? await readJson(req) : null;
      const out = await fn({ params: re.exec(url.pathname).slice(1), body, query: url.searchParams, tenant: who?.tenant });
      if (out && out.redirect) { res.writeHead(301, { Location: out.redirect }); return res.end(); }
      if (out && out.raw) return send(res, 200, out.raw, out.type);
      const wrapped = out && typeof out.status === 'number' && out.body !== undefined;
      send(res, wrapped ? out.status : 200, JSON.stringify(wrapped ? out.body : out));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) log({ type: 'error', path: url.pathname, error: e.stack || String(e) });
      const { status: _s, message, ...extra } = e;
      if (e.retry_after_s) res.setHeader('Retry-After', String(e.retry_after_s));
      send(res, status, JSON.stringify({ error: status === 500 ? 'internal error' : e.message, ...(status === 500 ? {} : extra) }));
    } finally {
      log({ type: 'request', method: req.method, path: url.pathname, ms: Date.now() - t0 });
    }
  }

  // Created last: recovery may finish jobs at once, which uses the helpers above.
  const queue = engine ? createQueue({ store, run: runJob, resume: resumeJob, workers, maxDepth: maxQueue, retries, ...(backoffMs ? { backoffMs } : {}), log }) : null;
  const resumed = queue ? queue.recover() : 0;
  if (resumed) log({ type: 'queue_recovered', jobs: resumed });

  return {
    handler,
    queue,
    close: () => queue?.close(),
    listen(port = 8080, host = '127.0.0.1') {
      const server = http.createServer(handler);
      return new Promise(resolve => server.listen(port, host, () => resolve(server)));
    },
  };
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'request too large')); req.destroy(); }
      else chunks.push(d);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

/** POST /v1/records body → engine input; the tenant always comes from the token. */
function parseRecordInput(body, tenant) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON body required');
  const ev = Array.isArray(body.evidence) ? body.evidence : [];
  if (ev.length > MAX_EVIDENCE) throw new HttpError(400, `at most ${MAX_EVIDENCE} pieces of evidence`);
  const evidence = ev.map((e, i) => {
    if (!e || !MEDIA.test(String(e.media_type))) throw new HttpError(400, `evidence[${i}].media_type must be an image or audio type`);
    if (typeof e.data !== 'string' || !e.data) throw new HttpError(400, `evidence[${i}].data must be base64`);
    const bytes = Buffer.from(e.data, 'base64');
    if (!bytes.length) throw new HttpError(400, `evidence[${i}] is empty`);
    return { bytes, media_type: e.media_type, role: e.role };
  });
  const text = [].concat(body.text || []).map(String).filter(Boolean);
  if (!evidence.length && !text.length) throw new HttpError(400, 'send at least one photo, voice note or text');
  const context = { ...(body.context || {}), tenant };
  for (const k of ['educator_ref', 'institution_ref', 'institution_type', 'date']) if (!context[k]) throw new HttpError(400, `context.${k} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(context.date)) throw new HttpError(400, 'context.date must be YYYY-MM-DD');
  return { evidence, text, context };
}

/** Only session / content / curriculum fields can be changed by a person. */
function checkChanges(changes, required) {
  if (changes == null) { if (required) throw new HttpError(400, 'changes are required'); return null; }
  if (typeof changes !== 'object' || Array.isArray(changes)) throw new HttpError(400, 'changes must be an object');
  for (const [group, fields] of Object.entries(changes)) {
    if (!EDITABLE[group]) throw new HttpError(400, `cannot change ${group}`);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new HttpError(400, `changes.${group} must be an object`);
    for (const f of Object.keys(fields)) if (!EDITABLE[group].includes(f)) throw new HttpError(400, `cannot change ${group}.${f}`);
  }
  if (!changedFields(changes).length) { if (required) throw new HttpError(400, 'changes are empty'); return null; }
  return changes;
}
const changedFields = changes => Object.entries(changes || {}).flatMap(([g, f]) => Object.keys(f).map(k => `${g}.${k}`));
function merge(target, src) {
  for (const [g, fields] of Object.entries(src)) target[g] = { ...(target[g] || {}), ...fields };
  return target;
}

module.exports = { createApi, HttpError, parseRecordInput };
