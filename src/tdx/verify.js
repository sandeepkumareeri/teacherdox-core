'use strict';
// Independent verification of .tdx capsules and an educator's day (RFC-002 §10,
// generalised to .tdx 2.0). Needs only the capsules and the published key registry
// — never access to TeacherDox systems.
//
//   registry = { keys: [{ kid, kty:'OKP', crv:'Ed25519', x, valid_from, valid_to, revoked_at }] }

const { FORMAT, LOCKED, signingInput, capsuleHash, chainScope } = require('./capsule');
const { verifyBytes, uuidv7Time } = require('./crypto');
const { validateCapsule } = require('./schema');

const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

/** Structural + cryptographic check of one capsule. → { ok, hash, errors[] } */
function verifyCapsule(env, registry) {
  const errors = [];
  if (!env || typeof env !== 'object') return { ok: false, hash: null, errors: ['not an object'] };
  if (env.format !== FORMAT) errors.push(`format must be "${FORMAT}"`);
  errors.push(...validateCapsule(env).errors.map(e => `schema ${e}`));   // structure: spec/schema/tdx-2.0.schema.json

  const state = get(env.body, 'lifecycle.state');
  if (LOCKED.has(state)) {
    const s = env.signature;
    if (!s) errors.push('locked capsule has no signature');
    else {
      const key = (registry?.keys || []).find(k => k.kid === s.key_id);
      if (!key) errors.push(`unknown signing key ${s.key_id}`);
      else {
        if (s.alg !== 'ed25519' || key.crv !== 'Ed25519') errors.push(`unsupported algorithm ${s.alg}`);
        const at = Date.parse(s.signed_at);
        if (!Number.isFinite(at)) errors.push('signed_at is not a timestamp');
        else {
          if (key.valid_from && at < Date.parse(key.valid_from)) errors.push(`key ${key.kid} not yet valid at signed_at`);
          if (key.valid_to && at > Date.parse(key.valid_to)) errors.push(`key ${key.kid} expired before signed_at`);
          if (key.revoked_at && at >= Date.parse(key.revoked_at)) errors.push(`key ${key.kid} was revoked before signed_at`);
        }
        if (!verifyBytes(key, signingInput(env), s.sig)) errors.push('signature does not match content (capsule altered or wrong key)');
      }
    }
    if (!env.body.chain || !Number.isInteger(env.body.chain.sequence_index)) errors.push('locked capsule has no chain position');
    if (!env.body.attestation) errors.push('locked capsule has no attestation');
  } else if (state !== 'draft' && state !== 'held') {
    errors.push(`unknown lifecycle state ${state}`);
  }
  let hash = null;
  try { hash = capsuleHash(env); } catch (e) { errors.push(`cannot hash: ${e.message}`); }
  return { ok: errors.length === 0, hash, errors };
}

/**
 * Verify every locked capsule of one or more educator-days: signatures, chain
 * contiguity and links, amendments, and the effective record per entry.
 * → { ok, days: [{ scope, ok, count, errors[], effective: [capsule_id] }], errors[] }
 */
function verifyDay(capsules, registry) {
  const errors = [];
  const byScope = new Map();
  const byId = new Map();
  for (const c of capsules) {
    const r = verifyCapsule(c, registry);
    if (!r.ok) { errors.push(`${c?.capsule_id}: ${r.errors.join('; ')}`); continue; }
    if (!LOCKED.has(c.body.lifecycle.state)) continue;            // drafts are not part of the audit chain
    byId.set(c.capsule_id, { c, hash: r.hash });
    const s = chainScope(c);
    if (!byScope.has(s)) byScope.set(s, []);
    byScope.get(s).push(c);
  }

  const days = [];
  for (const [scope, list] of byScope) {
    const e = [];
    list.sort((a, b) => a.body.chain.sequence_index - b.body.chain.sequence_index);
    list.forEach((c, i) => {
      const { sequence_index, prev_hash } = c.body.chain;
      if (sequence_index !== i) e.push(`gap or duplicate in sequence at index ${i} (found ${sequence_index}) — a record is missing or inserted`);
      if (i === 0 && prev_hash !== null) e.push('first record of the day must have prev_hash = null');
      if (i > 0 && prev_hash !== byId.get(list[i - 1].capsule_id).hash) e.push(`record ${sequence_index} does not link to record ${sequence_index - 1} — chain broken`);
      const a = c.body.amendment;
      if (a) {
        const orig = byId.get(a.amends_capsule_id);
        if (!orig) e.push(`record ${sequence_index} amends an unknown capsule ${a.amends_capsule_id}`);
        else {
          if (orig.hash !== a.amends_capsule_hash) e.push(`record ${sequence_index}: amended capsule hash mismatch`);
          if (orig.c.body.entry_id !== c.body.entry_id) e.push(`record ${sequence_index}: amendment changes entry_id`);
          if (uuidv7Time(orig.c.capsule_id) > uuidv7Time(c.capsule_id)) e.push(`record ${sequence_index}: amends a later capsule`);
        }
      }
    });
    days.push({ scope, ok: e.length === 0, count: list.length, errors: e, effective: effectiveIds(list) });
    errors.push(...e.map(x => `${scope}: ${x}`));
  }
  return { ok: errors.length === 0, days, errors };
}

/** One effective capsule per entry_id: the newest that no other capsule amends. */
function effectiveIds(list) {
  const amended = new Set(list.map(c => c.body.amendment?.amends_capsule_id).filter(Boolean));
  const byEntry = new Map();
  for (const c of list) {
    if (amended.has(c.capsule_id)) continue;
    const cur = byEntry.get(c.body.entry_id);
    if (!cur || c.body.chain.sequence_index > cur.body.chain.sequence_index) byEntry.set(c.body.entry_id, c);
  }
  return [...byEntry.values()].map(c => c.capsule_id);
}

module.exports = { verifyCapsule, verifyDay, effectiveIds };
