'use strict';
// Stable verification failure codes (spec §9). Verifier messages are for people and may
// change; these codes are the contract — test vectors and API errors use them.

/** @type {Array<[string, RegExp]>} code → pattern over a verifier message */
const CODES = [
  ['format_invalid', /format must be "tdx"/],
  ['schema_invalid', /^schema |: schema /],
  ['missing_signature', /locked capsule has no signature/],
  ['unknown_key', /unknown signing key|unknown seal key/],
  ['unsupported_algorithm', /unsupported algorithm/],
  ['key_not_yet_valid', /not yet valid at signed_at/],
  ['key_expired', /expired before signed_at/],
  ['key_revoked', /was revoked before signed_at/],
  ['timestamp_invalid', /signed_at is not a timestamp/],
  ['signature_mismatch', /signature does not match content/],
  ['missing_chain_position', /locked capsule has no chain position/],
  ['missing_attestation', /locked capsule has no attestation/],
  ['unknown_state', /unknown lifecycle state/],
  ['sequence_gap', /gap or duplicate in sequence/],
  ['first_prev_hash_not_null', /first record of the day must have prev_hash = null/],
  ['chain_broken', /does not link to record/],
  ['amendment_unknown_target', /amends an unknown capsule/],
  ['amendment_hash_mismatch', /amended capsule hash mismatch/],
  ['amendment_changes_entry', /amendment changes entry_id/],
  ['amendment_order', /amends a later capsule/],
  ['seal_signature_invalid', /seal signature invalid/],
  ['seal_root_mismatch', /merkle root does not match/],
  ['seal_count_mismatch', /seal covers \d+ records/],
  ['seal_without_records', /seal given without the records/],
  ['countersignature_invalid', /countersignature does not match its statement|not a countersignature|unknown decision/],
  ['countersignature_wrong_target', /countersignature is for a different record|target must be a locked capsule or a day seal/],
  ['countersignature_target_missing', /it countersigns was not provided/],
];

/**
 * Sorted, de-duplicated failure codes for a list of verifier messages.
 * @param {readonly string[] | null | undefined} messages
 * @returns {string[]}
 */
function errorCodes(messages) {
  const out = new Set();
  for (const m of messages || []) for (const [code, re] of CODES) if (re.test(m)) out.add(code);
  return [...out].sort();
}

module.exports = { ERROR_CODES: CODES.map(([c]) => c), errorCodes };
