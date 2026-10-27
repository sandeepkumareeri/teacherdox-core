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
//   price (baseten.co/pricing, 27 Oct 2026): $1.25 input, $0.15 cached input, $4.25 output per 1M tokens
//   transcription (observed): with response_format json_schema the model reported "no speech" for every
//     voice note, English included; with a plain prompt asking for labelled lines it heard English.
//     So transcription uses the labelled-line format, and a reply without a real TRANSCRIPT line is "not heard".
//     Even so, across three live probes it heard synthetic English once (en.wav) and Malayalam never usably
//     (one phonetic garble tagged "kn"); most replies were "no audio was provided". Transcription is therefore
//     OFF by default (transcribeLanguages: []) — enable it per language only after it is measured to work.
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

const PRICE = { input_per_mtok: 1.25, output_per_mtok: 4.25 };   // baseten.co/pricing, 27 Oct 2026 (cached input $0.15 not applied)

const NOT_HEARD = /\b(no (audio|speech|voice)|not (hear|detect)|cannot hear|can't hear|unable to (hear|listen)|upload the (voice|audio))/i;

/** "TRANSCRIPT: … / ENGLISH: … / LANGUAGE: xx" → fields, or null when the model gave no transcript. */
function parseLabelled(text) {
  const grab = label => (String(text).match(new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, 'im')) || [])[1]?.trim() || '';
  const transcript = grab('TRANSCRIPT'), english = grab('ENGLISH'), language = grab('LANGUAGE');
  // A reply that only says there is no audio is "not heard", even when it uses the labels (observed live).
  if (!transcript || NOT_HEARD.test(transcript) || NOT_HEARD.test(english)) return null;
  return { transcript, english, language: language.replace(/[^a-z-]/gi, '').slice(0, 5) };
}

/**
 * options: apiKey (BASETEN_API_KEY), baseUrl, model (BASETEN_MODEL), fetch, reasoningEffort ('low'),
 *   maxTokens (12000), transcribeLanguages ([] = off; ['en'] or '*' to enable), prices { input_per_mtok, output_per_mtok }
 *   (default: Baseten's published Muse Spark Open price; null = unknown)
 */
function createBasetenProvider({
  apiKey = process.env.BASETEN_API_KEY,
  baseUrl = process.env.BASETEN_BASE_URL || DEFAULT_BASE,
  model = process.env.BASETEN_MODEL || DEFAULT_MODEL,
  fetch: fetchFn = globalThis.fetch,
  reasoningEffort = 'low',
  maxTokens = 12000,
  transcribeLanguages = [],
  prices = PRICE,
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
    const prompt = 'Transcribe this voice note exactly, in its original language and script. Then give an English translation. '
      + 'Answer as three lines: TRANSCRIPT: … / ENGLISH: … / LANGUAGE: <ISO 639-1>. If there is no speech you can hear, say so and give no TRANSCRIPT line.';
    const r = await chat([{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'audio_url', audio_url: { url: dataUrl(audio) } }] }], { signal });
    const o = parseLabelled(r.output);
    if (!o) throw Object.assign(new Error(`the model heard no speech in the voice note: "${String(r.output).slice(0, 120)}"`), { model: r.model });
    const original = o.transcript, english = o.english;
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
        if (transcribeLanguages !== '*' && !transcribeLanguages.includes(l)) return `Muse Spark Open transcription is off for "${l || 'unknown'}" (unreliable in live probes)`;
        if (!AUDIO_TYPES.test(input.audio.media_type)) return `audio type ${input.audio.media_type} is not accepted`;
      }
      return true;
    },
    transcribe, structure: json, check: json,
  };
}

const round6 = x => Math.round(x * 1e6) / 1e6;

module.exports = { createBasetenProvider, DEFAULT_MODEL, PRICE, parseJson, parseLabelled };
