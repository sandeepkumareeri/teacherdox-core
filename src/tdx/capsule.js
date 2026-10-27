'use strict';
// Building, locking and amending .tdx 2.0 capsules (envelope + signed body).
// Rules: tdx-2.0.md §1 (envelope, signing input, capsule hash) and RFC-002
// (lifecycle, chain, amendments). Signed capsules are never modified: every
// function here returns a new object.

const { canonicalize } = require('./canonical');
const { sha256, uuidv7, signBytes } = require('./crypto');

const FORMAT = 'tdx';
const SPEC_VERSION = '2.0.0';
const LOCKED = new Set(['auto_locked', 'confirmed_locked']);
const STATES = new Set(['draft', 'held', 'auto_locked', 'confirmed_locked']);

const clone = o => JSON.parse(JSON.stringify(o));

/** Bytes that a signature covers: JCS({format, spec_version, capsule_id, body}). */
function signingInput(envelope) {
  const { format, spec_version, capsule_id, body } = envelope;
  return canonicalize({ format, spec_version, capsule_id, body });
}

/** sha256 over the JCS form of the full signed envelope (signature included). */
function capsuleHash(envelope) {
  return sha256(canonicalize(envelope));
}

/** A new draft capsule. `body` must carry tenant, actor, session…; entry_id is created if absent. */
function draft(body, { capsuleId = uuidv7() } = {}) {
  const b = clone(body);
  b.entry_id = b.entry_id || uuidv7();
  b.lifecycle = { state: 'draft' };
  b.chain = null;
  return { format: FORMAT, spec_version: SPEC_VERSION, capsule_id: capsuleId, body: b };
}

/** Attach a signature (returns a new envelope). key: { keyId, privateKeyPem }. */
function sign(envelope, key, signedAt = new Date().toISOString()) {
  const env = clone(envelope);
  delete env.signature;
  env.signature = { alg: 'ed25519', key_id: key.keyId, signed_at: signedAt, sig: signBytes(key.privateKeyPem, signingInput(env)) };
  return env;
}

/**
 * Lock a draft into its terminal, signed form and append it to the educator's day chain.
 *   prev:        the latest locked capsule in the same chain scope, or null for the first of the day
 *   state:       'auto_locked' (machine-attested) or 'confirmed_locked' (human-attested)
 *   attestation: RFC-002 §9 block (policy, auto-accepted / confirmed fields, confirmation receipt)
 */
function lock(draftEnvelope, { key, prev = null, state = 'auto_locked', attestation = {}, signedAt, capsuleId = uuidv7() }) {
  if (!LOCKED.has(state)) throw new Error(`tdx/lock: state must be auto_locked or confirmed_locked, not ${state}`);
  if (prev && chainScope(prev) !== chainScope(draftEnvelope)) throw new Error('tdx/lock: prev capsule belongs to a different chain (tenant, educator, date)');
  const env = { format: FORMAT, spec_version: SPEC_VERSION, capsule_id: capsuleId, body: clone(draftEnvelope.body) };
  env.body.lifecycle = { state };
  env.body.attestation = { statement_ref: 'tdx:attestation/reasonable-representation/1.0', mode: state === 'auto_locked' ? 'machine' : 'human', ...attestation };
  env.body.chain = prev
    ? { sequence_index: prev.body.chain.sequence_index + 1, prev_hash: capsuleHash(prev) }
    : { sequence_index: 0, prev_hash: null };
  return sign(env, key, signedAt);
}

/**
 * A correction: a new locked capsule with the same entry_id, pointing at the capsule it amends,
 * appended to the chain like any other locked capsule (RFC-002 §7, §8).
 */
function amend(original, changes, { key, prev, reason, amendedFields = [], amenderRef, state = 'confirmed_locked', attestation = {}, signedAt, capsuleId }) {
  if (!LOCKED.has(original.body?.lifecycle?.state)) throw new Error('tdx/amend: only locked capsules can be amended');
  const body = deepMerge(clone(original.body), changes);
  body.amendment = { amends_capsule_id: original.capsule_id, amends_capsule_hash: capsuleHash(original), reason, amended_fields: amendedFields, amender_ref: amenderRef };
  return lock({ body }, { key, prev, state, attestation, signedAt, ...(capsuleId ? { capsuleId } : {}) });
}

/** Chain scope: one chain per (tenant, educator, local session date). */
function chainScope(envelope) {
  const b = envelope.body || {};
  return [b.tenant, b.actor?.educator_ref, b.session?.date].join('|');
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

module.exports = { FORMAT, SPEC_VERSION, STATES, LOCKED, draft, sign, lock, amend, signingInput, capsuleHash, chainScope };
