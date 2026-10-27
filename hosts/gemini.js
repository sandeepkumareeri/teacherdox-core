'use strict';
// Host-side Gemini `generate(body, opts)` for this repository's own scripts (eval, live runs) —
// the function the Record Engine's `fromGenerate` adapter takes. The core (`src/`) never requires
// this file and never talks to Google: a host passes its own generate function, as the TeacherDox
// product passes its gemini.generate.
//
//   createGeminiGenerate({ apiKey, backend, model, fetch }) → { generate, resolveModel, backend, model(), answeredBy() }
//
// Two backends, the same request body (mirrors the product's gemini.js):
//   studio  — AI Studio Gemini API, generativelanguage.googleapis.com (default)
//   vertex  — Google Cloud Vertex AI in express mode (an API key bound to a Cloud project, so calls
//             are billed to that project), aiplatform.googleapis.com/v1/publishers/google. Vertex
//             requires a role on every content item; it is added here.
// Chosen by `backend`, else the GEMINI_BACKEND environment variable ('vertex' → Vertex, anything
// else → AI Studio).
//
// Model: `model`, else GEMINI_MODEL, else resolveModel() picks the newest stable Flash model from the
// backend's model list. Vertex express mode accepts API keys only on generateContent (its model list
// answers 401), so when no list can be read the product's default alias `gemini-flash-latest` is
// tried with a one-token call (observed 27 Oct: Vertex does not serve that alias → 404); on Vertex,
// set GEMINI_MODEL.

const STUDIO = 'https://generativelanguage.googleapis.com/v1beta';
const VERTEX = 'https://aiplatform.googleapis.com/v1/publishers/google';
const DEFAULT_ALIAS = 'gemini-flash-latest';   // the TeacherDox product's default (its gemini.js)
const VERTEX_LIST = 'https://aiplatform.googleapis.com/v1beta1/publishers/google/models';

const versionOf = n => (n.match(/gemini-(\d+(?:\.\d+)*)/) || [, '0'])[1].split('.').map(Number);
function newerFirst(a, b) {
  const va = versionOf(a), vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) { const d = (vb[i] || 0) - (va[i] || 0); if (d) return d; }
  return 0;
}

/** The best generateContent-capable Flash model in a model list (AI Studio `models` or Vertex `publisherModels`). */
function pickModel(models) {
  const usable = (models || [])
    .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
    .map(m => String(m.name || '').replace(/^(publishers\/google\/)?models\//, ''))
    .filter(n => n.startsWith('gemini-'));
  const tiers = [
    n => /^gemini-[\d.]+-flash$/.test(n),          // stable Flash
    n => /^gemini-[\d.]+-flash-\d{3}$/.test(n),     // pinned Flash (-001)
    n => /^gemini-[\d.]+-flash-lite$/.test(n),     // stable Flash-Lite
  ];
  for (const fits of tiers) {
    const hits = usable.filter(fits).sort(newerFirst);
    if (hits.length) return hits[0];
  }
  return null;
}

function createGeminiGenerate({ apiKey = process.env.GEMINI_API_KEY, backend = process.env.GEMINI_BACKEND, model = process.env.GEMINI_MODEL, fetch = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('createGeminiGenerate: apiKey (GEMINI_API_KEY) required');
  const vertex = String(backend || '').toLowerCase() === 'vertex';
  let current = model ? String(model).replace(/^models\//, '') : null;
  let answered = null;   // modelVersion of the confirming call, when the alias was used

  async function getJson(url, headers = {}) {
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  async function resolveModel() {
    if (current) return current;
    const lists = vertex
      ? [() => getJson(`${VERTEX_LIST}?pageSize=1000&key=${encodeURIComponent(apiKey)}`), () => getJson(`${STUDIO}/models?pageSize=1000`, { 'x-goog-api-key': apiKey })]
      : [() => getJson(`${STUDIO}/models?pageSize=1000`, { 'x-goog-api-key': apiKey })];
    const errors = [];
    for (const list of lists) {
      try {
        const data = await list();
        const pick = pickModel(data.models || data.publisherModels);
        if (pick) return (current = pick);
        errors.push('no stable gemini-*-flash model in the list');
      } catch (e) { errors.push(`model list ${e.message}`); }
    }
    try {
      const r = await post(DEFAULT_ALIAS, { contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }], generationConfig: { maxOutputTokens: 16 } });
      answered = r.modelVersion || null;
      return (current = DEFAULT_ALIAS);
    } catch (e) { errors.push(`${DEFAULT_ALIAS} ${e.message}`); }
    throw new Error(`${errors.join('; ')} — set GEMINI_MODEL`);
  }

  async function post(name, body, signal) {
    if (vertex && Array.isArray(body.contents)) body = { ...body, contents: body.contents.map(c => (c.role ? c : { role: 'user', ...c })) };
    const res = vertex
      ? await fetch(`${VERTEX}/models/${name}:generateContent?key=${encodeURIComponent(apiKey)}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch(`${STUDIO}/models/${name}:generateContent`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  async function generate(body, { signal } = {}) {
    return post(await resolveModel(), body, signal);
  }

  return { generate, resolveModel, backend: vertex ? 'vertex' : 'studio', model: () => current, answeredBy: () => answered };
}

module.exports = { createGeminiGenerate, pickModel };
