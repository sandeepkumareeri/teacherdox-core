'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tdx = require('../src/tdx');

const key = tdx.generateKey('k_test_2026', { validFrom: '2026-01-01T00:00:00Z' });
const registry = { keys: [key.publicEntry] };

function body(over = {}) {
  return {
    tenant: 't_demo', locale: 'ml-IN', record_locale: 'en', country: 'IN',
    actor: { educator_ref: 'e_001', institution_ref: 'i_001', institution_type: 'school' },
    session: { kind: 'period', date: '2026-10-28', timezone: 'Asia/Kolkata', label: 'P2', cohort: '8B', subject: 'Mathematics', unit: 'Fractions' },
    source: { channel: 'whatsapp', capture_methods: ['photo', 'voice'], captured_at: '2026-10-28T04:52:05Z' },
    evidence: [{ id: tdx.sha256('board-photo-bytes'), media_type: 'image/jpeg', bytes: 18, role: 'board' }],
    content: { title: 'Adding fractions with unlike denominators', topics: ['Fractions', 'LCM'], assignments: [{ text: 'Ex 3.2 Q1-5' }] },
    provenance: { pipeline_version: 'core-0.1', steps: [], overall_confidence: 0.91, field_confidence: {} },
    ...over,
  };
}
const day = (n) => {   // n locked capsules for one educator-day
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = tdx.draft(body({ session: { ...body().session, label: `P${i + 1}` } }));
    out.push(tdx.lock(d, { key, prev: out[i - 1] || null, signedAt: '2026-10-28T05:00:00Z' }));
  }
  return out;
};

test('canonical form follows RFC 8785 (key order, numbers, no whitespace)', () => {
  assert.equal(tdx.canonicalize({ b: 1, a: [true, null, 'x'], c: { z: 0.002, y: 4.50, x: 1e30 } }),
    '{"a":[true,null,"x"],"b":1,"c":{"x":1e+30,"y":4.5,"z":0.002}}');
  assert.equal(tdx.canonicalize({ '€': 1, '\r': 2, a: -0 }), '{"\\r":2,"a":0,"€":1}');
  assert.equal(tdx.canonicalize({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => tdx.canonicalize({ a: NaN }));
});

test('uuidv7 ids are time-ordered and well-formed', () => {
  const a = tdx.uuidv7(1_700_000_000_000), b = tdx.uuidv7(1_700_000_000_001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  assert.ok(a < b);
  assert.equal(tdx.uuidv7Time(a), 1_700_000_000_000);
});

test('a locked capsule verifies; any change to its content breaks the signature', () => {
  const [c] = day(1);
  assert.deepEqual(tdx.verifyCapsule(c, registry).errors, []);
  const tampered = structuredClone(c);
  tampered.body.content.assignments[0].text = 'No homework';
  const r = tdx.verifyCapsule(tampered, registry);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /signature does not match/);
});

test('signing key must be known, valid at signed_at and not revoked', () => {
  const [c] = day(1);
  assert.match(tdx.verifyCapsule(c, { keys: [] }).errors.join(), /unknown signing key/);
  const revoked = { keys: [{ ...key.publicEntry, revoked_at: '2026-10-01T00:00:00Z' }] };
  assert.match(tdx.verifyCapsule(c, revoked).errors.join(), /revoked/);
});

test('a full day verifies: contiguous sequence, linked hashes', () => {
  const r = tdx.verifyDay(day(5), registry);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.days[0].count, 5);
  assert.equal(r.days[0].effective.length, 5);
});

test('removing a record from the middle of a day is detected', () => {
  const d = day(4);
  const r = tdx.verifyDay([d[0], d[1], d[3]], registry);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /gap or duplicate|chain broken/);
});

test('an amendment is a new capsule; the original stays and is superseded', () => {
  const d = day(2);
  const fix = tdx.amend(d[0], { content: { assignments: [{ text: 'Ex 3.3 Q1-5' }] } },
    { key, prev: d[1], reason: 'Corrected exercise number', amendedFields: ['content.assignments'], amenderRef: 'e_001', signedAt: '2026-10-28T06:00:00Z' });
  const all = [...d, fix];
  const r = tdx.verifyDay(all, registry);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(fix.body.entry_id, d[0].body.entry_id);
  assert.deepEqual(new Set(r.days[0].effective), new Set([d[1].capsule_id, fix.capsule_id]));
  assert.equal(tdx.verifyCapsule(d[0], registry).ok, true);   // original untouched
});

test('daily seal: merkle root, inclusion proof, signature', () => {
  const d = day(5);
  const hashes = d.map(tdx.capsuleHash);
  const seal = tdx.sealDay({ scope: tdx.chainScope(d[0]), hashes, key, sealedAt: '2026-10-28T15:00:00Z' });
  assert.equal(tdx.verifySeal(seal, registry, hashes).ok, true);
  const proof = tdx.merkleProof(hashes, 3);
  assert.equal(tdx.verifyProof(hashes[3], proof, seal.merkle_root), true);
  assert.equal(tdx.verifyProof(tdx.sha256('forged'), proof, seal.merkle_root), false);
  assert.equal(tdx.verifySeal(seal, registry, hashes.slice(0, 4)).ok, false);
});

test('drafts carry no chain and are not part of the audit chain', () => {
  const dr = tdx.draft(body());
  assert.equal(dr.body.lifecycle.state, 'draft');
  assert.equal(tdx.verifyCapsule(dr, registry).ok, true);
  assert.equal(tdx.verifyDay([dr], registry).days.length, 0);
});
