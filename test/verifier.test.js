'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const tdx = require('../src/tdx');
const V = require('../src/verifier');

const key = tdx.generateKey('k_v', { validFrom: '2026-01-01T00:00:00Z' });
const registry = { keys: [key.publicEntry] };
const SAMPLE = path.join(__dirname, '../verifier/samples/day-demo.json');
const SAMPLE_KEYS = path.join(__dirname, '../verifier/samples/keys-demo.json');
const TDX = path.join(__dirname, '../bin/tdx');

function body(label, over = {}) {
  return {
    tenant: 't_demo', actor: { educator_ref: 'e_1', institution_ref: 'i_1', institution_type: 'school' },
    session: { kind: 'period', date: '2026-10-28', timezone: 'Asia/Kolkata', label, cohort: '8B', subject: 'Mathematics' },
    content: { title: `Lesson ${label}`, assignments: [{ text: `HW ${label}` }] }, ...over,
  };
}
function day(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(tdx.lock(tdx.draft(body(`P${i + 1}`)), { key, prev: out[i - 1] || null, signedAt: '2026-10-28T10:00:00Z' }));
  return out;
}

test('countersignature: attests a locked record or a sealed day; any change breaks it', () => {
  const d = day(2);
  const cs = tdx.countersign(d[0], { key, approverRef: 'e_hm', role: 'headmaster', signedAt: '2026-10-28T12:00:00Z' });
  assert.deepEqual(tdx.verifyCountersignature(cs, registry, d[0]).errors, []);
  assert.match(tdx.verifyCountersignature(cs, registry, d[1]).errors.join(), /different record/);
  assert.match(tdx.verifyCountersignature({ ...cs, decision: 'returned' }, registry).errors.join(), /does not match/);
  assert.throws(() => tdx.countersign(tdx.draft(body('P9')), { key, approverRef: 'x', role: 'y' }), /only locked/);
  const seal = tdx.sealDay({ scope: tdx.chainScope(d[0]), hashes: d.map(tdx.capsuleHash), key, sealedAt: '2026-10-28T11:00:00Z' });
  const daySig = tdx.countersign(seal, { key, approverRef: 'e_hm', role: 'headmaster', signedAt: '2026-10-28T12:00:00Z' });
  assert.equal(daySig.target.type, 'day_seal');
  assert.equal(tdx.verifyCountersignature(daySig, registry, seal).ok, true);
});

// The WebCrypto verifier must reach the same verdicts, with the same messages, as the reference.
test('WebCrypto verifier agrees with the reference implementation on every scenario', async () => {
  const d = day(4);
  const tampered = structuredClone(d[2]); tampered.body.content.assignments[0].text = 'No homework';
  const fix = tdx.amend(d[0], { content: { title: 'Corrected' } }, { key, prev: d[3], reason: 'typo', amenderRef: 'e_1', signedAt: '2026-10-28T11:00:00Z' });
  const revoked = { keys: [{ ...key.publicEntry, revoked_at: '2026-10-01T00:00:00Z' }] };
  const seal = tdx.sealDay({ scope: tdx.chainScope(d[0]), hashes: d.map(tdx.capsuleHash), key, sealedAt: '2026-10-28T11:00:00Z' });
  const cs = tdx.countersign(seal, { key, approverRef: 'e_hm', role: 'headmaster', signedAt: '2026-10-28T12:00:00Z' });
  const draft = tdx.draft(body('P7'));
  const badSchema = structuredClone(d[0]); badSchema.body.session.timezone = '+05:30';

  const cases = [
    ['full day', d, registry], ['missing middle record', [d[0], d[1], d[3]], registry], ['tampered content', [d[0], d[1], tampered, d[3]], registry],
    ['revoked key', d, revoked], ['unknown key', d, { keys: [] }], ['amendment', [...d, fix], registry], ['draft only', [draft], registry],
    ['schema error', [badSchema], registry], ['sealed + countersigned', { capsules: d, seal, countersignatures: [cs] }, registry],
    ['seal over fewer records', { capsules: d.slice(0, 3), seal }, registry], ['countersignature without its target', [cs], registry],
  ];
  for (const [name, input, reg] of cases) {
    const ref = await V.verify(input, reg), web = await V.verifyWeb(input, reg);
    assert.deepEqual(web, ref, name);
  }
  assert.equal((await V.verify(d, registry)).ok, true);
  assert.equal((await V.verify({ capsules: d, seal, countersignatures: [cs] }, registry)).ok, true);
  for (const bad of ['missing middle record', 'tampered content', 'revoked key', 'unknown key', 'schema error', 'seal over fewer records', 'countersignature without its target']) {
    const [, input, reg] = cases.find(c => c[0] === bad);
    assert.equal((await V.verify(input, reg)).ok, false, bad);
  }
  const web = V.web;
  const hashes = d.map(tdx.capsuleHash);
  assert.equal(await web.merkleRoot(hashes), tdx.merkleRoot(hashes));
  assert.equal(await web.verifyProof(hashes[2], tdx.merkleProof(hashes, 2), seal.merkle_root), true);
});

test('verifyBundle: amendments supersede, embedded keys are flagged, junk is reported', async () => {
  const d = day(2);
  const fix = tdx.amend(d[0], { content: { title: 'Corrected' } }, { key, prev: d[1], reason: 'typo', amenderRef: 'e_1', signedAt: '2026-10-28T11:00:00Z' });
  const r = await V.verify([...d, fix], registry);
  assert.deepEqual(r.capsules.map(c => c.effective), [false, true, true]);
  assert.equal(r.capsules[2].summary.amends, d[0].capsule_id);
  const embedded = await V.verify({ capsules: d, keys: registry.keys });
  assert.equal(embedded.ok, true);
  assert.match(embedded.registry_source, /embedded/);
  assert.match((await V.verify([{ hello: 1 }], registry)).errors.join(), /not .tdx capsules/);
});

test('the browser bundle is self-contained, up to date, and verifies the sample in a bare sandbox', async () => {
  const fresh = V.buildBrowserBundle();
  assert.equal(fs.readFileSync(path.join(__dirname, '../verifier/tdx-verify.js'), 'utf8'), fresh, 'run `npm run build:verifier`');
  const sandbox = { window: {}, crypto: globalThis.crypto, TextEncoder, atob, console };
  vm.runInNewContext(fresh, sandbox);
  const api = sandbox.window.tdxVerify;
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8')), keys = JSON.parse(fs.readFileSync(SAMPLE_KEYS, 'utf8'));
  const ok = await api.verify(sample, keys);
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  assert.equal(ok.countersignatures[0].ok, true);
  sample.capsules[0].body.content.assignments[0].text = 'No homework';
  const bad = await api.verify(sample, keys);
  assert.equal(bad.ok, false);
  assert.match(bad.capsules[0].errors.join(), /signature does not match/);
});

test('sample day: synthetic, marked as such, and valid', async () => {
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  assert.ok(sample.capsules.every(c => /synthetic/.test(c.body.ext['org.teacherdox.sample'])));
  const r = await V.verify(sample, JSON.parse(fs.readFileSync(SAMPLE_KEYS, 'utf8')));
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.days[0].seal.ok, true);
});

test('CLI: tdx verify exits 0 for valid, 1 for altered; validate and hash work', () => {
  const ok = spawnSync(process.execPath, [TDX, 'verify', SAMPLE, '--keys', SAMPLE_KEYS], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /VALID/);
  assert.match(ok.stdout, /countersignature: headmaster/);

  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tdx-'));
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
  sample.capsules[1].body.session.cohort = '9B';
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(sample));
  const bad = spawnSync(process.execPath, [TDX, 'verify', path.join(dir, 'bad.json'), '--keys', SAMPLE_KEYS, '--json'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);

  const val = spawnSync(process.execPath, [TDX, 'validate', SAMPLE], { encoding: 'utf8' });
  assert.equal(val.status, 0, val.stdout);
  fs.writeFileSync(path.join(dir, 'one.json'), JSON.stringify(sample.capsules[0]));
  const h = spawnSync(process.execPath, [TDX, 'hash', path.join(dir, 'one.json')], { encoding: 'utf8' });
  assert.equal(h.stdout.trim(), tdx.capsuleHash(sample.capsules[0]));

  const kg = spawnSync(process.execPath, [TDX, 'keygen', 'k_cli_test', '--out', path.join(dir, 'keys')], { encoding: 'utf8' });
  assert.equal(kg.status, 0, kg.stderr);
  assert.equal(JSON.parse(kg.stdout).kid, 'k_cli_test');
  // POSIX only: Windows has no group/other mode bits (Node reports 0o666); see SECURITY.md for key files there.
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'keys', 'k_cli_test.pem')).mode & 0o077, 0);
});

test('docs example: the live draft confirms, signs and verifies exactly as docs/how-a-record-is-born.md shows', () => {
  const ex = p => path.join(__dirname, '..', 'docs', 'examples', p);
  const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const draft = read(ex('live-draft.json')), signed = read(ex('live-signed.json')), keys = read(ex('keys.json')), seal = read(ex('live-seal.json'));
  assert.ok(tdx.validateCapsule(draft).ok);
  // the evidence hash in the live record is the synthetic board in this repository
  assert.equal(draft.body.evidence[0].id, tdx.sha256(fs.readFileSync(path.join(__dirname, 'fixtures', 'board-synthetic.jpg'))));
  // signed with the published test key, so anyone can reproduce it
  assert.deepEqual(keys.keys[0], read(path.join(__dirname, '..', 'spec', 'vectors', 'keys.json')).public_key);
  const v = tdx.verifyCapsule(signed, keys);
  assert.ok(v.ok, v.errors.join('; '));
  assert.equal(v.hash, 'sha256:f49d8b51e3d42225b07ae256b4fd0aa62c8958a9bfb6abc9bb17c333eee626ac');
  assert.ok(tdx.verifySeal(seal, keys, [v.hash]).ok);
  // locking changed nothing the models produced: only lifecycle, attestation and chain
  const strip = b => ({ ...b, lifecycle: null, attestation: null, chain: null });
  assert.deepEqual(strip(signed.body), strip(draft.body));
});
