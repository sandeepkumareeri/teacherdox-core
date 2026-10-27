'use strict';
// Daily seal (RFC-002 §7): a signed Merkle root over a day's capsule hashes, so an
// auditor can prove one record belongs to the day without replaying the chain.

const crypto = require('node:crypto');
const { canonicalize } = require('./canonical');
const { signBytes, verifyBytes } = require('./crypto');

const h = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest();
const leaf = hashStr => h([0x00], hashStr);              // domain-separated leaf/node hashing
const node = (a, b) => h([0x01], a, b);

/** Merkle root (hex) over capsule hashes in sequence order. */
function merkleRoot(hashes) {
  if (!hashes.length) return null;
  let level = hashes.map(leaf);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? node(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0].toString('hex');
}

/** Inclusion proof for the record at `index`: sibling hashes from leaf to root. */
function merkleProof(hashes, index) {
  let level = hashes.map(leaf), i = index;
  const proof = [];
  while (level.length > 1) {
    const sib = i ^ 1;
    if (sib < level.length) proof.push({ side: sib < i ? 'left' : 'right', hash: level[sib].toString('hex') });
    const next = [];
    for (let k = 0; k < level.length; k += 2) next.push(k + 1 < level.length ? node(level[k], level[k + 1]) : level[k]);
    level = next; i = Math.floor(i / 2);
  }
  return proof;
}

function verifyProof(hashStr, proof, root) {
  let acc = leaf(hashStr);
  for (const p of proof) acc = p.side === 'left' ? node(Buffer.from(p.hash, 'hex'), acc) : node(acc, Buffer.from(p.hash, 'hex'));
  return acc.toString('hex') === root;
}

/** A signed seal for one educator-day. */
function sealDay({ scope, hashes, key, sealedAt = new Date().toISOString() }) {
  const seal = { type: 'tdx-day-seal', scope, count: hashes.length, merkle_root: merkleRoot(hashes), sealed_at: sealedAt };
  return { ...seal, signature: { alg: 'ed25519', key_id: key.keyId, sig: signBytes(key.privateKeyPem, canonicalize(seal)) } };
}

function verifySeal(seal, registry, hashes) {
  const { signature, ...body } = seal;
  const key = (registry?.keys || []).find(k => k.kid === signature?.key_id);
  const errors = [];
  if (!key) errors.push('unknown seal key');
  else {
    const at = Date.parse(body.sealed_at);
    if (Number.isFinite(at)) {
      if (key.valid_from && at < Date.parse(key.valid_from)) errors.push(`key ${key.kid} not yet valid at signed_at`);
      if (key.valid_to && at > Date.parse(key.valid_to)) errors.push(`key ${key.kid} expired before signed_at`);
      if (key.revoked_at && at >= Date.parse(key.revoked_at)) errors.push(`key ${key.kid} was revoked before signed_at`);
    }
    if (!verifyBytes(key, canonicalize(body), signature.sig)) errors.push('seal signature invalid');
  }
  if (hashes && merkleRoot(hashes) !== seal.merkle_root) errors.push('merkle root does not match the records');
  return { ok: errors.length === 0, errors };
}

module.exports = { merkleRoot, merkleProof, verifyProof, sealDay, verifySeal };
