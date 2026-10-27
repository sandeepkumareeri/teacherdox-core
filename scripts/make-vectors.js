'use strict';
// Generates the .tdx 2.0 conformance test vectors in spec/vectors/.
//
// Everything is deterministic: the signing key comes from a published seed, ids and times
// are fixed, and Ed25519 signatures are deterministic — so running this again produces
// byte-identical files (test/vectors.test.js checks that, then checks every expectation
// against both verifier implementations).
//
//   node scripts/make-vectors.js           write spec/vectors/*.json
//   require('./scripts/make-vectors').build()   → { 'file.json': text }

const fs = require('node:fs');
const path = require('node:path');
const tdx = require('../src/tdx');

const OUT = path.join(__dirname, '../spec/vectors');
const SEED = '7464782d746573742d766563746f72732d6e6f742d666f722d7265616c2d7573';   // "tdx-test-vectors-not-for-real-us"
const KID = 'tdx-test-2026';
const SIGNED_AT = '2026-10-28T12:00:00Z';
const T0 = Date.parse('2026-10-28T04:00:00Z');

/** Deterministic UUIDv7: fixed millisecond time + counter in the random bits. */
function uuid(n, ms = T0 + n * 1000) {
  const h = ms.toString(16).padStart(12, '0') + '7' + n.toString(16).padStart(3, '0') + '8' + n.toString(16).padStart(15, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function build() {
  const key = tdx.keyFromSeed(KID, SEED, { validFrom: '2026-01-01T00:00:00Z' });
  const pub = key.publicEntry;
  const registries = {
    default: { keys: [pub] },
    empty: { keys: [] },
    revoked: { keys: [{ ...pub, revoked_at: '2026-10-01T00:00:00Z' }] },
    expired: { keys: [{ ...pub, valid_to: '2026-06-30T23:59:59Z' }] },
    future: { keys: [{ ...pub, valid_from: '2027-01-01T00:00:00Z' }] },
  };

  const body = (n, over = {}) => ({
    tenant: 't_vectors', entry_id: uuid(100 + n),
    actor: { educator_ref: 'e_vec_001', institution_ref: 'i_vec_001', institution_type: 'school' },
    locale: 'ml-IN', record_locale: 'en', country: 'IN',
    session: { kind: 'period', date: '2026-10-28', timezone: 'Asia/Kolkata', label: `P${n}`, cohort: '8B', subject: 'Mathematics', unit: 'Fractions' },
    source: { channel: 'whatsapp', capture_methods: ['photo'], captured_at: '2026-10-28T05:00:00Z' },
    evidence: [{ id: tdx.sha256(`synthetic board photo ${n}`), media_type: 'image/jpeg', bytes: 1000 + n, role: 'board' }],
    content: { title: `Lesson ${n}`, topics: ['Fractions'], assignments: [{ text: `Ex 3.${n} Q1-5`, due: null }] },
    provenance: { pipeline_version: 'vectors', steps: [{ step: 'read', capability: 'structure', provider: 'meta', model: 'muse-spark-1.3', status: 'ok', ms: 3000, cost_usd: null }], fallback_used: false, overall_confidence: 0.9, field_confidence: { 'session.subject': 0.95 } },
    ...over,
  });
  const ATT = { policy_profile: 'school_compliance', policy_version: '1', auto_accepted_fields: ['session.subject'] };
  const draft = (n, over) => tdx.draft(body(n, over), { capsuleId: uuid(n) });
  const lock = (n, prev, opts = {}) => tdx.lock(opts.draft || draft(n), { key, prev, state: opts.state || 'auto_locked', attestation: ATT, signedAt: SIGNED_AT, capsuleId: uuid(200 + n) });
  const clone = x => JSON.parse(JSON.stringify(x));

  // A day: three records in chain order.
  const d1 = lock(1, null), d2 = lock(2, d1), d3 = lock(3, d2);
  const fix = tdx.amend(d1, { content: { assignments: [{ text: 'Ex 3.1 Q1-6', due: null }] } },
    { key, prev: d3, reason: 'Homework was Q1-6', amendedFields: ['content.assignments'], amenderRef: 'e_vec_001', signedAt: '2026-10-28T13:00:00Z', capsuleId: uuid(300) });
  const hashes = [d1, d2, d3].map(tdx.capsuleHash);
  const seal = tdx.sealDay({ scope: tdx.chainScope(d1), hashes, key, sealedAt: '2026-10-28T15:00:00Z' });

  // ── canonical form (RFC 8785) ─────────────────────────────────────────────────────
  const canonical = [
    ['key-order', { b: 1, a: 2, c: { z: true, y: null } }],
    ['nested-arrays', { list: [3, 1, [2, { y: 1, x: 2 }]], empty: [], obj: {} }],
    ['numbers', { int: 42, neg: -7, frac: 4.5, small: 0.002, big: 1e30, tiny: 1e-7, zero: 0, negzero: -0 }],
    ['strings-escapes', { s: 'line\nbreak\ttab "quote" \\ back', ctl: '\u0001\u001f' }],
    ['unicode', { ml: 'മലയാളം', te: 'తెలుగు', emoji: '😀', euro: '€' }],
    ['key-order-utf16', { '€': 'euro', '\r': 'cr', 'דּ': 'hebrew', '1': 'one', '😀': 'emoji', '\u0080': 'ctl', 'ö': 'o-umlaut' }],
  ].map(([id, input]) => ({ id, input, canonical: tdx.canonicalize(input), sha256: tdx.sha256(tdx.canonicalize(input)) }));

  // ── single capsules ─────────────────────────────────────────────────────────────
  const valid = (id, description, capsule, registry = 'default') => ({
    id, description, registry, capsule,
    expect: { valid: true, codes: [], signing_input: tdx.signingInput(capsule), capsule_hash: tdx.capsuleHash(capsule) },
  });
  const invalid = (id, description, capsule, codes, registry = 'default') => ({ id, description, registry, capsule, expect: { valid: false, codes } });

  const tamperedContent = clone(d2); tamperedContent.body.content.assignments[0].text = 'No homework';
  const tamperedSig = clone(d2); tamperedSig.signature.sig = tamperedSig.signature.sig.slice(0, -2) + (tamperedSig.signature.sig.endsWith('AA') ? 'AQ' : 'AA');
  const unsigned = clone(d2); delete unsigned.signature;
  const badTz = draft(4); badTz.body.session.timezone = '+05:30';
  const badDate = draft(5); badDate.body.session.date = '2026-02-30';
  const wrongFormat = clone(d2); wrongFormat.format = 'tdz';
  const university = lock(9, null, { state: 'confirmed_locked', draft: tdx.draft(body(9, {
    tenant: 't_vectors_br', locale: 'pt-BR', record_locale: 'pt-BR', country: 'BR',
    actor: { educator_ref: 'e_vec_br', institution_ref: 'i_vec_br', institution_type: 'university' },
    session: { kind: 'lecture', date: '2026-10-28', timezone: 'America/Sao_Paulo', label: 'CS201-L14', subject: 'Ciência da Computação', course: 'CS201 Estruturas de Dados', unit: 'Tabelas hash' },
  }), { capsuleId: uuid(9) }) });

  const capsules = [
    valid('draft', 'A draft: no signature, no chain position; structurally valid.', draft(1)),
    valid('auto-locked', 'First locked record of a day (sequence 0, prev_hash null), machine-attested.', d1),
    valid('chained', 'Second record of the same day, linked to the first.', d2),
    valid('amendment', 'A correction: same entry_id as the record it amends, which it names by id and hash.', fix),
    valid('university-lecture', 'A university lecture in Portuguese (America/Sao_Paulo), human-confirmed.', university),
    invalid('content-tampered', 'Homework text changed after signing.', tamperedContent, ['signature_mismatch']),
    invalid('signature-tampered', 'Last signature byte changed.', tamperedSig, ['signature_mismatch']),
    invalid('unknown-key', 'Signed with a key the registry does not list.', d2, ['unknown_key'], 'empty'),
    invalid('key-revoked', 'Signing key revoked before signed_at.', d2, ['key_revoked'], 'revoked'),
    invalid('key-expired', 'Signing key expired before signed_at.', d2, ['key_expired'], 'expired'),
    invalid('key-not-yet-valid', 'Signing key only valid after signed_at.', d2, ['key_not_yet_valid'], 'future'),
    invalid('locked-without-signature', 'Lifecycle says locked but there is no signature.', unsigned, ['missing_signature', 'schema_invalid']),
    invalid('schema-timezone', 'Time zone is an offset, not an IANA name.', badTz, ['schema_invalid']),
    invalid('schema-date', 'Session date does not exist.', badDate, ['schema_invalid']),
    invalid('wrong-format', 'format is not "tdx".', wrongFormat, ['format_invalid', 'schema_invalid', 'signature_mismatch']),
  ];

  // ── days (chain rules) ────────────────────────────────────────────────────────────
  // Crafted, correctly signed capsules that break chain rules:
  const fork = lock(7, d1);                                                     // a second record claiming sequence 1
  const stale = tdx.lock(draft(8), { key, prev: d1, attestation: ATT, signedAt: SIGNED_AT, capsuleId: uuid(208) });   // links to d1 but placed after d2
  const badAmendBody = clone(fix.body); badAmendBody.amendment.amends_capsule_hash = tdx.sha256('not the original');
  const badAmend = tdx.lock({ body: badAmendBody }, { key, prev: d3, attestation: ATT, signedAt: '2026-10-28T13:00:00Z', capsuleId: uuid(301) });
  const otherEntryBody = clone(fix.body); otherEntryBody.entry_id = uuid(999);
  const otherEntry = tdx.lock({ body: otherEntryBody }, { key, prev: d3, attestation: ATT, signedAt: '2026-10-28T13:00:00Z', capsuleId: uuid(302) });
  const ghostBody = clone(fix.body); ghostBody.amendment.amends_capsule_id = uuid(998);
  const ghost = tdx.lock({ body: ghostBody }, { key, prev: d3, attestation: ATT, signedAt: '2026-10-28T13:00:00Z', capsuleId: uuid(303) });

  const day = (id, description, list, expect, registry = 'default') => ({ id, description, registry, capsules: list, expect });
  const days = [
    day('day-valid', 'Three records, contiguous and linked.', [d1, d2, d3], { ok: true, codes: [], effective: [d1, d2, d3].map(c => c.capsule_id) }),
    day('day-unordered-input', 'Same day given out of order: verifiers order by sequence_index.', [d3, d1, d2], { ok: true, codes: [], effective: [d1, d2, d3].map(c => c.capsule_id) }),
    day('day-with-amendment', 'A correction appended to the day; the amended record is superseded.', [d1, d2, d3, fix], { ok: true, codes: [], effective: [d2, d3, fix].map(c => c.capsule_id) }),
    day('day-missing-record', 'The middle record removed.', [d1, d3], { ok: false, codes: ['chain_broken', 'sequence_gap'] }),
    day('day-missing-first', 'The first record removed.', [d2, d3], { ok: false, codes: ['first_prev_hash_not_null', 'sequence_gap'] }),
    day('day-fork', 'Two records claim the same position.', [d1, d2, fork, d3], { ok: false, codes: ['chain_broken', 'sequence_gap'] }),
    day('day-stale-link', 'A record links to an earlier record than its predecessor.', [d1, d2, stale], { ok: false, codes: ['chain_broken', 'sequence_gap'] }),
    day('day-amendment-hash-mismatch', 'A correction names the original by id but with the wrong hash.', [d1, d2, d3, badAmend], { ok: false, codes: ['amendment_hash_mismatch'] }),
    day('day-amendment-changes-entry', 'A correction that moves to another entry_id.', [d1, d2, d3, otherEntry], { ok: false, codes: ['amendment_changes_entry'] }),
    day('day-amendment-unknown', 'A correction of a record that is not in the day.', [d1, d2, d3, ghost], { ok: false, codes: ['amendment_unknown_target'] }),
    day('day-tampered-record', 'One record altered: it fails, and the chain no longer links.', [d1, tamperedContent, d3], { ok: false, codes: ['chain_broken', 'sequence_gap', 'signature_mismatch'] }),
  ];

  // ── Merkle seals and proofs ───────────────────────────────────────────────────────
  const tamperedSeal = { ...clone(seal), count: 4 };
  const merkle = {
    leaf_hashing: 'leaf = sha256(0x00 || utf8(capsule_hash string)); node = sha256(0x01 || left || right); odd node promoted unchanged',
    roots: [1, 2, 3, 5, 7].map(n => {
      const hs = Array.from({ length: n }, (_, i) => tdx.sha256(`leaf ${i}`));
      return { count: n, hashes: hs, root: tdx.merkleRoot(hs), proofs: hs.map((h, i) => ({ index: i, proof: tdx.merkleProof(hs, i) })) };
    }),
    seals: [
      { id: 'seal-valid', registry: 'default', seal, hashes, expect: { ok: true, codes: [] } },
      { id: 'seal-other-records', registry: 'default', seal, hashes: [hashes[0], hashes[1]], expect: { ok: false, codes: ['seal_root_mismatch'] } },
      { id: 'seal-tampered', registry: 'default', seal: tamperedSeal, hashes, expect: { ok: false, codes: ['seal_signature_invalid'] } },
      { id: 'seal-unknown-key', registry: 'empty', seal, hashes, expect: { ok: false, codes: ['unknown_key'] } },
    ],
  };

  // ── countersignatures ─────────────────────────────────────────────────────────────
  const csRecord = tdx.countersign(d2, { key, approverRef: 'e_vec_hm', role: 'headmaster', signedAt: '2026-10-28T16:00:00Z' });
  const csDay = tdx.countersign(seal, { key, approverRef: 'e_vec_hm', role: 'headmaster', note: 'Seen', signedAt: '2026-10-28T16:05:00Z' });
  const csTampered = { ...clone(csRecord), decision: 'returned' };
  const countersignatures = [
    { id: 'countersign-record', registry: 'default', countersignature: csRecord, target: d2, expect: { ok: true, codes: [] } },
    { id: 'countersign-day', registry: 'default', countersignature: csDay, target: seal, expect: { ok: true, codes: [] } },
    { id: 'countersign-wrong-target', registry: 'default', countersignature: csRecord, target: d3, expect: { ok: false, codes: ['countersignature_wrong_target'] } },
    { id: 'countersign-tampered', registry: 'default', countersignature: csTampered, target: d2, expect: { ok: false, codes: ['countersignature_invalid'] } },
    { id: 'countersign-revoked-key', registry: 'revoked', countersignature: csRecord, target: d2, expect: { ok: false, codes: ['key_revoked'] } },
  ];

  const json = x => JSON.stringify(x, null, 2) + '\n';
  return {
    'keys.json': json({
      warning: 'TEST KEY ONLY. The seed is public: anything signed with it proves nothing. Never use it for real records.',
      key_id: KID, seed_hex: SEED, public_key: pub, registries,
    }),
    'canonical.json': json({ description: 'RFC 8785 canonical form. canonical = JCS(input); sha256 over its UTF-8 bytes.', cases: canonical }),
    'capsules.json': json({ description: 'Single capsules: verify against registries[registry] from keys.json. Valid cases give the exact signing input (JCS of format, spec_version, capsule_id, body) and capsule hash (sha256 of JCS of the whole envelope).', cases: capsules }),
    'days.json': json({ description: 'Educator-days: chain rules (contiguous sequence from 0, prev_hash links, amendments). effective = the capsule per entry that no other capsule amends.', cases: days }),
    'merkle.json': json(merkle),
    'countersignatures.json': json({ description: 'Countersignatures of a locked record or a day seal; the target is given beside each.', cases: countersignatures }),
  };
}

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, text] of Object.entries(build())) fs.writeFileSync(path.join(OUT, name), text);
  console.log(`wrote ${Object.keys(build()).length} files to ${path.relative(process.cwd(), OUT)}`);
}

module.exports = { build, SEED, KID };
