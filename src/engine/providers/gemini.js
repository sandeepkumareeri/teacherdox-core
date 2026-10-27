'use strict';
// Fallback provider built from a host-supplied Gemini `generate(body, opts)` function —
// e.g. the TeacherDox product's gemini.generate, which already picks the model, enforces
// daily limits and can route to Vertex. The core never talks to Google itself and never
// names a Gemini model: it only shapes generateContent requests and reads the response.
//
//   fromGenerate(generate, { name = 'gemini' }) → provider with transcribe, structure, check
//
// No `segment`: without a segmentation model the locate step is skipped and the whole
// photo is read.

const LANGUAGE_NAMES = { en: 'English', ml: 'Malayalam', te: 'Telugu', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada', mr: 'Marathi', bn: 'Bengali', pt: 'Portuguese', id: 'Indonesian', fr: 'French', es: 'Spanish', ar: 'Arabic' };

/** JSON Schema (the strict subset the engine uses) → Gemini responseSchema (OpenAPI subset). */
function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

const part = media => ({ inlineData: { mimeType: media.media_type, data: Buffer.from(media.bytes).toString('base64') } });

function readText(r) {
  const parts = r?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('');
  if (!text) throw new Error(`empty response (finishReason ${r?.candidates?.[0]?.finishReason})`);
  return text;
}
const usageOf = r => r?.usageMetadata ? { input: r.usageMetadata.promptTokenCount ?? 0, output: r.usageMetadata.candidatesTokenCount ?? 0 } : undefined;

function fromGenerate(generate, { name = 'gemini', timeoutMs } = {}) {
  if (typeof generate !== 'function') throw new Error('fromGenerate: generate(body, opts) function required');

  async function call(parts, schema, signal) {
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
    };
    const r = await generate(body, { signal, timeout: timeoutMs });
    let output;
    try { output = JSON.parse(readText(r)); } catch (e) { throw new Error(`gemini: ${e.message}`); }
    return { output, model: r?.modelVersion || null, usage: usageOf(r), cost_usd: null };
  }

  return {
    name,
    capabilities: ['transcribe', 'structure', 'check'],
    async transcribe({ audio, language }, { signal } = {}) {
      const l = String(language || '').toLowerCase().split('-')[0];
      const prompt = `Transcribe this voice note exactly as spoken${LANGUAGE_NAMES[l] ? ` (most likely in ${LANGUAGE_NAMES[l]})` : ''}. Keep the original language and script; do not translate or summarise. Return the transcript and the ISO 639-1 code of the language spoken.`;
      const schema = { type: 'object', properties: { transcript: { type: 'string' }, language: { type: 'string' } }, required: ['transcript', 'language'] };
      const r = await call([{ text: prompt }, part(audio)], schema, signal);
      return { ...r, output: { text: String(r.output.transcript || '').trim(), language: r.output.language || l || null, duration_ms: null } };
    },
    async structure({ instructions, text, images = [], schema }, { signal } = {}) {
      return call([{ text: `${instructions}\n\n${text}` }, ...images.map(part)], schema, signal);
    },
    async check({ instructions, text, images = [], schema }, { signal } = {}) {
      return call([{ text: `${instructions}\n\n${text}` }, ...images.map(part)], schema, signal);
    },
  };
}

module.exports = { fromGenerate, toGeminiSchema };
