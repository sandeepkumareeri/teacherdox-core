'use strict';
// Score and route (RFC-002 confidence routing, generalised to .tdx 2.0 §4). Each field
// has a class — critical, material or soft — and a policy sets the confidence each class
// needs before the record may be locked without a human. The result is a routing
// decision for the draft:
//   auto_lock — every field meets its threshold; the host may lock it as auto_locked
//   confirm   — some fields need the educator's confirmation (listed)
//   hold      — not usable as a record without attention (irrelevant evidence, a critical
//               field contradicted or far too unsure)
//
// Base field classes are the spec's (§4); institution and policy packs adjust them.

const BASE_CLASSES = {
  'session.subject': 'critical',
  'session.cohort': 'material', 'session.course': 'material', 'session.unit': 'material', 'session.label': 'material',
  'content.assignments': 'material', 'content.topics': 'material',
  'content.title': 'soft', 'content.summary': 'soft', 'content.method': 'soft', 'content.next': 'soft', 'content.materials': 'soft', 'content.notes': 'soft',
};
// Institution packs promote fields (spec §4: e.g. session.course is critical for
// universities); policy packs set the thresholds. See packs/.
const packs = require('../packs');
const POLICIES = Object.fromEntries(packs.list('policies').map(n => [n, packs.policy(n)]));
const WEIGHT = { critical: 3, material: 2, soft: 1 };

function fieldClasses(institutionType, overrides = {}) {
  return { ...BASE_CLASSES, ...(packs.institution(institutionType)?.promotions || {}), ...overrides };
}

const present = v => Array.isArray(v) ? v.length > 0 : v != null && v !== '';

/**
 * values: { 'session.subject': 'Mathematics', ... } (null/[] when unknown)
 * confidence: { field: 0..1 } (after the check step adjusted it)
 * flags: [{ field, issue }] from the check step
 * → { decision, overall_confidence, auto_accepted_fields, confirm_fields, reasons, policy_profile, policy_version }
 */
function route({ values, confidence, flags = [], relevant = true, usable = true, checkRan = false, lagDays = 0, institutionType, policy = 'school_compliance', classes }) {
  const P = typeof policy === 'string' ? packs.policy(policy) : policy;
  if (!P || !P.min) throw new Error(`unknown policy ${policy}`);
  const cls = classes || fieldClasses(institutionType);
  const auto = [], confirm = [], reasons = [];
  let hold = false, wsum = 0, csum = 0;

  if (!usable) { hold = true; reasons.push('no usable evidence (nothing could be read or heard)'); }
  else if (!relevant) { hold = true; reasons.push('evidence does not describe a teaching session'); }

  for (const [field, c] of Object.entries(cls)) {
    const has = present(values[field]);
    const conf = has ? (confidence[field] ?? 0) : 0;
    if (!has) {
      if (c === 'critical') { confirm.push(field); reasons.push(`${field} is missing`); }
      continue;
    }
    wsum += WEIGHT[c]; csum += WEIGHT[c] * conf;
    const contradicted = flags.some(f => f.field === field && f.issue === 'contradicted');
    if (c === 'critical' && (contradicted || conf < (P.hold_below?.critical ?? 0))) {
      hold = true; confirm.push(field);
      reasons.push(contradicted ? `${field} is contradicted by the evidence` : `${field} confidence ${conf.toFixed(2)} is below the hold line`);
    } else if (contradicted || conf < P.min[c]) {
      confirm.push(field);
      reasons.push(contradicted ? `${field} is contradicted by the evidence` : `${field} confidence ${conf.toFixed(2)} < ${P.min[c]} (${c})`);
    } else {
      auto.push(field);
    }
  }
  if (P.require_check && !checkRan) reasons.push('verification step did not run');
  const late = P.max_capture_lag_days != null && lagDays > P.max_capture_lag_days;
  if (late) reasons.push(`captured ${lagDays} days after the session (policy allows ${P.max_capture_lag_days})`);
  if (P.allow_auto_lock === false) reasons.push('policy requires a person to confirm every record');

  const decision = hold ? 'hold'
    : (confirm.length || (P.require_check && !checkRan) || late || P.allow_auto_lock === false) ? 'confirm' : 'auto_lock';
  return {
    decision,
    late_days: late ? lagDays : 0,
    require_approval: !!P.require_approval,
    overall_confidence: wsum ? Math.round((csum / wsum) * 1000) / 1000 : null,
    policy_profile: P.name || 'custom', policy_version: P.version || '1',
    auto_accepted_fields: auto, confirm_fields: [...new Set(confirm)], reasons,
  };
}

module.exports = { route, fieldClasses, POLICIES, BASE_CLASSES };
