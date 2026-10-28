'use strict';
// The last steps of docs/how-a-record-is-born.md, reproducible byte for byte:
// the educator confirms the one flagged field of the live draft, the record is locked and
// signed, verified, and the day is sealed. Signs with the PUBLISHED TEST KEY from spec/vectors
// (anyone can sign with it, so it proves nothing about real records); fixed ids and times make
// the output deterministic.
//
//   node docs/examples/confirm-and-sign.js   → writes live-signed.json, live-seal.json, keys.json here
const fs = require('node:fs');
const path = require('node:path');
const tdx = require('../../src/tdx');

const here = f => path.join(__dirname, f);
const TEST_SEED = '7464782d746573742d766563746f72732d6e6f742d666f722d7265616c2d7573';   // spec/vectors/keys.json
const key = tdx.keyFromSeed('tdx-test-2026', TEST_SEED, { validFrom: '2026-01-01T00:00:00Z' });
const registry = { keys: [key.publicEntry] };

const draft = JSON.parse(fs.readFileSync(here('live-draft.json'), 'utf8'));

// The educator answers "Recorded. Please check: subject." with "Mathematics is right".
const signed = tdx.lock(draft, {
  key,
  state: 'confirmed_locked',
  capsuleId: '01a1820b-0000-7000-8000-000000000001',
  signedAt: '2026-10-28T10:31:00Z',
  attestation: {
    policy_profile: draft.body.provenance.routing.policy_profile,
    policy_version: draft.body.provenance.routing.policy_version,
    auto_accepted_fields: draft.body.provenance.routing.auto_accepted_fields,
    confirmed_fields: ['session.subject'],
    edited_fields: [],
    confirmation: { by: 'e_demo', at: '2026-10-28T10:30:41Z', channel: 'whatsapp' },
  },
});
const v = tdx.verifyCapsule(signed, registry);
const hash = tdx.capsuleHash(signed);
const seal = tdx.sealDay({ scope: tdx.chainScope(signed), hashes: [hash], key, sealedAt: '2026-10-28T14:30:00Z' });
const day = tdx.verifyDay([signed], registry);

fs.writeFileSync(here('live-signed.json'), JSON.stringify(signed, null, 2) + '\n');
fs.writeFileSync(here('live-seal.json'), JSON.stringify(seal, null, 2) + '\n');
fs.writeFileSync(here('keys.json'), JSON.stringify(registry, null, 2) + '\n');
console.log(JSON.stringify({ verified: v.ok, capsule_hash: hash, signature: signed.signature, chain: signed.body.chain, day_ok: day.ok, seal_root: seal.merkle_root, seal_ok: tdx.verifySeal(seal, registry, [hash]).ok }, null, 2));
