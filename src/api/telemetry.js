'use strict';
// Cost and latency telemetry, computed from what the records already carry: every draft
// the Record Engine writes has per-step provenance (provider, model, status, ms, tokens,
// cost). Nothing extra is logged about educators. Capture-to-draft latency and retries
// come from the job queue.
//
// Costs are summed only where the provider's price is known (cost_usd not null); calls
// with an unknown price are counted separately, never estimated.

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const round = (x, d = 6) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

function dist(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, mean: null, p50: null, p95: null, max: null };
  return { n: v.length, mean: Math.round(v.reduce((s, x) => s + x, 0) / v.length), p50: pct(v, 50), p95: pct(v, 95), max: v[v.length - 1] };
}

/**
 * capsules: iterable of capsules (one tenant's); jobs: that tenant's jobs; queue: queue.stats()
 * filter: { from, to (YYYY-MM-DD, session date), educator_ref }
 */
function telemetry({ capsules, jobs = [], queue = null, filter = {} }) {
  const inRange = d => (!filter.from || d >= filter.from) && (!filter.to || d <= filter.to);
  // Each engine run produces exactly one draft; locked copies repeat its provenance, so drafts only.
  const drafts = [...capsules].filter(c => c.body.lifecycle.state === 'draft' && c.body.provenance?.steps
    && inRange(c.body.session.date) && (!filter.educator_ref || c.body.actor.educator_ref === filter.educator_ref));

  const decisions = { auto_lock: 0, confirm: 0, hold: 0 };
  const steps = new Map(), byProvider = {};
  const recordMs = [], recordCost = [], confidence = [];
  let fallbackRecords = 0, unknownCostRecords = 0;

  for (const c of drafts) {
    const p = c.body.provenance;
    if (p.routing?.decision in decisions) decisions[p.routing.decision]++;
    if (p.fallback_used) fallbackRecords++;
    if (Number.isFinite(p.overall_confidence)) confidence.push(p.overall_confidence);
    let ms = 0, cost = 0, unknown = false;
    for (const s of p.steps) {
      const k = `${s.step}|${s.provider}|${s.model || ''}`;
      if (!steps.has(k)) steps.set(k, { step: s.step, provider: s.provider, model: s.model || null, calls: 0, status: {}, ms: [], tokens: { input: 0, output: 0 }, cost_usd: 0, calls_with_unknown_cost: 0 });
      const a = steps.get(k);
      a.calls++;
      a.status[s.status || 'ok'] = (a.status[s.status || 'ok'] || 0) + 1;
      if (Number.isFinite(s.ms)) { a.ms.push(s.ms); ms += s.ms; }
      if (s.tokens) { a.tokens.input += s.tokens.input || 0; a.tokens.output += s.tokens.output || 0; }
      const served = s.status !== 'failed' && s.status !== 'skipped';
      if (served) {
        byProvider[s.provider] = (byProvider[s.provider] || 0) + 1;
        if (s.cost_usd == null) { a.calls_with_unknown_cost++; unknown = true; } else { a.cost_usd += s.cost_usd; cost += s.cost_usd; }
      }
    }
    recordMs.push(ms);
    if (unknown) unknownCostRecords++; else recordCost.push(cost);
  }

  const served = Object.values(byProvider).reduce((s, n) => s + n, 0);
  const tJobs = jobs.filter(j => j.finished_at && j.created_at);
  const done = tJobs.filter(j => j.status === 'done');

  return {
    period: { from: filter.from || null, to: filter.to || null, educator_ref: filter.educator_ref || null },
    records: drafts.length,
    decisions,
    auto_lock_rate: drafts.length ? round(decisions.auto_lock / drafts.length, 3) : null,
    fallback_rate: drafts.length ? round(fallbackRecords / drafts.length, 3) : null,
    overall_confidence_mean: confidence.length ? round(confidence.reduce((s, x) => s + x, 0) / confidence.length, 3) : null,
    providers: Object.fromEntries(Object.entries(byProvider).map(([k, n]) => [k, { steps: n, share: round(n / served, 3) }])),
    steps: [...steps.values()].sort((a, b) => ['locate', 'listen', 'read', 'check'].indexOf(a.step) - ['locate', 'listen', 'read', 'check'].indexOf(b.step) || b.calls - a.calls)
      .map(a => ({ ...a, ms: dist(a.ms), cost_usd: round(a.cost_usd) })),
    per_record: {
      model_ms: dist(recordMs),
      cost_usd: { mean: recordCost.length ? round(recordCost.reduce((s, x) => s + x, 0) / recordCost.length) : null, records_priced: recordCost.length, records_with_unknown_cost: unknownCostRecords },
      cost_usd_known_total: round(recordCost.reduce((s, x) => s + x, 0)),
    },
    capture: {
      jobs: tJobs.length, done: done.length, failed: tJobs.filter(j => j.status === 'failed').length,
      retries: tJobs.reduce((s, j) => s + Math.max(0, (j.attempts || 1) - 1), 0),
      capture_to_draft_ms: dist(done.map(j => Date.parse(j.finished_at) - Date.parse(j.created_at))),
    },
    queue,
  };
}

module.exports = { telemetry, dist };
