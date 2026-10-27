'use strict';
// JSON Canonicalization Scheme (RFC 8785) — the one byte form every .tdx signature
// and hash is computed over.
//
// - Object keys sorted by UTF-16 code units (JS default string comparison).
// - No insignificant whitespace.
// - Strings and numbers serialised exactly as ECMAScript's JSON.stringify does
//   (RFC 8785 adopts ECMAScript number-to-string and string escaping).
// - `undefined` members are dropped (as JSON.stringify does); non-finite numbers,
//   functions, symbols and BigInt are rejected — they have no canonical form.

function canonicalize(value) {
  return serialize(value, new Set());
}

function serialize(v, seen) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('tdx/canonical: non-finite number has no canonical form');
      return JSON.stringify(v);   // ECMAScript Number::toString, as RFC 8785 requires; -0 → "0"
    case 'object': break;
    default: throw new TypeError(`tdx/canonical: cannot canonicalize ${typeof v}`);
  }
  if (seen.has(v)) throw new TypeError('tdx/canonical: circular structure');
  seen.add(v);
  let out;
  if (Array.isArray(v)) {
    out = '[' + v.map(x => serialize(x === undefined ? null : x, seen)).join(',') + ']';
  } else if (typeof v.toJSON === 'function' && !(v instanceof Date)) {
    out = serialize(v.toJSON(), seen);
  } else if (v instanceof Date) {
    out = JSON.stringify(v.toISOString());
  } else {
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    out = '{' + keys.map(k => JSON.stringify(k) + ':' + serialize(v[k], seen)).join(',') + '}';
  }
  seen.delete(v);
  return out;
}

module.exports = { canonicalize };
