'use strict';
// Muse Spark Open on Baseten. Request shapes follow Baseten's docs; responses mimic what the probe saw live.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const { BOARD, wav, RECORD, CTX, mockMeta, fakeGemini, mockBaseten } = require('./helpers');

const engineWith = ({ meta = mockMeta(), baseten = mockBaseten(), gemini, basetenOpts = {} } = {}) => E.createRecordEngine({
  meta: { apiKey: 'meta-key', fetch: meta.fetch },
  baseten: { apiKey: 'bt-key', fetch: baseten.fetch, ...basetenOpts },
  fallback: gemini ? E.fromGenerate(gemini.generate) : [],
});

test('request shape: exact hackathon model id, Bearer auth, system role, image as data URL, low reasoning, schema', async () => {
  const bt = mockBaseten();
  const p = E.createBasetenProvider({ apiKey: 'bt-key', fetch: bt.fetch });
  const r = await p.structure({ instructions: 'Be exact.', text: 'Read the board.', images: [{ bytes: BOARD, media_type: 'image/jpeg' }], schema: require('../src/engine/prompts').RECORD_SCHEMA, schemaName: 'tdx_record' });
  const { url, headers, body } = bt.calls[0];
  assert.equal(url, 'https://inference.baseten.co/v1/chat/completions');
  assert.equal(headers.Authorization, 'Bearer bt-key');
  assert.equal(body.model, 'meta-models/muse-spark-open-1026');
  assert.equal(body.reasoning_effort, 'low');
  assert.ok(body.max_tokens >= 8000, 'reasoning counts against max_tokens (default 4096)');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[1].content[0].text, /JSON Schema exactly/, 'schema is not enforced server-side, so it is in the prompt');
  assert.match(body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(r.output.session.subject, 'Mathematics', 'fenced JSON is parsed');
  assert.deepEqual(r.usage, { input: 1704, output: 724 });
  assert.equal(r.cost_usd, Math.round((1704 * 1.25 + 724 * 4.25) / 1e6 * 1e6) / 1e6, "Baseten's published price");
});

test('a reply that does not match the schema is an error, so the router falls back', async () => {
  const bad = mockBaseten({ record: { relevant: true, session: { cohort: '8B' } } });
  const eng = engineWith({ meta: mockMeta({ fail: { '/chat/completions': 500 } }), baseten: bad, gemini: fakeGemini() });
  const { capsule } = await eng.process({ text: 'fractions', context: CTX() });
  const read = capsule.body.provenance.steps.find(s => s.step === 'read');
  assert.equal(read.provider, 'gemini');
  assert.deepEqual(read.attempts.map(a => a.provider), ['meta', 'baseten']);
  assert.match(read.attempts[1].error, /does not match the schema/);
});

test('Meta Model API down → Muse Spark Open on Baseten serves read and check; provenance names it', async () => {
  const eng = engineWith({ meta: mockMeta({ fail: { '/chat/completions': 503 } }) });
  const { capsule, routing } = await eng.process({ evidence: [{ bytes: BOARD, media_type: 'image/jpeg' }], context: CTX() });
  const st = Object.fromEntries(capsule.body.provenance.steps.map(s => [s.step, s]));
  assert.equal(st.locate.provider, 'meta', 'SAM 3.1 still locates the board');
  assert.equal(st.read.provider, 'baseten');
  assert.equal(st.read.model, 'meta-models/muse-spark-open-1026');
  assert.equal(st.read.status, 'fallback');
  assert.equal(st.check.provider, 'baseten');
  assert.equal(routing.decision, 'auto_lock');
});

test('voice note goes as audio_url with the original OGG bytes (no conversion)', async () => {
  const bt = mockBaseten();
  const p = E.createBasetenProvider({ apiKey: 'k', fetch: bt.fetch });
  const ogg = Buffer.from('OggS fake opus bytes');
  const r = await p.transcribe({ audio: { bytes: ogg, media_type: 'audio/ogg' }, language: 'en' });
  const part = bt.calls[0].body.messages[0].content[1];
  assert.equal(bt.calls[0].body.response_format, undefined, 'structured output made the model report no speech — plain labelled lines instead');
  assert.equal(part.type, 'audio_url');
  assert.equal(part.audio_url.url, `data:audio/ogg;base64,${ogg.toString('base64')}`);
  assert.equal(r.output.text, 'Class 8B maths, fractions. Homework 3.2.');
  assert.equal(r.output.language, 'en');
});

test('"heard no speech" is an error, never an empty transcript; labelled replies are parsed', async () => {
  const p = E.createBasetenProvider({ apiKey: 'k', fetch: mockBaseten({ heard: false }).fetch });
  await assert.rejects(p.transcribe({ audio: { bytes: wav(), media_type: 'audio/wav' }, language: 'en' }), /heard no speech.*don't see an audio file/);
  const { parseLabelled } = require('../src/engine/providers/baseten');
  assert.deepEqual(parseLabelled('TRANSCRIPT: Klasse 8b\nENGLISH: Class 8B\nLANGUAGE: de'), { transcript: 'Klasse 8b', english: 'Class 8B', language: 'de' });
  assert.equal(parseLabelled('I cannot listen to audio.'), null);
});

test('Malayalam is not routed to Muse Spark Open unless enabled (it heard no speech in the live probe)', async () => {
  const bt = mockBaseten(), gemini = fakeGemini();
  const { capsule } = await engineWith({ baseten: bt, gemini }).process({ evidence: [{ bytes: wav(), media_type: 'audio/wav' }], context: CTX({ locale: 'ml-IN' }) });
  const listen = capsule.body.provenance.steps.find(s => s.step === 'listen');
  assert.equal(listen.provider, 'gemini');
  assert.deepEqual(listen.attempts.map(a => a.provider), ['meta', 'baseten']);
  assert.match(listen.attempts[1].error, /not verified for "ml"/);
  const opted = await engineWith({ baseten: mockBaseten(), gemini, basetenOpts: { transcribeLanguages: ['en', 'ml'] } })
    .process({ evidence: [{ bytes: wav(), media_type: 'audio/wav' }], context: CTX({ locale: 'ml-IN' }) });
  assert.equal(opted.capsule.body.provenance.steps.find(s => s.step === 'listen').provider, 'baseten');
});

test('without a Baseten key the provider is left out entirely (no noise in provenance)', async () => {
  const saved = process.env.BASETEN_API_KEY; delete process.env.BASETEN_API_KEY;
  const eng = E.createRecordEngine({ meta: { apiKey: 'k', fetch: mockMeta().fetch } });
  assert.deepEqual(eng.router.providers.map(p => p.name), ['meta']);
  if (saved) process.env.BASETEN_API_KEY = saved;
});

test('HTTP errors and empty content carry the model id into the attempt record', async () => {
  const p = E.createBasetenProvider({ apiKey: 'k', fetch: mockBaseten({ status: 400 }).fetch });
  await assert.rejects(p.structure({ instructions: 'x', text: 'y', schema: { type: 'object' }, schemaName: 'n' }), e => /HTTP 400/.test(e.message) && e.model === 'meta-models/muse-spark-open-1026');
});
