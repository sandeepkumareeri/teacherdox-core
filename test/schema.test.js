'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tdx = require('../src/tdx');

const key = tdx.generateKey('k_schema', { validFrom: '2026-01-01T00:00:00Z' });
const body = () => ({
  tenant: 't_demo', locale: 'pt-BR', record_locale: 'en', country: 'BR',
  actor: { educator_ref: 'e_042', institution_ref: 'i_007', institution_type: 'university' },
  session: { kind: 'lecture', date: '2026-10-28', starts_at: '2026-10-28T14:00', timezone: 'America/Sao_Paulo', label: 'CS201-L14', subject: 'Computer Science', course: 'CS201 Data Structures', unit: 'Hash tables', duration_min: 90 },
  source: { channel: 'api', capture_methods: ['photo', 'text'], captured_at: '2026-10-28T17:40:00Z', lag_seconds: 600 },
  evidence: [{ id: tdx.sha256('slide'), media_type: 'image/png', bytes: 5, role: 'board' }],
  evidence_findings: [{ evidence: tdx.sha256('slide'), step: 'locate', finding: 'board_region', box: [0.1, 0.1, 0.9, 0.8] }],
  content: { title: 'Open addressing', topics: ['Hashing', 'Probing'], assignments: [{ text: 'Lab 6', due: '2026-11-04' }], next: null },
  provenance: { pipeline_version: 'core-0.1', steps: [{ step: 'read', capability: 'structure', provider: 'meta', model: 'muse-spark-1.3', status: 'ok', ms: 3100, cost_usd: null, tokens: { input: 1600, output: 420 } }],
    fallback_used: false, overall_confidence: 0.9, field_confidence: { 'session.subject': 0.95 } },
});

test('drafts, locked capsules and amendments match the normative schema', () => {
  const d = tdx.draft(body());
  assert.deepEqual(tdx.validateCapsule(d).errors, []);
  const locked = tdx.lock(d, { key, signedAt: '2026-10-28T18:00:00Z' });
  assert.deepEqual(tdx.validateCapsule(locked).errors, []);
  const fix = tdx.amend(locked, { content: { next: 'Cuckoo hashing' } }, { key, prev: locked, reason: 'typo', amenderRef: 'e_042', signedAt: '2026-10-28T19:00:00Z' });
  assert.deepEqual(tdx.validateCapsule(fix).errors, []);
});

test('schema rejects structural errors with readable paths', () => {
  const d = tdx.draft(body());
  d.body.session.timezone = '+05:30';
  d.body.session.kind = 'class';
  d.body.actor.institution_type = 'kindergarten';
  d.body.evidence[0].id = 'md5:abc';
  d.body.provenance.field_confidence['content.title'] = 1.4;
  d.body.content.assignments[0].due = '2026-02-30';
  delete d.body.tenant;
  const { ok, errors } = tdx.validateCapsule(d);
  assert.equal(ok, false);
  for (const p of ['$.body.tenant: required', '$.body.session.timezone', '$.body.session.kind', '$.body.actor.institution_type',
    '$.body.evidence[0].id', "$.body.provenance.field_confidence.content.title: above 1", '$.body.content.assignments[0].due: not a valid date'])
    assert.ok(errors.some(e => e.startsWith(p)), `expected an error at ${p}\n${errors.join('\n')}`);
});

test('a locked capsule must carry signature, chain position and attestation', () => {
  const d = tdx.draft(body());
  const fake = { ...d, body: { ...d.body, lifecycle: { state: 'confirmed_locked' } } };
  const errors = tdx.validateCapsule(fake).errors.join('\n');
  assert.match(errors, /\$\.signature: required/);
  assert.match(errors, /\$\.body\.attestation: required/);
  assert.match(errors, /\$\.body\.chain: expected object/);
});

test('unknown members are allowed (forward compatible within 2.x)', () => {
  const d = tdx.draft({ ...body(), future_field: { x: 1 } });
  d.spec_version = '2.3.0';
  assert.equal(tdx.validateCapsule(d).ok, true);
});

test('verifyCapsule reports schema errors', () => {
  const d = tdx.draft(body());
  d.body.session.date = '28/10/2026';
  assert.match(tdx.verifyCapsule(d, { keys: [] }).errors.join(), /schema \$\.body\.session\.date/);
});
