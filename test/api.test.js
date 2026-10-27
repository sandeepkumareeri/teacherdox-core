'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tdx = require('../src/tdx');
const { createApi, createStore } = require('../src/api');
const { BOARD, RECORD, mockMeta, engine } = require('./helpers');

const key = tdx.generateKey('k_api', { validFrom: '2026-01-01T00:00:00Z' });
const registry = { keys: [key.publicEntry] };
const TOKENS = { 'tok-school': { tenant: 't_school' }, 'tok-other': { tenant: 't_other' } };

async function server({ meta = mockMeta(), store = createStore() } = {}) {
  const api = createApi({ engine: engine({ meta }), store, key: { keyId: key.keyId, privateKeyPem: key.privateKeyPem }, registry, tokens: TOKENS });
  const srv = await api.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token = 'tok-school') => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* html / js */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { srv, call, close: () => new Promise(r => srv.close(r)) };
}

const context = (over = {}) => ({ educator_ref: 'e_t1', institution_ref: 'i_s1', institution_type: 'school', locale: 'ml-IN', country: 'IN', date: '2026-10-28', captured_at: '2026-10-28T05:00:00Z', channel: 'whatsapp', ...over });
const photo = { media_type: 'image/jpeg', data: BOARD.toString('base64') };

test('API: capture → draft → lock / confirm / amend → seal → countersign → export verifies', async t => {
  const meta = mockMeta();
  const { call, close } = await server({ meta });
  t.after(close);

  // Public vs private
  assert.equal((await call('GET', '/v1/health', null, null)).json.ok, true);
  assert.deepEqual((await call('GET', '/.well-known/tdx-keys.json', null, null)).json, registry);
  assert.equal((await call('POST', '/v1/records', { text: 'x', context: context() }, null)).status, 401);
  assert.equal((await call('POST', '/v1/records', { text: 'x', context: context() }, 'wrong')).status, 401);
  assert.equal((await call('POST', '/v1/records', { context: context() })).status, 400);
  assert.match((await call('POST', '/v1/records', { text: 'x', context: { ...context(), date: '28/10' } })).json.error, /YYYY-MM-DD/);

  // Capture a period (wait for the engine) → draft that may auto-lock
  const a = await call('POST', '/v1/records?wait=1', { evidence: [photo], text: 'P2', context: context({ tenant: 'evil' }) });
  assert.equal(a.status, 201, a.text);
  assert.equal(a.json.record.body.tenant, 't_school', 'tenant comes from the token, never the body');
  assert.equal(a.json.job.routing.decision, 'auto_lock');
  assert.equal(a.json.job.message.status, 'രേഖപ്പെടുത്തി. ഒപ്പിടാൻ തയ്യാർ.');
  assert.ok(a.json.job.steps.some(s => s.step === 'read' && s.model === 'muse-spark-1.3'));
  const e1 = a.json.record.body.entry_id;

  const l1 = await call('POST', `/v1/records/${e1}/lock`);
  assert.equal(l1.status, 201, l1.text);
  assert.equal(l1.json.body.lifecycle.state, 'auto_locked');
  assert.deepEqual(l1.json.body.chain, { sequence_index: 0, prev_hash: null });
  assert.equal((await call('POST', `/v1/records/${e1}/lock`)).status, 409);

  // A second period, captured without waiting (202 + job), confirmed by the educator with a correction
  const b =await call('POST', '/v1/records', { text: 'P4 9A equations', context: context({ session: { label: 'P4', cohort: '9A' } }) });
  assert.equal(b.status, 202);
  let job;
  for (let i = 0; i < 50; i++) { job = (await call('GET', b.json.status_url)).json; if (job.status === 'done') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(job.status, 'done');
  assert.equal((await call('GET', b.json.status_url, null, 'tok-other')).status, 404, 'jobs are tenant-scoped');
  const e2 = job.entry_id;

  assert.match((await call('POST', `/v1/records/${e2}/confirm`, { changes: { actor: { educator_ref: 'x' } } })).json.error, /cannot change actor/);
  assert.match((await call('POST', `/v1/records/${e2}/confirm`, { changes: { content: { secret: 1 } } })).json.error, /cannot change content.secret/);
  assert.equal((await call('POST', `/v1/records/${e2}/confirm`, { changes: { session: { cohort: 7 } } })).status, 400);
  const c2 = await call('POST', `/v1/records/${e2}/confirm`, { changes: { content: { assignments: [{ text: 'Ex 2.1 Q1-4', due: null }] } }, confirmed_by: 'e_t1', channel: 'whatsapp' });
  assert.equal(c2.status, 201, c2.text);
  assert.equal(c2.json.body.lifecycle.state, 'confirmed_locked');
  assert.deepEqual(c2.json.body.attestation.edited_fields, ['content.assignments']);
  assert.equal(c2.json.body.chain.sequence_index, 1);
  assert.equal(c2.json.body.session.cohort, '9A');

  // Correction after locking → new capsule, original kept
  assert.equal((await call('POST', `/v1/records/${e2}/amend`, { changes: { content: { next: 'x' } } })).status, 400, 'reason required');
  const am = await call('POST', `/v1/records/${e2}/amend`, { changes: { content: { assignments: [{ text: 'Ex 2.1 Q1-6', due: null }] } }, reason: 'Q1-6, not Q1-4' });
  assert.equal(am.status, 201, am.text);
  assert.equal(am.json.body.amendment.amends_capsule_id, c2.json.capsule_id);
  const rec = await call('GET', `/v1/records/${e2}`);
  assert.equal(rec.json.effective.capsule_id, am.json.capsule_id);
  assert.equal(rec.json.capsules.length, 3);   // draft, confirmed, amendment
  assert.equal((await call('GET', `/v1/records/${e2}`, null, 'tok-other')).status, 404, 'records are tenant-scoped');

  // Approver countersigns one record; the day is sealed and countersigned
  assert.equal((await call('POST', `/v1/records/${e1}/countersign`, { role: 'headmaster' })).status, 400);
  assert.equal((await call('POST', `/v1/records/${e1}/countersign`, { approver_ref: 'e_hm', role: 'headmaster' })).status, 201);
  assert.equal((await call('POST', '/v1/days/e_t1/2026-10-28/countersign', { approver_ref: 'e_hm', role: 'headmaster' })).status, 409, 'seal first');
  const seal = await call('POST', '/v1/days/e_t1/2026-10-28/seal');
  assert.equal(seal.status, 201);
  assert.equal(seal.json.count, 3);
  const dcs = await call('POST', '/v1/days/e_t1/2026-10-28/countersign', { approver_ref: 'e_hm', role: 'headmaster', note: 'Seen' });
  assert.equal(dcs.status, 201);

  const proof = await call('GET', `/v1/days/e_t1/2026-10-28/proof/${c2.json.capsule_id}`);
  assert.equal(tdx.verifyProof(proof.json.capsule_hash, proof.json.proof, proof.json.merkle_root), true);

  const exp = await call('GET', '/v1/days/e_t1/2026-10-28');
  assert.equal(exp.json.verification.ok, true, exp.json.verification.errors.join('\n'));
  assert.equal(exp.json.capsules.length, 3);
  assert.equal(exp.json.countersignatures.length, 2);

  // Anyone can verify the export, with no token; altering it is caught
  const v = await call('POST', '/v1/verify', { capsules: exp.json.capsules, seal: exp.json.seal, countersignatures: exp.json.countersignatures }, null);
  assert.equal(v.json.ok, true, v.json.errors.join('\n'));
  const forged = structuredClone(exp.json.capsules); forged[0].body.session.cohort = '10A';
  const v2 = await call('POST', '/v1/verify', { capsules: forged, seal: exp.json.seal }, null);
  assert.equal(v2.json.ok, false);

  const list = await call('GET', '/v1/records?educator_ref=e_t1&date=2026-10-28');
  assert.equal(list.json.records.length, 2);
});

test('API: a draft that needs confirmation cannot be auto-locked; a later record after a seal needs a new seal', async t => {
  const meta = mockMeta({ check: { checks: [{ field: 'content.assignments', verdict: 'unsupported', detail: 'not on board' }] } });
  const { call, close } = await server({ meta });
  t.after(close);
  const r = await call('POST', '/v1/records?wait=1', { evidence: [photo], context: context({ locale: 'pt-BR' }) });
  assert.equal(r.json.job.routing.decision, 'confirm');
  const lock = await call('POST', `/v1/records/${r.json.record.body.entry_id}/lock`);
  assert.equal(lock.status, 409);
  assert.deepEqual(lock.json.confirm_fields, ['content.assignments']);
  const msg = await call('GET', `/v1/records/${r.json.record.body.entry_id}?locale=pt-BR`);
  assert.equal(msg.json.message.status, 'Registrado. Confira: tarefa de casa.');

  await call('POST', `/v1/records/${r.json.record.body.entry_id}/confirm`, {});
  await call('POST', '/v1/days/e_t1/2026-10-28/seal');
  const r2 = await call('POST', '/v1/records?wait=1', { text: 'P5', context: context() });
  await call('POST', `/v1/records/${r2.json.record.body.entry_id}/confirm`, {});
  assert.match((await call('POST', '/v1/days/e_t1/2026-10-28/countersign', { approver_ref: 'e_hm', role: 'headmaster' })).json.error, /seal the day again/);
  assert.equal((await call('POST', '/v1/days/e_t1/2026-10-28/seal')).json.count, 2);
});

test('API: auto_lock on capture, parallel locks keep the chain contiguous', async t => {
  const { call, close } = await server();
  t.after(close);
  const ids = await Promise.all([1, 2, 3, 4, 5].map(i => call('POST', '/v1/records?wait=1', { text: `P${i}`, auto_lock: true, context: context({ session: { label: `P${i}` } }) })));
  assert.ok(ids.every(r => r.json.job.state === 'auto_locked'), JSON.stringify(ids.map(r => r.json.job)));
  const exp = await call('GET', '/v1/days/e_t1/2026-10-28');
  assert.deepEqual(exp.json.capsules.map(c => c.body.chain.sequence_index), [0, 1, 2, 3, 4]);
  assert.equal(exp.json.verification.ok, true);
});

test('API: records survive a restart when a data directory is used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdx-store-'));
  const s1 = await server({ store: createStore({ dir }) });
  const r = await s1.call('POST', '/v1/records?wait=1', { evidence: [photo], text: 'P1', auto_lock: true, context: context() });
  await s1.close();
  assert.ok(fs.readdirSync(path.join(dir, 'evidence')).length === 1);

  const s2 = await server({ store: createStore({ dir }) });
  const again = await s2.call('GET', `/v1/records/${r.json.record.body.entry_id}`);
  assert.equal(again.json.effective.body.lifecycle.state, 'auto_locked');
  const r2 = await s2.call('POST', '/v1/records?wait=1', { text: 'P2', auto_lock: true, context: context() });
  assert.equal(r2.json.record.body.chain.sequence_index, 1, 'the chain continues after a restart');
  assert.equal((await s2.call('GET', '/v1/days/e_t1/2026-10-28')).json.verification.ok, true);
  await s2.close();
});

test('API: verifier page, bundle and sample are served; unknown paths 404', async t => {
  const { call, close } = await server();
  t.after(close);
  const redirect = await call('GET', '/verify', null, null);
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/verify/');
  const page = await call('GET', '/verify/', null, null);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /Verify a teaching record/);
  assert.match((await call('GET', '/verify/tdx-verify.js', null, null)).text, /window\.tdxVerify/);
  assert.deepEqual((await call('GET', '/verify/keys.json', null, null)).json, registry);
  assert.equal((await call('GET', '/verify/samples/day-demo.json', null, null)).json.capsules.length, 4);
  assert.equal((await call('GET', '/verify/samples/../../package.json', null, null)).status, 404);
  assert.equal((await call('GET', '/nope', null, null)).status, 404);
  assert.equal((await call('DELETE', '/v1/health', null, null)).status, 405);
});
