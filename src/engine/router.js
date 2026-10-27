'use strict';
// Capability router. Pipeline steps ask for a capability (segment, transcribe,
// structure, verify), never a model. Providers are tried in priority order; a provider
// is skipped when it does not offer the capability, cannot handle this input (e.g.
// Muse Voice Transcribe has no Malayalam), is not allowed for this educator (consent),
// or has used its daily call budget. Errors and timeouts fall through to the next
// provider. Every call returns a provenance step for the .tdx record.
//
// A provider is { name, capabilities: [...], supports?(capability, input) → true | "reason",
//   async [capability](input, { signal }) → { output, model, usage?: { input, output }, cost_usd? } }

const CAPABILITIES = ['segment', 'transcribe', 'structure', 'check'];

class RouterError extends Error {
  constructor(capability, attempts) {
    super(`no provider could ${capability}: ${attempts.map(a => `${a.provider}: ${a.error}`).join('; ') || 'none configured'}`);
    this.code = 'NO_PROVIDER';
    this.capability = capability;
    this.attempts = attempts;
  }
}

function withTimeout(fn, ms) {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(Object.assign(new Error(`timed out after ${ms} ms`), { code: 'TIMEOUT' })); ac.abort(); }, ms);
  });
  return Promise.race([fn(ac.signal), timeout]).finally(() => clearTimeout(timer));
}

/**
 * options:
 *   providers   — in priority order (Meta first)
 *   timeoutMs   — per call, default 60 s; per capability override: { transcribe: 30000 }
 *   dailyLimit  — { [providerName]: calls per UTC day } — a bug must not burn the credits
 *   now         — clock, for tests
 *   log         — (event) => void; receives { type: 'fallback' | 'call', ... }
 */
function createRouter({ providers = [], timeoutMs = 60000, dailyLimit = {}, now = () => Date.now(), log = () => {} } = {}) {
  const used = new Map();   // `${provider}|${day}` → calls
  const dayKey = () => new Date(now()).toISOString().slice(0, 10);

  function budgetLeft(name) {
    const limit = dailyLimit[name];
    return limit == null || (used.get(`${name}|${dayKey()}`) || 0) < limit;
  }

  /**
   * Run one capability. opts.allow: provider names this call may use (consent / privacy);
   * opts.step: pipeline step name for provenance. → { output, step }
   */
  async function run(capability, input, { allow, step, evidence } = {}) {
    if (!CAPABILITIES.includes(capability)) throw new Error(`unknown capability ${capability}`);
    const attempts = [];
    for (const p of providers) {
      if (!p.capabilities.includes(capability)) continue;
      if (allow && !allow.includes(p.name)) { attempts.push({ provider: p.name, error: 'not allowed for this educator' }); continue; }
      const ok = p.supports ? p.supports(capability, input) : true;
      if (ok !== true) { attempts.push({ provider: p.name, error: typeof ok === 'string' ? ok : 'input not supported' }); continue; }
      if (!budgetLeft(p.name)) { attempts.push({ provider: p.name, error: 'daily limit reached' }); continue; }

      const key = `${p.name}|${dayKey()}`;
      used.set(key, (used.get(key) || 0) + 1);
      const t0 = now();
      const ms = typeof timeoutMs === 'object' ? (timeoutMs[capability] ?? timeoutMs.default ?? 60000) : timeoutMs;
      try {
        const r = await withTimeout(signal => p[capability](input, { signal }), ms);
        const elapsed = Math.max(0, Math.round(now() - t0));
        const real = attempts.filter(a => !/not allowed/.test(a.error));
        const s = {
          step, capability, provider: p.name, model: r.model ?? null,
          status: real.length ? 'fallback' : 'ok',
          ms: elapsed, cost_usd: r.cost_usd ?? null,
          tokens: r.usage ? { input: r.usage.input ?? 0, output: r.usage.output ?? 0 } : null,
          ...(evidence ? { evidence } : {}),
          ...(attempts.length ? { attempts } : {}),
        };
        if (real.length) log({ type: 'fallback', capability, step, used: p.name, attempts });
        log({ type: 'call', ...s });
        return { output: r.output, step: s };
      } catch (e) {
        attempts.push({ provider: p.name, model: e.model ?? null, error: String(e.message || e).slice(0, 300) });
      }
    }
    throw new RouterError(capability, attempts);
  }

  return { run, providers, usage: () => Object.fromEntries(used) };
}

module.exports = { createRouter, RouterError, CAPABILITIES };
