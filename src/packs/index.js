'use strict';
// Packs: configuration that makes the core work for a new language, kind of
// institution, country or trust profile without code (CORE-00 §4.4).
//
//   packs/locales/<bcp47>.json      educator-facing messages and terms
//   packs/institutions/<type>.json  session kinds, field vocabulary, field-class promotions, approver
//   packs/countries/<iso>.json      time zones, locales, record language, approver hierarchy, calendar
//   packs/policies/<profile>.json   confidence thresholds, steps, capture lag, signing rules
//
// Packs are plain JSON read from disk (or another directory via createPacks({ dir })).

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(__dirname, '../../packs');
const KINDS = ['locales', 'institutions', 'countries', 'policies'];

function createPacks({ dir = DEFAULT_DIR } = {}) {
  const cache = new Map();

  function list(kind) {
    if (!KINDS.includes(kind)) throw new Error(`packs: unknown kind ${kind}`);
    try { return fs.readdirSync(path.join(dir, kind)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); } catch { return []; }
  }

  function load(kind, id) {
    const key = `${kind}/${id}`;
    if (!cache.has(key)) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(id))) { cache.set(key, null); return null; }
      const file = path.join(dir, kind, `${id}.json`);
      cache.set(key, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
    }
    return cache.get(key);
  }

  /** Locale fallback: exact (pt-BR) → primary (pt) → any regional variant (pt-*) → en. */
  function locale(tag = 'en') {
    const t = String(tag || 'en');
    const primary = t.split('-')[0].toLowerCase();
    const exact = list('locales').find(id => id.toLowerCase() === t.toLowerCase());
    const id = exact || list('locales').find(x => x.toLowerCase() === primary) || list('locales').find(x => x.toLowerCase().startsWith(primary + '-')) || 'en';
    return load('locales', id);
  }

  const institution = type => load('institutions', type) || load('institutions', 'independent');
  const country = iso => (iso ? load('countries', String(iso).toUpperCase()) : null);
  function policy(name) {
    const p = load('policies', name);
    if (!p) throw new Error(`packs: unknown policy ${name}`);
    return { name: p.profile, ...p };
  }

  /** Message or term in a locale, with {placeholders} and plural forms (vars.n). Falls back to en, then the key. */
  function t(tag, key, vars = {}) {
    const chain = [locale(tag), load('locales', 'en')];
    let v, used;
    for (const L of chain) {
      v = L?.messages?.[key] ?? L?.terms?.[key];
      if (v != null) { used = L; break; }
    }
    if (v == null) return key;
    if (typeof v === 'object') {
      const cat = Number.isFinite(vars.n) ? new Intl.PluralRules(used.locale).select(vars.n) : 'other';
      v = v[cat] ?? v.other;
    }
    return String(v).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  }

  /** Educator-facing name of a record field, in their language and their institution's vocabulary. */
  function fieldLabel(field, { locale: tag, institution_type } = {}) {
    const term = institution(institution_type)?.field_terms?.[field] || `field.${field.split('.')[1]}`;
    return t(tag, term);
  }

  /** "subject, class and homework" in the educator's language. */
  function fieldList(fields, opts = {}) {
    const labels = fields.map(f => fieldLabel(f, opts));
    const tag = locale(opts.locale)?.locale || 'en';
    try { return new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' }).format(labels); } catch { return labels.join(', '); }
  }

  /**
   * One short educator-facing message for an engine result (routing + capsule):
   * → { status, line, fields } — status explains what happens next; line names the record.
   */
  function describe({ routing, capsule }, { locale: tag, institution_type } = {}) {
    const b = capsule?.body || {};
    const it = institution_type || b.actor?.institution_type;
    const opts = { locale: tag || b.locale, institution_type: it };
    let status;
    const contradicted = (b.provenance?.flags || []).find(f => f.issue === 'contradicted' && routing.confirm_fields.includes(f.field));
    if (routing.decision === 'hold') {
      if (/no usable evidence/.test(routing.reasons.join(' '))) status = t(opts.locale, 'status.hold.unusable');
      else if (/not describe a teaching session/.test(routing.reasons.join(' '))) status = t(opts.locale, 'status.hold.irrelevant');
      else if (contradicted) status = t(opts.locale, 'status.hold.contradicted', { field: capitalize(fieldLabel(contradicted.field, opts)) });
      else status = t(opts.locale, 'status.confirm', { fields: fieldList(routing.confirm_fields, opts) });
    } else if (routing.decision === 'confirm') {
      status = routing.late_days && !routing.confirm_fields.length
        ? t(opts.locale, 'late', { days: routing.late_days })
        : t(opts.locale, 'status.confirm', { fields: fieldList(routing.confirm_fields, opts) });
    } else status = t(opts.locale, 'status.auto_lock');
    const s = b.session || {};
    const line = [s.label, s.cohort, s.subject || s.course, s.unit].filter(Boolean).join(' · ');
    return { status, line, fields: routing.confirm_fields.map(f => fieldLabel(f, opts)) };
  }

  return { dir, list, load, locale, institution, country, policy, t, fieldLabel, fieldList, describe };
}

const capitalize = s => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

const packs = createPacks();
module.exports = { createPacks, packs, ...packs };
