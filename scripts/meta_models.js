'use strict';
// Lists the models the META_API_KEY can see (GET /v1/models, OpenAI-compatible), so a "model_not_found"
// can be told apart from a renamed model or a key without access. Prints ids only.
(async () => {
  const key = process.env.META_API_KEY;
  if (!key) { console.log('::error::META_API_KEY not set'); return; }
  const res = await fetch('https://api.meta.ai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  let ids = null;
  try { ids = (JSON.parse(text).data || []).map(m => m.id); } catch { /* not JSON */ }
  console.log(`::notice title=Meta models visible to this key (HTTP ${res.status})::${ids ? ids.join(', ') || '(none)' : text.slice(0, 500)}`);
})();
