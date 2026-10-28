'use strict';
// Countersignatures (RFC-002 approval, generalised): an approver — headmaster, head of
// department, supervisor — attests a locked record or a whole sealed day. Signed
// capsules are immutable, so the countersignature is its own small signed statement that
// points at the target by hash; it never changes the capsule.
//
//   { type: 'tdx-countersignature', target: { type: 'capsule' | 'day_seal', id, hash },
//     approver_ref, role, decision: 'approved' | 'returned', note, signed_at,
//     signature: { alg: 'ed25519', key_id, sig } }

const { canonicalize } = require('./canonical');
const { sha256, signBytes, verifyBytes } = require('./crypto');
const { LOCKED, capsuleHash } = require('./capsule');

const DECISIONS = new Set(['approved', 'returned']);

/**
 * Hash and id of what is being countersigned: a locked capsule or a day seal.
 * @param {any} x
 * @returns {import('./types').CountersignTarget}
 */
function targetOf(x) {
  if (x?.type === 'tdx-day-seal') return { type: 'day_seal', id: x.scope, hash: sha256(canonicalize(x)) };
  if (x?.format === 'tdx') {
    if (!LOCKED.has(x.body?.lifecycle?.state)) throw new Error('tdx/countersign: only locked capsules can be countersigned');
    return { type: 'capsule', id: x.capsule_id, hash: capsuleHash(x) };
  }
  throw new Error('tdx/countersign: target must be a locked capsule or a day seal');
}

/**
 * An approver's signed statement about a locked capsule or a day seal.
 * @param {import('./types').Capsule | import('./types').DaySeal} target
 * @param {{ key: import('./types').SigningKey, approverRef: string, role: string, decision?: 'approved' | 'returned', note?: string | null, signedAt?: string }} opts
 * @returns {import('./types').Countersignature}
 */
function countersign(target, { key, approverRef, role, decision = 'approved', note = null, signedAt = new Date().toISOString() }) {
  if (!DECISIONS.has(decision)) throw new Error(`tdx/countersign: decision must be approved or returned, not ${decision}`);
  if (!approverRef || !role) throw new Error('tdx/countersign: approverRef and role are required');
  const statement = { type: /** @type {const} */ ('tdx-countersignature'), target: targetOf(target), approver_ref: approverRef, role, decision, note, signed_at: signedAt };
  return { ...statement, signature: { alg: 'ed25519', key_id: key.keyId, sig: signBytes(key.privateKeyPem, canonicalize(statement)) } };
}

/**
 * → { ok, errors[] }. With `target`, also checks the countersignature points at exactly it.
 * @param {any} cs
 * @param {import('./types').KeyRegistry | null | undefined} registry
 * @param {import('./types').Capsule | import('./types').DaySeal} [target]
 * @returns {import('./types').CheckResult}
 */
function verifyCountersignature(cs, registry, target) {
  /** @type {string[]} */
  const errors = [];
  const { signature, ...statement } = cs || {};
  if (statement.type !== 'tdx-countersignature') errors.push('not a countersignature');
  if (!DECISIONS.has(statement.decision)) errors.push(`unknown decision ${statement.decision}`);
  const key = (registry?.keys || []).find(k => k.kid === signature?.key_id);
  if (!key) errors.push(`unknown signing key ${signature?.key_id}`);
  else {
    const at = Date.parse(statement.signed_at);
    if (!Number.isFinite(at)) errors.push('signed_at is not a timestamp');
    else {
      if (key.valid_from && at < Date.parse(key.valid_from)) errors.push(`key ${key.kid} not yet valid at signed_at`);
      if (key.valid_to && at > Date.parse(key.valid_to)) errors.push(`key ${key.kid} expired before signed_at`);
      if (key.revoked_at && at >= Date.parse(key.revoked_at)) errors.push(`key ${key.kid} was revoked before signed_at`);
    }
    if (!verifyBytes(key, canonicalize(statement), signature.sig)) errors.push('countersignature does not match its statement');
  }
  if (target) {
    let t = null;
    try { t = targetOf(target); } catch (e) { errors.push(/** @type {Error} */ (e).message); }
    if (t && (t.hash !== statement.target?.hash || t.type !== statement.target?.type)) errors.push('countersignature is for a different record');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { countersign, verifyCountersignature, countersignTarget: targetOf };
