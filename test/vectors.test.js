'use strict';
// Conformance test vectors (spec/vectors). Every case is checked against both verifier
// implementations: the reference (node:crypto) and the WebCrypto one the browser runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tdx = require('../src/tdx');
const web = require('../src/verifier/webverify');
const { build } = require('../scripts/make-vectors');

const DIR = path.join(__dirname, '../spec/vectors');
const load = f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const KEYS = load('keys.json');
const reg = name => KEYS.registries[name];

test('vectors are reproducible: regenerating gives byte-identical files', () => {
  const fresh = build();
  assert.deepEqual(fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort(), Object.keys(fresh).sort());
  for (const [name, text] of Object.entries(fresh)) assert.equal(fs.readFileSync(path.join(DIR, name), 'utf8'), text, `${name} is stale — run node scripts/make-vectors.js`);
});

test('test key: the published seed gives the published public key', () => {
  const k = tdx.keyFromSeed(KEYS.key_id, KEYS.seed_hex, { validFrom: KEYS.public_key.valid_from });
  assert.deepEqual(k.publicEntry, KEYS.public_key);
});

test('keyFromSeed matches RFC 8032 §7.1 test 1', () => {
  const k = tdx.keyFromSeed('rfc8032-1', '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  assert.equal(Buffer.from(k.publicEntry.x, 'base64url').toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  assert.equal(Buffer.from(tdx.signBytes(k.privateKeyPem, ''), 'base64url').toString('hex'),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
});

test('canonical form (RFC 8785)', () => {
  for (const c of load('canonical.json').cases) {
    assert.equal(tdx.canonicalize(c.input), c.canonical, c.id);
    assert.equal(tdx.sha256(c.canonical), c.sha256, c.id);
  }
});

test('capsules: valid ones verify with exact signing input and hash; invalid ones fail with the stated codes', async () => {
  const cases = load('capsules.json').cases;
  assert.ok(cases.filter(c => !c.expect.valid).length >= 10);
  for (const c of cases) {
    const ref = tdx.verifyCapsule(c.capsule, reg(c.registry));
    const w = await web.verifyCapsule(c.capsule, reg(c.registry));
    for (const [impl, r] of [['reference', ref], ['webcrypto', w]]) {
      assert.equal(r.ok, c.expect.valid, `${c.id} (${impl}): ${r.errors.join('; ')}`);
      assert.deepEqual(tdx.errorCodes(r.errors), c.expect.codes, `${c.id} (${impl}) codes`);
    }
    if (c.expect.valid) {
      assert.equal(tdx.signingInput(c.capsule), c.expect.signing_input, c.id);
      assert.equal(tdx.capsuleHash(c.capsule), c.expect.capsule_hash, c.id);
      assert.equal(ref.hash, c.expect.capsule_hash);
      assert.equal(w.hash, c.expect.capsule_hash);
    }
  }
});

test('days: chain rules and effective records', async () => {
  for (const d of load('days.json').cases) {
    for (const [impl, r] of [['reference', tdx.verifyDay(d.capsules, reg(d.registry))], ['webcrypto', await web.verifyDay(d.capsules, reg(d.registry))]]) {
      assert.equal(r.ok, d.expect.ok, `${d.id} (${impl}): ${r.errors.join('; ')}`);
      assert.deepEqual(tdx.errorCodes(r.errors), d.expect.codes, `${d.id} (${impl}) codes`);
      if (d.expect.effective) assert.deepEqual(new Set(r.days[0].effective), new Set(d.expect.effective), `${d.id} (${impl}) effective`);
    }
  }
});

test('Merkle roots, inclusion proofs and day seals', async () => {
  const m = load('merkle.json');
  for (const r of m.roots) {
    assert.equal(tdx.merkleRoot(r.hashes), r.root, `root of ${r.count}`);
    assert.equal(await web.merkleRoot(r.hashes), r.root);
    for (const p of r.proofs) {
      assert.deepEqual(tdx.merkleProof(r.hashes, p.index), p.proof);
      assert.equal(tdx.verifyProof(r.hashes[p.index], p.proof, r.root), true);
      assert.equal(await web.verifyProof(r.hashes[p.index], p.proof, r.root), true);
      if (r.count > 1) assert.equal(tdx.verifyProof(tdx.sha256('not a leaf'), p.proof, r.root), false);
    }
  }
  for (const s of m.seals) {
    for (const [impl, r] of [['reference', tdx.verifySeal(s.seal, reg(s.registry), s.hashes)], ['webcrypto', await web.verifySeal(s.seal, reg(s.registry), s.hashes)]]) {
      assert.equal(r.ok, s.expect.ok, `${s.id} (${impl})`);
      assert.deepEqual(tdx.errorCodes(r.errors), s.expect.codes, `${s.id} (${impl}) codes`);
    }
  }
});

test('countersignatures', async () => {
  for (const c of load('countersignatures.json').cases) {
    for (const [impl, r] of [['reference', tdx.verifyCountersignature(c.countersignature, reg(c.registry), c.target)],
      ['webcrypto', await web.verifyCountersignature(c.countersignature, reg(c.registry), c.target)]]) {
      assert.equal(r.ok, c.expect.ok, `${c.id} (${impl}): ${r.errors.join('; ')}`);
      assert.deepEqual(tdx.errorCodes(r.errors), c.expect.codes, `${c.id} (${impl}) codes`);
    }
  }
});

test('every failure code is exercised by at least one vector or is documented as reserved', () => {
  const used = new Set();
  for (const f of ['capsules.json', 'days.json', 'countersignatures.json']) for (const c of load(f).cases) c.expect.codes.forEach(x => used.add(x));
  load('merkle.json').seals.forEach(s => s.expect.codes.forEach(x => used.add(x)));
  const spec = fs.readFileSync(path.join(__dirname, '../spec/tdx-2.0.md'), 'utf8');
  for (const code of tdx.ERROR_CODES) assert.ok(spec.includes(`\`${code}\``), `${code} is not documented in spec §9`);
  const unused = tdx.ERROR_CODES.filter(c => !used.has(c));
  assert.deepEqual(unused.sort(), ['amendment_order', 'countersignature_target_missing', 'missing_attestation', 'missing_chain_position',
    'seal_count_mismatch', 'seal_without_records', 'timestamp_invalid', 'unknown_state', 'unsupported_algorithm'].sort(),
    'these codes need a vector, or are covered elsewhere (bundle-level or schema-preempted)');
});
