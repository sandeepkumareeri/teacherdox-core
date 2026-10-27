'use strict';
// Hashing, ids and Ed25519 keys for .tdx, using only node:crypto.

const crypto = require('node:crypto');

const b64url = buf => Buffer.from(buf).toString('base64url');
const fromB64url = s => Buffer.from(String(s), 'base64url');

/** "sha256:<hex>" of a string or bytes. */
function sha256(data) {
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

/** UUIDv7 (RFC 9562): 48-bit Unix ms timestamp + random — time-ordered. */
function uuidv7(now = Date.now()) {
  const b = crypto.randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;   // version 7
  b[8] = (b[8] & 0x3f) | 0x80;   // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Milliseconds encoded in a UUIDv7. */
function uuidv7Time(id) {
  return Number(BigInt('0x' + String(id).replace(/-/g, '').slice(0, 12)));
}

/**
 * New Ed25519 signing key. Returns the private key (keep secret) and the public
 * JWK-style entry for the key registry.
 */
function generateKey(keyId, { validFrom = new Date().toISOString(), validTo = null } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicEntry: { kid: keyId, kty: 'OKP', crv: 'Ed25519', x: jwk.x, alg: 'ed25519', valid_from: validFrom, valid_to: validTo, revoked_at: null },
  };
}

function signBytes(privateKeyPem, bytes) {
  return b64url(crypto.sign(null, Buffer.from(bytes), crypto.createPrivateKey(privateKeyPem)));
}

function verifyBytes(publicEntry, bytes, sig) {
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicEntry.x }, format: 'jwk' });
  try { return crypto.verify(null, Buffer.from(bytes), key, fromB64url(sig)); } catch { return false; }
}

module.exports = { sha256, uuidv7, uuidv7Time, generateKey, signBytes, verifyBytes, b64url, fromB64url };
