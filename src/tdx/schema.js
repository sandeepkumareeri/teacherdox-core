'use strict';
// A light validator for spec/schema/tdx-2.0.schema.json — dependency-free, so any
// consumer can check a capsule's structure without a JSON Schema library.
//
// Supports the JSON Schema 2020-12 keywords the .tdx schema uses: type (incl. arrays
// of types), const, enum, properties, required, additionalProperties, items, minItems,
// maxItems, minLength, maxLength, pattern, minimum, maximum, format (date, date-time),
// $ref (local "#/$defs/…"), allOf, oneOf, if/then/else. Unknown keywords are ignored.

const SCHEMA = require('../../spec/schema/tdx-2.0.schema.json');

const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const isType = (v, t) => t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeOf(v) === t;

const FORMATS = {
  date: s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s),
  'date-time': s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
};

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`tdx/schema: only local $ref supported (${ref})`);
  return ref.slice(2).split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function check(v, s, path, root, errors) {
  if (s === true || s == null) return;
  if (s === false) { errors.push(`${path}: not allowed`); return; }
  if (s.$ref) check(v, resolve(root, s.$ref), path, root, errors);

  if (s.type) {
    const types = [].concat(s.type);
    if (!types.some(t => isType(v, t))) { errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(v)}`); return; }
  }
  if ('const' in s && JSON.stringify(v) !== JSON.stringify(s.const)) errors.push(`${path}: must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some(e => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${path}: must be one of ${s.enum.map(e => JSON.stringify(e)).join(', ')}`);

  if (typeof v === 'string') {
    if (s.minLength != null && [...v].length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength != null && [...v].length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${path}: does not match ${s.pattern}`);
    if (s.format && FORMATS[s.format] && !FORMATS[s.format](v)) errors.push(`${path}: not a valid ${s.format}`);
  }
  if (typeof v === 'number') {
    if (s.minimum != null && v < s.minimum) errors.push(`${path}: below ${s.minimum}`);
    if (s.maximum != null && v > s.maximum) errors.push(`${path}: above ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems != null && v.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => check(x, s.items, `${path}[${i}]`, root, errors));
  }
  if (typeOf(v) === 'object') {
    for (const k of s.required || []) if (!(k in v) || v[k] === undefined) errors.push(`${path}.${k}: required`);
    const props = s.properties || {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      if (k in props) check(x, props[k], `${path}.${k}`, root, errors);
      else if ('additionalProperties' in s) check(x, s.additionalProperties, `${path}.${k}`, root, errors);
    }
  }

  for (const sub of s.allOf || []) check(v, sub, path, root, errors);
  if (s.oneOf) {
    const passing = s.oneOf.filter(sub => { const e = []; check(v, sub, path, root, e); return e.length === 0; }).length;
    if (passing !== 1) errors.push(`${path}: must match exactly one alternative (matched ${passing})`);
  }
  if (s.if) {
    const e = []; check(v, s.if, path, root, e);
    if (e.length === 0) { if (s.then) check(v, s.then, path, root, errors); }
    else if (s.else) check(v, s.else, path, root, errors);
  }
}

/** Validate a value against a schema (default: the .tdx 2.0 capsule schema). → { ok, errors[] } */
function validateSchema(value, schema = SCHEMA, { at = '#' } = {}) {
  const errors = [];
  check(value, at === '#' ? schema : resolve(schema, at), '$', schema, errors);
  return { ok: errors.length === 0, errors };
}

/** Structural check of a capsule against the normative .tdx 2.0 schema. */
const validateCapsule = env => validateSchema(env);

module.exports = { TDX_SCHEMA: SCHEMA, validateSchema, validateCapsule };
