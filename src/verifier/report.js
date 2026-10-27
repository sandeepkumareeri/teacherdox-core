'use strict';
// verifyBundle: one call that checks whatever someone hands a verifier — a capsule, a
// list of capsules, a day export with its seal and countersignatures, or a mix — and
// returns one report. It runs on either implementation (reference node:crypto or
// WebCrypto), passed as `impl`; functions may be sync or async.

const isCapsule = x => x && x.format === 'tdx';
const isSeal = x => x && x.type === 'tdx-day-seal';
const isCountersig = x => x && x.type === 'tdx-countersignature';
const isRegistry = x => x && Array.isArray(x.keys) && !x.format;

/** Split any accepted input into capsules, seals, countersignatures and an embedded key registry. */
function collect(input) {
  const out = { capsules: [], seals: [], countersignatures: [], registry: null, unknown: 0 };
  const visit = x => {
    if (Array.isArray(x)) return x.forEach(visit);
    if (!x || typeof x !== 'object') { out.unknown++; return; }
    if (isCapsule(x)) out.capsules.push(x);
    else if (isSeal(x)) out.seals.push(x);
    else if (isCountersig(x)) out.countersignatures.push(x);
    else if (isRegistry(x) && Object.keys(x).length === 1) out.registry = x;
    else {
      let found = false;
      for (const k of ['capsule', 'capsules', 'records', 'seal', 'seals', 'countersignatures']) if (x[k]) { visit(x[k]); found = true; }
      if (isRegistry(x.keys ? { keys: x.keys } : null) && x.keys) { out.registry = { keys: x.keys }; found = true; }
      if (!found) out.unknown++;
    }
  };
  visit(input);
  return out;
}

function summary(c) {
  const b = c.body || {}, s = b.session || {}, p = b.provenance || {};
  return {
    educator_ref: b.actor && b.actor.educator_ref, institution_type: b.actor && b.actor.institution_type,
    date: s.date, kind: s.kind, label: s.label, cohort: s.cohort, subject: s.subject, course: s.course, unit: s.unit,
    title: b.content && b.content.title, assignments: ((b.content && b.content.assignments) || []).map(a => a.text),
    steps: (p.steps || []).map(x => ({ step: x.step, provider: x.provider, model: x.model, status: x.status, ms: x.ms })),
    overall_confidence: p.overall_confidence ?? null,
    amends: b.amendment ? b.amendment.amends_capsule_id : null,
    sample: !!(b.ext && b.ext['org.teacherdox.sample']),
  };
}

/**
 * → { ok, capsules[], days[], countersignatures[], errors[], registry_source }
 * registry: the published key registry to trust. A registry embedded in the input is used
 * only when none is given, and the report says so (an attacker can embed their own keys).
 */
async function verifyBundle(input, registry, impl) {
  const got = collect(input);
  const reg = registry || got.registry || { keys: [] };
  const errors = [];
  if (got.unknown) errors.push(`${got.unknown} item(s) are not .tdx capsules, seals or countersignatures`);
  if (!got.capsules.length && !got.seals.length && !got.countersignatures.length) errors.push('nothing to verify');

  const day = await impl.verifyDay(got.capsules, reg);
  const effective = new Set(day.days.flatMap(d => d.effective));
  const capsules = [];
  const hashById = new Map();
  for (const c of got.capsules) {
    const r = await impl.verifyCapsule(c, reg);
    hashById.set(c.capsule_id, r.hash);
    const state = c.body && c.body.lifecycle && c.body.lifecycle.state;
    capsules.push({ capsule_id: c.capsule_id, entry_id: c.body && c.body.entry_id, state, ok: r.ok, hash: r.hash, errors: r.errors, effective: effective.has(c.capsule_id), summary: summary(c) });
  }

  const days = [];
  for (const d of day.days) {
    const inScope = got.capsules.filter(c => impl.chainScope(c) === d.scope && capsules.find(x => x.capsule_id === c.capsule_id).ok)
      .filter(c => c.body.lifecycle.state !== 'draft' && c.body.lifecycle.state !== 'held')
      .sort((a, b) => a.body.chain.sequence_index - b.body.chain.sequence_index);
    const seal = got.seals.find(s => s.scope === d.scope);
    let sealResult = null;
    if (seal) {
      sealResult = await impl.verifySeal(seal, reg, inScope.map(c => hashById.get(c.capsule_id)));
      if (seal.count !== inScope.length) sealResult = { ok: false, errors: [...sealResult.errors, `seal covers ${seal.count} records, ${inScope.length} given`] };
    }
    days.push({ ...d, seal: sealResult });
    if (sealResult && !sealResult.ok) errors.push(...sealResult.errors.map(e => `${d.scope}: seal: ${e}`));
  }
  for (const s of got.seals) {
    if (!day.days.some(d => d.scope === s.scope)) {
      const r = await impl.verifySeal(s, reg);
      days.push({ scope: s.scope, ok: false, count: 0, errors: ['seal given without the records of its day'], effective: [], seal: r });
    }
  }
  errors.push(...day.errors);

  const countersignatures = [];
  for (const cs of got.countersignatures) {
    const t = cs.target || {};
    const target = t.type === 'capsule' ? got.capsules.find(c => c.capsule_id === t.id) : got.seals.find(s => s.scope === t.id);
    const r = await impl.verifyCountersignature(cs, reg, target);
    const errs = target ? r.errors : [...r.errors, `the ${t.type === 'capsule' ? 'record' : 'day seal'} it countersigns was not provided`];
    countersignatures.push({ target: t, approver_ref: cs.approver_ref, role: cs.role, decision: cs.decision, signed_at: cs.signed_at, ok: r.ok && !!target, errors: errs });
    errors.push(...errs.map(e => `countersignature by ${cs.approver_ref}: ${e}`));
  }

  return {
    ok: errors.length === 0 && capsules.every(c => c.ok),
    registry_source: registry ? 'given' : got.registry ? 'embedded in the input (only as trustworthy as its source)' : 'none',
    capsules, days, countersignatures, errors,
  };
}

/** The reference implementation (node:crypto) in the shape verifyBundle expects. */
function referenceImpl(tdx) {
  return {
    verifyCapsule: tdx.verifyCapsule, verifyDay: tdx.verifyDay, verifySeal: tdx.verifySeal,
    verifyCountersignature: tdx.verifyCountersignature, chainScope: tdx.chainScope,
  };
}

module.exports = { verifyBundle, collect, referenceImpl };
