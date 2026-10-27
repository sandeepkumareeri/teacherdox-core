'use strict';
// Muse Spark Open — Meta's open-weight model — served by Baseten, as a Record Engine provider.
// Built on Baseten's docs (Model APIs: reasoning, vision, audio, structured outputs; LLM OpenAPI spec)
// and on what the Baseten probe observed live — both recorded in docs/meta-model-api-notes.md:
//
//   POST https://inference.baseten.co/v1/chat/completions, Authorization: Bearer <BASETEN_API_KEY>
//   model "meta-models/muse-spark-open-1026" (the hackathon name; the docs list "meta-models/muse-spark-open")
//   always reasons (docs): reasoning_effort low|medium|high|xhigh (default xhigh; none/minimal run at low);
//     reasoning arrives in message.reasoning_content and counts in usage…reasoning_tokens and against
//     max_tokens (default 4096), so we ask for more
//   system role works (observed)
//   images (docs): { type: "image_url", image_url: { url } } — data: URLs allowed; ≤ 8 images, ≤ 10 MB each
//   audio (docs):  { type: "audio_url", audio_url: { url } } — WAV, MP3, FLAC, OGG (Vorbis/Opus), M4A;
//     8–48 kHz; ≤ 25 MB / 5 min; data: URLs allowed. WhatsApp OGG/Opus goes as-is.
//   structured outputs (docs): Muse Spark Open "accepts json_schema but doesn't enforce the schema" —
//     so every reply is parsed and validated here, and a reply that does not match is an error (→ fallback)
//
//   structure / check → chat completion with the JSON schema in response_format and in the prompt
//   transcribe        → chat completion with the voice note; asks the model to say if it heard nothing
//
// No segmentation model: the locate step stays with SAM 3.1 on the Meta Model API.

const media = require('../media');
const { validateSchema } = require('../../tdx/schema');

const DEFAULT_MODEL = 'meta-models/muse-spark-open-1026';
const DEFAULT_BASE = 'https://inference.baseten.co/v1';
const AUDIO_TYPES = /^audio\/(wav|x-wav|wave|mpeg|mp3|flac|ogg|opus|mp4|m4a|aac|x-m4a)$/;

const dataUrl = img => `data:${img.media_type};base64,${Buffer.from(img.bytes).toString('base64')}`;
const lang = l => String(l || '').toLowerCase().split('-')[0];

/** Content may arrive wrapped in a ```json fence; take the outermost JSON object. */
function parseJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('content is not JSON');
}

const TRANSCRIBE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['heard_speech', 'transcript', 'english', 'language'],
  properties: { heard_speech: { type: 'boolean' }, transcript: { type: 'string' }, english: { type: 'string' }, language: { type: 'string' } },
};

/**
 * options: apiKey (BASETEN_API_KEY), baseUrl, model (BASETEN_MODEL), fetch, reasoningEffort ('low'),
 *   maxTokens (12000), transcribeLanguages (['en'] — '*' for all), prices { input_per_mtok, output_per_mtok }
 */
function createBasetenProvider({
  apiKey = process.env.BASETEN_API_KEY,
  baseUrl = process.env.BASETEN_BASE_URL || DEFAULT_BASE,
  model = process.env.BASETEN_MODEL || DEFAULT_MODEL,
  fetch: fetchFn = globalThis.fetch,
  reasoningEffort = 'low',
  maxTokens = 12000,
  transcribeLanguages = ['en'],
  prices = null,
} = {}) {
  async function chat(messages, { signal, schema, schemaName }) {
    if (!apiKey) throw Object.assign(new Error('BASETEN_API_KEY is not set'), { model });
    const body = { model, messages, max_tokens: maxTokens, reasoning_effort: reasoningEffort };
    if (schema) body.response_format = { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } };
    const res = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST', signal, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 300)}`), { model });
    let r;
    try { r = JSON.parse(text); } catch { throw Object.assign(new Error('response is not JSON'), { model }); }
    const choice = r.choices?.[0];
    const content = choice?.message?.content;
    if (content == null || content === '') throw Object.assign(new Error(`empty content (finish_reason ${choice?.finish_reason})`), { model });
    let output = content;
    if (schema) {
      try { output = parseJson(content); } catch (e) { throw Object.assign(new Error(e.message), { model }); }
      const v = validateSchema(output, schema);
      if (!v.ok) throw Object.assign(new Error(`reply does not match the schema: ${v.errors.slice(0, 3).join('; ')}`), { model });
    }
    const usage = r.usage ? { input: r.usage.prompt_tokens ?? 0, output: r.usage.completion_tokens ?? 0 } : undefined;
    const cost = prices && usage ? round6((usage.input * prices.input_per_mtok + usage.output * prices.output_per_mtok) / 1e6) : null;
    return { output, model: r.model || model, usage, cost_usd: cost, finish_reason: choice.finish_reason };
  }

  async function json({ instructions, text, images = [], schema, schemaName }, { signal } = {}) {
    // The schema is not enforced by the server, so it is also stated in the prompt.
    const content = [{ type: 'text', text: `${text}\n\nReply with one JSON object that matches this JSON Schema exactly (every property present):\n${JSON.stringify(schema)}` },
      ...images.map(img => ({ type: 'image_url', image_url: { url: dataUrl(img) } }))];
    return chat([{ role: 'system', content: instructions }, { role: 'user', content }], { signal, schema, schemaName });
  }

  async function transcribe({ audio, language }, { signal } = {}) {
    const prompt = [
      'This message contains a teacher\'s voice note about a class they taught.',
      'If you can hear speech in it, give the transcript exactly as spoken in its original language and script, an English rendering, and the ISO 639-1 language code.',
      'If you cannot hear any speech or there is no audio, set heard_speech to false and leave the other fields empty. Never guess.',
      `Reply with one JSON object matching this JSON Schema: ${JSON.stringify(TRANSCRIBE_SCHEMA)}`,
    ].join(' ');
    const r = await chat([{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'audio_url', audio_url: { url: dataUrl(audio) } }] }],
      { signal, schema: TRANSCRIBE_SCHEMA, schemaName: 'voice_note' });
    const o = r.output;
    if (!o.heard_speech || !(o.transcript || o.english).trim()) throw Object.assign(new Error('the model heard no speech in the voice note'), { model: r.model });
    const original = o.transcript.trim(), english = o.english.trim();
    const text = english && english !== original ? `${original}\n[English rendering: ${english}]` : original || english;
    const seconds = media.isTranscribeReadyWav(audio.bytes) ? media.wavSeconds(audio.bytes) : null;
    return { ...r, output: { text, language: lang(o.language) || lang(language) || null, duration_ms: seconds == null ? null : Math.round(seconds * 1000) } };
  }

  return {
    name: 'baseten',
    model,
    capabilities: ['transcribe', 'structure', 'check'],
    supports(capability, input) {
      if (!apiKey) return 'BASETEN_API_KEY is not set';
      if (capability === 'transcribe') {
        const l = lang(input.language);
        if (transcribeLanguages !== '*' && !transcribeLanguages.includes(l)) return `Muse Spark Open transcription not verified for "${l || 'unknown'}"`;
        if (!AUDIO_TYPES.test(input.audio.media_type)) return `audio type ${input.audio.media_type} is not accepted`;
      }
      return true;
    },
    transcribe, structure: json, check: json,
  };
}

const round6 = x => Math.round(x * 1e6) / 1e6;

module.exports = { createBasetenProvider, DEFAULT_MODEL, parseJson };
