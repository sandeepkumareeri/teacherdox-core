'use strict';
// Meta Model API provider for the Record Engine. Request and response shapes follow
// docs/meta-model-api-notes.md (observed with live calls, 27 Oct 2026) — do not add
// behaviour that is not documented there or on dev.meta.ai.
//
//   segment    → SAM 3.1 via POST /responses (box parsed from its special-token text)
//   transcribe → Muse Voice Transcribe via POST /asr/transcribe (WAV only; no Malayalam)
//   structure  → Muse Spark via POST /chat/completions with a strict JSON schema
//   check      → same as structure, with the check prompt
//
// Never configure the "-contributor" models here: Meta may train on their prompts.

const media = require('../media');

const DEFAULT_MODELS = { spark: 'muse-spark-1.3', sam: 'sam-3.1', transcribe: 'muse-voice-transcribe-1.0' };

// Languages Muse Voice Transcribe lists that we route to it, by BCP 47 primary subtag →
// the name used in `languageBias`. Anything else (notably Malayalam, unsupported) goes to
// the fallback provider.
const TRANSCRIBE_LANGUAGES = {
  en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', mr: 'Marathi', bn: 'Bengali',
  pt: 'Portuguese', id: 'Indonesian', ms: 'Malay', fr: 'French', es: 'Spanish', ar: 'Arabic',
};
const TRANSCRIBE_USD_PER_HOUR = 0.18;   // Meta's published price (see notes)

const dataUrl = img => `data:${img.media_type};base64,${Buffer.from(img.bytes).toString('base64')}`;
const lang = l => String(l || '').toLowerCase().split('-')[0];

/** Parse SAM's special-token output: <|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|> (masks ignored). */
function parseSamBoxes(text) {
  const boxes = [];
  for (const m of String(text || '').matchAll(/<\|box;([^|]*)\|>/g)) {
    const kv = Object.fromEntries(m[1].split(';').map(p => p.split('=')).map(([k, v]) => [k.trim(), Number(v)]));
    if (['x1', 'y1', 'x2', 'y2', 'w', 'h'].every(k => Number.isFinite(kv[k]))) {
      boxes.push({ x1: kv.x1, y1: kv.y1, x2: kv.x2, y2: kv.y2, width: kv.w, height: kv.h });
    }
  }
  return boxes;
}

/** Text of a /responses result (output[0].content[0].text per the notes; joined defensively). */
function responsesText(r) {
  return (r.output || []).flatMap(o => o.content || []).map(c => c.text || '').join('');
}

/**
 * options: apiKey (META_API_KEY), baseUrl, models: { spark, sam, transcribe } (env META_MODEL_SPARK|SAM|TRANSCRIBE),
 *   fetch (for tests), reasoningEffort ('low'), maxCompletionTokens (8000),
 *   prices: { spark: { input_per_mtok, output_per_mtok } } — only when known; otherwise cost is null.
 */
function createMetaProvider({
  apiKey = process.env.META_API_KEY,
  baseUrl = process.env.META_BASE_URL || 'https://api.meta.ai/v1',
  models = {},
  fetch: fetchFn = globalThis.fetch,
  reasoningEffort = 'low',
  maxCompletionTokens = 8000,
  prices = {},
} = {}) {
  const env = { spark: process.env.META_MODEL_SPARK, sam: process.env.META_MODEL_SAM, transcribe: process.env.META_MODEL_TRANSCRIBE };
  const m = { ...DEFAULT_MODELS, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v)), ...models };
  for (const id of Object.values(m)) if (/contributor/.test(id)) throw new Error(`meta: refusing to use ${id} — Meta may train on its prompts`);

  async function post(path, body, signal, model) {
    if (!apiKey) throw Object.assign(new Error('META_API_KEY is not set'), { model });
    const isForm = body instanceof FormData;
    const res = await fetchFn(`${baseUrl}${path}`, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${apiKey}`, ...(isForm ? {} : { 'Content-Type': 'application/json' }) },
      body: isForm ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 300)}`), { model });
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('response is not JSON'), { model }); }
  }

  /** input: { image: { bytes, media_type }, query } → output { boxes: [...] } */
  async function segment({ image, query = 'chalkboard' }, { signal } = {}) {
    const r = await post('/responses', {
      model: m.sam,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: query }, { type: 'input_image', image_url: dataUrl(image) }] }],
    }, signal, m.sam);
    return { output: { boxes: parseSamBoxes(responsesText(r)) }, model: r.model || m.sam };
  }

  /** input: { audio: { bytes, media_type }, language } → output { text, language, duration_ms } */
  async function transcribe({ audio, language }, { signal } = {}) {
    const wav = await media.toTranscribeWav(audio.bytes);   // throws without ffmpeg for non-WAV → fallback
    const bias = TRANSCRIBE_LANGUAGES[lang(language)];
    const fd = new FormData();
    fd.append('request', new Blob([JSON.stringify({ model: m.transcribe, audioEncoding: 'WAV', ...(bias ? { languageBias: [bias] } : {}) })], { type: 'application/json' }));
    fd.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    const r = await post('/asr/transcribe', fd, signal, m.transcribe);
    const seconds = Number.isFinite(r.audioDurationMs) ? r.audioDurationMs / 1000 : media.wavSeconds(wav);
    return {
      output: { text: String(r.transcript || '').trim(), language: lang(language) || null, duration_ms: seconds == null ? null : Math.round(seconds * 1000) },
      model: m.transcribe,
      cost_usd: seconds == null ? null : round6(seconds / 3600 * TRANSCRIBE_USD_PER_HOUR),
    };
  }

  /** input: { instructions, text, images: [{ bytes, media_type }], schema, schemaName } → output: parsed JSON */
  async function json({ instructions, text, images = [], schema, schemaName }, { signal } = {}) {
    // Instructions go in the user turn (the shape verified live); system-role support is unverified.
    const content = [{ type: 'text', text: `${instructions}\n\n${text}` }, ...images.map(img => ({ type: 'image_url', image_url: { url: dataUrl(img) } }))];
    const r = await post('/chat/completions', {
      model: m.spark,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } },
      max_completion_tokens: maxCompletionTokens,
      reasoning_effort: reasoningEffort,
    }, signal, m.spark);
    const raw = r.choices?.[0]?.message?.content;
    if (raw == null) throw Object.assign(new Error(`empty content (finish_reason ${r.choices?.[0]?.finish_reason}) — reasoning used the token budget`), { model: m.spark });
    let output;
    try { output = JSON.parse(raw); } catch { throw Object.assign(new Error('content is not valid JSON'), { model: m.spark }); }
    const usage = r.usage ? { input: r.usage.prompt_tokens ?? 0, output: r.usage.completion_tokens ?? 0 } : undefined;
    const p = prices.spark;
    const cost = p && usage ? round6((usage.input * p.input_per_mtok + usage.output * p.output_per_mtok) / 1e6) : null;
    return { output, model: r.model || m.spark, usage, cost_usd: cost };
  }

  return {
    name: 'meta',
    models: m,
    capabilities: ['segment', 'transcribe', 'structure', 'check'],
    supports(capability, input) {
      if (!apiKey) return 'META_API_KEY is not set';
      if (capability === 'transcribe') {
        const l = lang(input.language);
        if (l && !TRANSCRIBE_LANGUAGES[l]) return `Muse Voice Transcribe does not support "${l}"`;
        if (!media.isTranscribeReadyWav(input.audio.bytes) && !media.hasFfmpeg()) return 'needs ffmpeg to convert audio to WAV';
      }
      return true;
    },
    segment, transcribe, structure: json, check: json,
  };
}

const round6 = x => Math.round(x * 1e6) / 1e6;

module.exports = { createMetaProvider, parseSamBoxes, TRANSCRIBE_LANGUAGES, DEFAULT_MODELS };
