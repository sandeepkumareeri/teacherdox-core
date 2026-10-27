'use strict';
// Baseten probe: a few raw calls to Meta's open-weight Muse Spark Open on Baseten, with synthetic
// data only, printed as-is so the provider is built on observed behaviour. Each call reports
// HTTP status, latency, the message fields that came back (content, any reasoning field) and usage.
//
// Env: BASETEN_API_KEY (required); PROBE_AUDIO_DIR with en.wav / ml.wav / ml.ogg (optional).
const fs = require('node:fs');
const path = require('node:path');

const KEY = process.env.BASETEN_API_KEY;
const BASE = 'https://inference.baseten.co/v1';
const MODEL = 'meta-models/muse-spark-open-1026';
const BOARD = fs.readFileSync(path.join(__dirname, '../test/fixtures/board-synthetic.jpg')).toString('base64');
const AUDIO = process.env.PROBE_AUDIO_DIR;
const cut = (s, n = 3000) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + `… [${String(s).length} chars]` : String(s));
const notice = (t, m) => console.log(`::notice title=${t}::${cut(m, 3500).replace(/\r?\n/g, ' ⏎ ')}`);

async function call(name, body) {
  const t0 = Date.now();
  let status = 0, text = '';
  try {
    const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, ...body }) });
    status = res.status; text = await res.text();
  } catch (e) { text = `fetch error: ${e.message}`; }
  const ms = Date.now() - t0;
  console.log(`\n================ ${name}: HTTP ${status}, ${ms} ms`);
  let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!j || !j.choices) { console.log(cut(text)); notice(`${name} ✗ HTTP ${status} ${ms} ms`, text); return; }
  const m = j.choices[0].message || {};
  console.log('model:', j.model, '| finish_reason:', j.choices[0].finish_reason);
  console.log('message keys:', Object.keys(m).join(', '));
  for (const [k, v] of Object.entries(m)) if (typeof v === 'string' || v == null) console.log(`--- message.${k}:\n${cut(v)}`);
  console.log('usage:', JSON.stringify(j.usage));
  console.log('top-level keys:', Object.keys(j).join(', '));
  notice(`${name} ✓ ${ms} ms`, `content=${cut(m.content, 800)} | reasoning fields=${Object.keys(m).filter(k => /reason/i.test(k)).join(',') || 'none'} | usage=${JSON.stringify(j.usage)}`);
}

const schema = {
  type: 'object', additionalProperties: false, required: ['cohort', 'subject', 'unit', 'title', 'assignments', 'confidence'],
  properties: { cohort: { type: 'string' }, subject: { type: 'string' }, unit: { type: 'string' }, title: { type: 'string' }, assignments: { type: 'array', items: { type: 'string' } }, confidence: { type: 'number' } },
};

(async () => {
  if (!KEY) { console.log('::error::BASETEN_API_KEY secret is not set'); process.exit(1); }
  await call('text', { messages: [{ role: 'user', content: 'Reply with exactly: TeacherDox OK' }], max_tokens: 4000 });
  await call('system-role', { messages: [{ role: 'system', content: 'Answer in one word.' }, { role: 'user', content: 'Capital of France?' }], max_tokens: 4000 });
  await call('json_schema (text)', {
    messages: [{ role: 'user', content: 'Class 8B, maths period: adding fractions with unlike denominators. Homework exercise 3.2 Q1-5. Extract the record.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'record', schema, strict: true } }, max_tokens: 6000,
  });
  await call('vision + json_schema (board)', {
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'This is a classroom board photo. Extract the teaching record. subject is the discipline (e.g. Mathematics), unit is the chapter.' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${BOARD}` } }] }],
    response_format: { type: 'json_schema', json_schema: { name: 'record', schema, strict: true } }, max_tokens: 6000,
  });
  await call('reasoning_effort low', { messages: [{ role: 'user', content: 'What is 17 * 23? Answer with the number only.' }], reasoning_effort: 'low', max_tokens: 4000 });

  if (AUDIO && fs.existsSync(AUDIO)) {
    const ask = 'Transcribe this voice note exactly, in its original language and script. Then give an English translation. Answer as: TRANSCRIPT: … / ENGLISH: … / LANGUAGE: <ISO 639-1>';
    for (const [lang, file, fmt] of [['en', 'en.wav', 'wav'], ['ml', 'ml.wav', 'wav'], ['ml', 'ml.ogg', 'ogg']]) {
      const f = path.join(AUDIO, file);
      if (!fs.existsSync(f)) continue;
      const data = fs.readFileSync(f).toString('base64');
      await call(`audio ${lang} ${fmt} (input_audio)`, { messages: [{ role: 'user', content: [{ type: 'text', text: ask }, { type: 'input_audio', input_audio: { data, format: fmt } }] }], max_tokens: 6000 });
      if (fmt === 'wav') {
        await call(`audio ${lang} ${fmt} (audio_url data URL)`, { messages: [{ role: 'user', content: [{ type: 'text', text: ask }, { type: 'audio_url', audio_url: { url: `data:audio/${fmt};base64,${data}` } }] }], max_tokens: 6000 });
      }
    }
  }
})();
