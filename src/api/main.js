'use strict';
// Start the API from environment variables (used by `tdx serve`).
//
//   TDX_API_TOKENS        "token1:tenant1,token2:tenant2" — bearer tokens, one tenant each (required to write)
//   TDX_SIGNING_KEY_FILE  Ed25519 private key PEM (from `tdx keygen`); TDX_SIGNING_KEY_ID its key id
//   TDX_KEY_REGISTRY      published registry JSON (must contain the signing key's public entry)
//   TDX_DATA_DIR          where records are kept (default: memory only)
//   META_API_KEY          Meta Model API key for the Record Engine; TDX_META_DAILY_LIMIT (default 500)
//
// Without a signing key a temporary one is made for this process only — fine for a demo,
// useless for real records (nobody can verify them after a restart).

const fs = require('node:fs');
const tdx = require('../tdx');
const { createRecordEngine } = require('../engine');
const { createStore } = require('./store');
const { createApi } = require('./server');

function config(env = process.env) {
  const tokens = {};
  for (const pair of String(env.TDX_API_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const i = pair.lastIndexOf(':');
    if (i < 1) throw new Error('TDX_API_TOKENS entries must be token:tenant');
    tokens[pair.slice(0, i)] = { tenant: pair.slice(i + 1) };
  }
  let key, registry;
  if (env.TDX_SIGNING_KEY_FILE) {
    if (!env.TDX_SIGNING_KEY_ID || !env.TDX_KEY_REGISTRY) throw new Error('TDX_SIGNING_KEY_FILE needs TDX_SIGNING_KEY_ID and TDX_KEY_REGISTRY');
    key = { keyId: env.TDX_SIGNING_KEY_ID, privateKeyPem: fs.readFileSync(env.TDX_SIGNING_KEY_FILE, 'utf8') };
    registry = JSON.parse(fs.readFileSync(env.TDX_KEY_REGISTRY, 'utf8'));
    if (!registry.keys?.some(k => k.kid === key.keyId)) throw new Error(`key registry has no entry for ${key.keyId}`);
  } else {
    const k = tdx.generateKey(`k_ephemeral_${Date.now()}`);
    key = { keyId: k.keyId, privateKeyPem: k.privateKeyPem };
    registry = { keys: [k.publicEntry] };
    console.warn('tdx serve: no TDX_SIGNING_KEY_FILE — using a temporary signing key; records will not verify after a restart');
  }
  return { tokens, key, registry, dataDir: env.TDX_DATA_DIR || null, metaDailyLimit: Number(env.TDX_META_DAILY_LIMIT || 500) };
}

async function start({ port = 8080, host = '127.0.0.1', env = process.env } = {}) {
  const c = config(env);
  if (!Object.keys(c.tokens).length) console.warn('tdx serve: TDX_API_TOKENS is empty — only the public endpoints (verify, keys) will work');
  const engine = createRecordEngine({ dailyLimit: { meta: c.metaDailyLimit } });
  const api = createApi({
    engine, store: createStore({ dir: c.dataDir }), key: c.key, registry: c.registry, tokens: c.tokens,
    log: e => { if (e.type !== 'request') console.log(JSON.stringify({ at: new Date().toISOString(), ...e })); },
  });
  const server = await api.listen(port, host);
  console.log(`tdx serve: http://${host}:${port}  (verifier: /verify/, health: /v1/health)`);
  return server;
}

module.exports = { start, config };
