'use strict';
// Shared JSDoc types for the trust layer (checked by `npm run typecheck`). No runtime code.
//
// A capsule body is described normatively by spec/schema/tdx-2.0.schema.json and checked at
// runtime by schema.js, so it is typed loosely here.

/** @typedef {Record<string, any>} CapsuleBody */
/** @typedef {{ alg: 'ed25519', key_id: string, signed_at: string, sig: string }} Signature */
/**
 * @typedef {object} Capsule  A .tdx envelope: signed body plus (once locked) its signature.
 * @property {string} format         always "tdx"
 * @property {string} spec_version
 * @property {string} capsule_id     UUIDv7
 * @property {CapsuleBody} body
 * @property {Signature} [signature]
 */
/** @typedef {{ keyId: string, privateKeyPem: string }} SigningKey  private part — never published */
/**
 * @typedef {object} PublicKeyEntry  one entry of a published key registry (JWK-style)
 * @property {string} kid
 * @property {string} kty
 * @property {string} crv
 * @property {string} x               base64url Ed25519 public key
 * @property {string} [alg]
 * @property {string|null} [valid_from]
 * @property {string|null} [valid_to]
 * @property {string|null} [revoked_at]
 */
/** @typedef {{ keyId: string, privateKeyPem: string, publicEntry: PublicKeyEntry }} GeneratedKey */
/** @typedef {{ keys: PublicKeyEntry[] }} KeyRegistry */
/** @typedef {{ ok: boolean, errors: string[] }} CheckResult */
/** @typedef {{ side: 'left' | 'right', hash: string }} ProofStep */
/**
 * @typedef {object} DaySeal  signed Merkle root over one educator-day
 * @property {'tdx-day-seal'} type
 * @property {string} scope
 * @property {number} count
 * @property {string|null} merkle_root
 * @property {string} sealed_at
 * @property {{ alg: 'ed25519', key_id: string, sig: string }} signature
 */
/** @typedef {{ type: 'capsule' | 'day_seal', id: string, hash: string }} CountersignTarget */
/**
 * @typedef {object} Countersignature
 * @property {'tdx-countersignature'} type
 * @property {CountersignTarget} target
 * @property {string} approver_ref
 * @property {string} role
 * @property {'approved' | 'returned'} decision
 * @property {string|null} note
 * @property {string} signed_at
 * @property {{ alg: 'ed25519', key_id: string, sig: string }} signature
 */

module.exports = {};
