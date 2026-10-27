'use strict';
// A second, independent .tdx verifier built only on WebCrypto (crypto.subtle), so it runs
// unchanged in a browser — the public verifier page — and in Node ≥ 20. It follows the
// same RFC-002 §10 rules as the reference implementation in src/tdx/verify.js; the tests
// check that both give the same verdicts. Everything is async because WebCrypto is.
//
// Only the canonical form and the schema validator are shared with the reference code
// (both are pure JavaScript with no crypto).

const { canonicalize } = require('../tdx/canonical');
const { validateCapsule } = require('../tdx/schema');

const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('WebCrypto is not available');
  return s;
};
const utf8 = s => new TextEncoder().encode(s);
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array(String(h).match(/../g).map(x => parseInt(x, 16)));
function fromB64url(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const LOCKED = new Set(['auto_locked', 'confirmed_locked']);
const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const uuidv7Time = id => parseInt(String(id).replace(/-/g, '').slice(0, 12), 16);
const chainScope = env => { const b = env.body || {}; return [b.tenant, b.actor && b.actor.educator_ref, b.session && b.session.date].join('|'); };

async function sha256(data) {
  return 'sha256:' + hex(await subtle().digest('SHA-256', typeof data === 'string' ? utf8(data) : data));
}
const capsuleHash = env => sha256(canonicalize(env));
const signingInput = env => canonicalize({ format: env.format, spec_version: env.spec_version, capsule_id: env.capsule_id, body: env.body });

async function verifySig(entry, text, sig) {
  try {
    const key = await subtle().importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: entry.x }, { name: 'Ed25519' }, false, ['verify']);
    return await subtle().verify({ name: 'Ed25519' }, key, fromB64url(sig), utf8(text));
  } catch { return false; }
}

function keyTimeErrors(key, signedAt, errors) {
  const at = Date.parse(signedAt);
  if (!Number.isFinite(at)) { errors.push('signed_at is not a timestamp'); return; }
  if (key.valid_from && at < Date.parse(key.valid_from)) errors.push(`key ${key.kid} not yet valid at signed_at`);
  if (key.valid_to && at > Date.parse(key.valid_to)) errors.push(`key ${key.kid} expired before signed_at`);
  if (key.revoked_at && at >= Date.parse(key.revoked_at)) errors.push(`key ${key.kid} was revoked before signed_at`);
}

async function verifyCapsule(env, registry) {
  const errors = [];
  if (!env || typeof env !== 'object') return { ok: false, hash: null, errors: ['not an object'] };
  if (env.format !== 'tdx') errors.push('format must be "tdx"');
  errors.push(...validateCapsule(env).errors.map(e => `schema ${e}`));
  const state = get(env.body, 'lifecycle.state');
  if (LOCKED.has(state)) {
    const s = env.signature;
    if (!s) errors.push('locked capsule has no signature');
    else {
      const key = ((registry && registry.keys) || []).find(k => k.kid === s.key_id);
      if (!key) errors.push(`unknown signing key ${s.key_id}`);
      else {
        if (s.alg !== 'ed25519' || key.crv !== 'Ed25519') errors.push(`unsupported algorithm ${s.alg}`);
        keyTimeErrors(key, s.signed_at, errors);
        if (!(await verifySig(key, signingInput(env), s.sig))) errors.push('signature does not match content (capsule altered or wrong key)');
      }
    }
    if (!env.body.chain || !Number.isInteger(env.body.chain.sequence_index)) errors.push('locked capsule has no chain position');
    if (!env.body.attestation) errors.push('locked capsule has no attestation');
  } else if (state !== 'draft' && state !== 'held') {
    errors.push(`unknown lifecycle state ${state}`);
  }
  let hash = null;
  try { hash = await capsuleHash(env); } catch (e) { errors.push(`cannot hash: ${e.message}`); }
  return { ok: errors.length === 0, hash, errors };
}

async function verifyDay(capsules, registry) {
  const errors = [];
  const byScope = new Map(), byId = new Map();
  for (const c of capsules) {
    const r = await verifyCapsule(c, registry);
    if (!r.ok) { errors.push(`${c && c.capsule_id}: ${r.errors.join('; ')}`); continue; }
    if (!LOCKED.has(c.body.lifecycle.state)) continue;
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

function effectiveIds(list) {
  const amended = new Set(list.map(c => c.body.amendment && c.body.amendment.amends_capsule_id).filter(Boolean));
  const byEntry = new Map();
  for (const c of list) {
    if (amended.has(c.capsule_id)) continue;
    const cur = byEntry.get(c.body.entry_id);
    if (!cur || c.body.chain.sequence_index > cur.body.chain.sequence_index) byEntry.set(c.body.entry_id, c);
  }
  return [...byEntry.values()].map(c => c.capsule_id);
}

// ── Merkle day seal (same domain-separated tree as src/tdx/seal.js) ───────────────
const raw = async bytes => new Uint8Array(await subtle().digest('SHA-256', bytes));
const leaf = h => raw(concat(Uint8Array.of(0), utf8(h)));
const node = (a, b) => raw(concat(Uint8Array.of(1), a, b));

async function merkleRoot(hashes) {
  if (!hashes.length) return null;
  let level = await Promise.all(hashes.map(leaf));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? await node(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return hex(level[0]);
}

async function verifyProof(hashStr, proof, root) {
  let acc = await leaf(hashStr);
  for (const p of proof) acc = p.side === 'left' ? await node(fromHex(p.hash), acc) : await node(acc, fromHex(p.hash));
  return hex(acc) === root;
}

async function verifySeal(seal, registry, hashes) {
  const { signature, ...body } = seal || {};
  const errors = [];
  const key = ((registry && registry.keys) || []).find(k => k.kid === (signature && signature.key_id));
  if (!key) errors.push('unknown seal key');
  else {
    if (Number.isFinite(Date.parse(body.sealed_at))) keyTimeErrors(key, body.sealed_at, errors);
    if (!(await verifySig(key, canonicalize(body), signature.sig))) errors.push('seal signature invalid');
  }
  if (hashes && (await merkleRoot(hashes)) !== body.merkle_root) errors.push('merkle root does not match the records');
  return { ok: errors.length === 0, errors };
}

async function countersignTarget(x) {
  if (x && x.type === 'tdx-day-seal') return { type: 'day_seal', id: x.scope, hash: await sha256(canonicalize(x)) };
  if (x && x.format === 'tdx' && LOCKED.has(get(x, 'body.lifecycle.state'))) return { type: 'capsule', id: x.capsule_id, hash: await capsuleHash(x) };
  return null;
}

async function verifyCountersignature(cs, registry, target) {
  const errors = [];
  const { signature, ...statement } = cs || {};
  if (statement.type !== 'tdx-countersignature') errors.push('not a countersignature');
  if (!['approved', 'returned'].includes(statement.decision)) errors.push(`unknown decision ${statement.decision}`);
  const key = ((registry && registry.keys) || []).find(k => k.kid === (signature && signature.key_id));
  if (!key) errors.push(`unknown signing key ${signature && signature.key_id}`);
  else {
    keyTimeErrors(key, statement.signed_at, errors);
    if (!(await verifySig(key, canonicalize(statement), signature.sig))) errors.push('countersignature does not match its statement');
  }
  if (target) {
    const t = await countersignTarget(target);
    if (!t) errors.push('tdx/countersign: target must be a locked capsule or a day seal');
    else if (t.hash !== (statement.target && statement.target.hash) || t.type !== (statement.target && statement.target.type)) errors.push('countersignature is for a different record');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  sha256, capsuleHash, chainScope, verifyCapsule, verifyDay, effectiveIds,
  merkleRoot, verifyProof, verifySeal, verifyCountersignature, countersignTarget,
};
