'use strict';
// Shared fixtures for the engine and pack tests: a synthetic board photo, WAV builder,
// a mock of the Meta Model API (shapes from docs/meta-model-api-notes.md) and a fake
// host Gemini generate().
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/engine');

const BOARD = fs.readFileSync(path.join(__dirname, 'fixtures/board-synthetic.jpg'));   // synthetic, 1280×960

/** A 16 kHz mono 16-bit PCM WAV of silence (valid for Muse Voice Transcribe). */
function wav(seconds = 1, rate = 16000) {
  const data = Buffer.alloc(rate * 2 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Width/height from a baseline JPEG's SOF0 marker. */
function jpegSize(b) {
  for (let o = 2; o < b.length;) {
    const marker = b[o + 1], len = b.readUInt16BE(o + 2);
    if (marker === 0xc0 || marker === 0xc2) return { height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) };
    o += 2 + len;
  }
  return null;
}

const RECORD = (over = {}) => ({
  relevant: true,
  session: { kind: 'period', label: '', cohort: '8B', subject: 'Mathematics', course: '', unit: 'Fractions' },
  content: { title: 'Adding fractions with unlike denominators', topics: ['Fractions', 'LCM'], summary: 'Added fractions by making denominators the same using the LCM.',
    method: '', assignments: [{ text: 'Ex 3.2 Q1-5', due: '' }], next: '', materials: [], notes: '' },
  confidence: { kind: 0.9, label: 0, cohort: 0.97, subject: 0.95, course: 0, unit: 0.95, title: 0.9, topics: 0.9, summary: 0.85, method: 0, assignments: 0.95, next: 0, materials: 0 },
  ...over,
});
const ALL_SUPPORTED = { checks: ['session.cohort', 'session.subject', 'session.unit', 'content.title', 'content.topics', 'content.summary', 'content.assignments'].map(field => ({ field, verdict: 'supported', detail: '' })) };

/** Mock of api.meta.ai. Options override per endpoint; records every request. */
function mockMeta({ record = RECORD(), check = ALL_SUPPORTED, transcript = 'Class 8B maths, fractions. Homework exercise 3.2.', fail = {}, samText } = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    const p = new URL(url).pathname.replace('/v1', '');
    const req = { path: p, headers: opts.headers, body: opts.body };
    calls.push(req);
    const reply = (status, obj) => ({ ok: status < 300, status, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
    if (fail[p]) return reply(fail[p], { error: 'boom' });
    if (p === '/responses') {
      return reply(200, { model: 'sam-3.1', output: [{ content: [{ type: 'output_text', text: samText ?? '<0f>0<|box;x1=143;y1=124;x2=1137;y2=756;w=1280;h=960|><|mask;x=0;y=0;data=AAAA|>' }] }] });
    }
    if (p === '/asr/transcribe') {
      const r = JSON.parse(await opts.body.get('request').text());
      req.request = r;
      req.audio = Buffer.from(await opts.body.get('audio').arrayBuffer());
      return reply(200, { sessionId: 's1', transcript, audioDurationMs: 14000, turns: [] });
    }
    if (p === '/chat/completions') {
      const body = JSON.parse(opts.body);
      req.json = body;
      const out = body.response_format.json_schema.name === 'tdx_check' ? check : record;
      return reply(200, { model: 'muse-spark-1.3', choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1600, completion_tokens: 400 } });
    }
    return reply(404, 'not found');
  };
  return { fetch, calls };
}

/** Fake host Gemini generate(): answers transcription, record and check requests. */
function fakeGemini({ record = RECORD(), check = ALL_SUPPORTED, transcript = 'എട്ട് ബി, ഗണിതം. ഭിന്നസംഖ്യകൾ.' } = {}) {
  const calls = [];
  const generate = async body => {
    calls.push(body);
    const props = Object.keys(body.generationConfig.responseSchema.properties);
    const out = props.includes('transcript') ? { transcript, language: 'ml' } : props.includes('checks') ? check : record;
    return { modelVersion: 'gemini-test', candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 300 } };
  };
  return { generate, calls };
}

const CTX = (over = {}) => ({
  tenant: 't_demo', educator_ref: 'e_001', institution_ref: 'i_001', institution_type: 'school',
  locale: 'en-IN', record_locale: 'en', country: 'IN', timezone: 'Asia/Kolkata', date: '2026-10-28',
  channel: 'whatsapp', captured_at: '2026-10-28T04:52:05Z', ...over,
});

function engine({ meta = mockMeta(), gemini, ...opts } = {}) {
  return E.createRecordEngine({ meta: { apiKey: 'test-key', fetch: meta.fetch }, fallback: gemini ? E.fromGenerate(gemini.generate) : [], ...opts });
}

module.exports = { BOARD, wav, jpegSize, RECORD, ALL_SUPPORTED, mockMeta, fakeGemini, CTX, engine };

/** Mock of Baseten's chat completions for Muse Spark Open, with the shapes observed live
 *  (reasoning_content, usage.completion_tokens_details.reasoning_tokens, JSON sometimes fenced). */
function mockBaseten({ record = RECORD(), check = ALL_SUPPORTED, heard = true, transcript = 'Class 8B maths, fractions. Homework 3.2.', fenced = true, status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const reply = (st, obj) => ({ ok: st < 300, status: st, text: async () => JSON.stringify(obj) });
    if (status !== 200) return reply(status, { error: { code: String(status), message: 'boom', type: 'Bad Request' } });
    const name = body.response_format?.json_schema?.name;
    const isAudio = body.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'audio_url'));
    const out = name === 'tdx_check' ? check : record;
    const content = isAudio
      ? (heard ? `TRANSCRIPT: ${transcript}\nENGLISH: ${transcript}\nLANGUAGE: en` : "I don't see an audio file attached to your message, so I don't have anything to transcribe.")
      : fenced ? '```json\n' + JSON.stringify(out) + '\n```' : JSON.stringify(out);
    return reply(200, {
      id: 'x', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, reasoning_content: 'We need to…' } }],
      usage: { prompt_tokens: 1704, completion_tokens: 724, total_tokens: 2428, completion_tokens_details: { reasoning_tokens: 645 } },
    });
  };
  return { fetch, calls };
}
module.exports.mockBaseten = mockBaseten;
