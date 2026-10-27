'use strict';
// Record Engine tests. The Meta Model API is mocked with the request/response shapes
// recorded in docs/meta-model-api-notes.md; ffmpeg-dependent tests skip without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tdx = require('../src/tdx');
const E = require('../src/engine');

const BOARD = fs.readFileSync(path.join(__dirname, 'fixtures/board-synthetic.jpg'));   // synthetic, 1280×960
const FF = E.media.hasFfmpeg();

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

test('SAM special-token output → pixel boxes; masks ignored', () => {
  const boxes = E.parseSamBoxes('<0f>0<|box;x1=143;y1=124;x2=1137;y2=756;w=1280;h=960|><|mask;x=0;y=0;data=xx|><0f>1<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=10|>');
  assert.deepEqual(boxes[0], { x1: 143, y1: 124, x2: 1137, y2: 756, width: 1280, height: 960 });
  assert.equal(boxes.length, 2);
  assert.deepEqual(E.parseSamBoxes('no boxes'), []);
});

test('WAV detection: mono 16-bit 16/24 kHz is passed through as-is', async () => {
  assert.equal(E.media.isTranscribeReadyWav(wav()), true);
  assert.equal(E.media.isTranscribeReadyWav(wav(1, 44100)), false);
  assert.equal(E.media.isTranscribeReadyWav(Buffer.from('OggS....')), false);
  const w = wav(2);
  assert.ok((await E.media.toTranscribeWav(w)).equals(w));
  assert.equal(E.media.wavSeconds(w), 2);
});

test('OGG/Opus voice note → 16 kHz mono WAV via ffmpeg', { skip: !FF && 'ffmpeg not installed' }, async () => {
  const ogg = await E.media.ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], Buffer.alloc(0));
  const out = await E.media.toTranscribeWav(ogg);
  assert.deepEqual(E.media.wavInfo(out), { format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 });
});

test('board crop follows the SAM box (plus margin)', { skip: !FF && 'ffmpeg not installed' }, async () => {
  const crop = await E.media.cropImage(BOARD, { x1: 143, y1: 124, x2: 1137, y2: 756, width: 1280, height: 960 });
  assert.deepEqual(jpegSize(crop), { width: 994 + 2 * 26, height: 632 + 2 * 19 });
});

test('router: priority order, fallback on error, unsupported input, consent and daily limit', async () => {
  const bad = { name: 'a', capabilities: ['structure'], structure: async () => { throw new Error('HTTP 500'); } };
  const picky = { name: 'b', capabilities: ['structure'], supports: () => 'not for this input', structure: async () => ({ output: 'b' }) };
  const good = { name: 'c', capabilities: ['structure'], structure: async () => ({ output: 'c', model: 'm-c', usage: { input: 1, output: 2 } }) };
  const r = E.createRouter({ providers: [bad, picky, good], dailyLimit: { c: 1 } });
  const { output, step } = await r.run('structure', {}, { step: 'read' });
  assert.equal(output, 'c');
  assert.equal(step.status, 'fallback');
  assert.deepEqual(step.attempts.map(a => a.provider), ['a', 'b']);
  assert.match(step.attempts[0].error, /HTTP 500/);
  await assert.rejects(r.run('structure', {}, { step: 'read' }), e => e.code === 'NO_PROVIDER' && /daily limit/.test(e.message));
  const r2 = E.createRouter({ providers: [good, bad] });
  const ok = await r2.run('structure', {}, { allow: ['c'] });
  assert.equal(ok.step.status, 'ok');
});

test('router: a slow provider times out and the next one answers', async () => {
  const slow = { name: 'slow', capabilities: ['verify'], verify: (_, { signal }) => new Promise((res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) };
  const fast = { name: 'fast', capabilities: ['verify'], verify: async () => ({ output: 1 }) };
  const r = E.createRouter({ providers: [slow, fast], timeoutMs: 30 });
  const { step } = await r.run('verify', {});
  assert.equal(step.provider, 'fast');
  assert.match(step.attempts[0].error, /timed out/);
});

test('full pipeline on Meta: locate → listen → read → check → score → valid draft capsule', async () => {
  const meta = mockMeta();
  const { capsule, routing, transcripts, derived, steps } = await engine({ meta }).process({
    evidence: [{ bytes: BOARD, media_type: 'image/jpeg' }, { bytes: wav(), media_type: 'audio/wav' }],
    text: 'P2 done', context: CTX(),
  });
  assert.deepEqual(tdx.validateCapsule(capsule).errors, []);
  const b = capsule.body;
  assert.equal(b.lifecycle.state, 'draft');
  assert.deepEqual(steps.map(s => `${s.step}:${s.provider}:${s.model}`), ['locate:meta:sam-3.1', 'listen:meta:muse-voice-transcribe-1.0', 'read:meta:muse-spark-1.3', 'check:meta:muse-spark-1.3']);
  assert.equal(b.provenance.fallback_used, false);
  assert.equal(b.session.subject, 'Mathematics');
  assert.equal(b.session.unit, 'Fractions');
  assert.equal(b.session.label, null);
  assert.deepEqual(b.content.assignments, [{ text: 'Ex 3.2 Q1-5', due: null }]);
  assert.deepEqual(b.source.capture_methods, ['photo', 'voice', 'text']);
  assert.deepEqual(b.evidence_findings[0].box, [0.1117, 0.1292, 0.8883, 0.7875]);
  assert.equal(b.evidence_findings[1].finding, 'transcript');
  assert.equal(b.evidence[1].duration_s, 14);
  assert.equal(steps[1].cost_usd, 0.0007);                       // 14 s at $0.18/h
  assert.deepEqual(steps[2].tokens, { input: 1600, output: 400 });
  assert.equal(routing.decision, 'auto_lock', routing.reasons.join('; '));
  assert.equal(transcripts[0].text, 'Class 8B maths, fractions. Homework exercise 3.2.');

  // Request shapes match the documented API.
  const asr = meta.calls.find(c => c.path === '/asr/transcribe');
  assert.deepEqual(asr.request, { model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', languageBias: ['English'] });
  assert.equal(asr.headers.Authorization, 'Bearer test-key');
  const read = meta.calls.find(c => c.json?.response_format?.json_schema?.name === 'tdx_record').json;
  assert.equal(read.reasoning_effort, 'low');
  assert.equal(read.response_format.json_schema.strict, true);
  assert.match(read.messages[0].content[0].text, /subject is the discipline/);
  assert.match(read.messages[0].content[0].text, /Educator's message 1: """P2 done"""/);
  assert.match(read.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  if (FF) { assert.equal(derived.length, 1); assert.match(read.messages[0].content[0].text, /cropped to the board/); }

  // The capsule carries hashes only — no raw bytes, no transcript text.
  const json = JSON.stringify(capsule);
  assert.ok(!json.includes(BOARD.toString('base64').slice(0, 40)));
  assert.ok(!json.includes('Homework exercise 3.2'));
  assert.equal(b.evidence_findings[1].text_ref, tdx.sha256(transcripts[0].text));

  // The draft locks and verifies with the trust layer.
  const key = tdx.generateKey('k_engine', { validFrom: '2026-01-01T00:00:00Z' });
  const locked = tdx.lock(capsule, { key, state: 'auto_locked', attestation: { policy_profile: routing.policy_profile, auto_accepted_fields: routing.auto_accepted_fields } });
  assert.equal(tdx.verifyCapsule(locked, { keys: [key.publicEntry] }).ok, true);
});

test('Malayalam voice note: Muse Voice Transcribe skipped, fallback transcribes, provenance shows it', async () => {
  const meta = mockMeta(), gemini = fakeGemini();
  const { capsule, transcripts } = await engine({ meta, gemini }).process({
    evidence: [{ bytes: wav(), media_type: 'audio/wav' }], context: CTX({ locale: 'ml-IN' }),
  });
  const listen = capsule.body.provenance.steps.find(s => s.step === 'listen');
  assert.equal(listen.provider, 'gemini');
  assert.equal(listen.status, 'fallback');
  assert.match(listen.attempts[0].error, /does not support "ml"/);
  assert.equal(capsule.body.provenance.fallback_used, true);
  assert.equal(transcripts[0].language, 'ml');
  assert.ok(!meta.calls.some(c => c.path === '/asr/transcribe'));
  assert.equal(capsule.body.provenance.steps.find(s => s.step === 'read').provider, 'meta');   // record still read by Muse Spark
  assert.equal(capsule.body.record_locale, 'en');
});

test('Meta down: every step falls back; locate fails soft and the whole photo is read', async () => {
  const meta = mockMeta({ fail: { '/responses': 503, '/chat/completions': 500 } });
  const gemini = fakeGemini();
  const { capsule, routing } = await engine({ meta, gemini }).process({ evidence: [{ bytes: BOARD, media_type: 'image/jpeg' }], context: CTX() });
  const st = Object.fromEntries(capsule.body.provenance.steps.map(s => [s.step, s]));
  assert.equal(st.locate.status, 'failed');
  assert.equal(st.read.provider, 'gemini');
  assert.equal(st.read.model, 'gemini-test');
  assert.equal(st.check.provider, 'gemini');
  assert.match(st.read.attempts[0].error, /HTTP 500/);
  const sent = gemini.calls.find(c => 'checks' in c.generationConfig.responseSchema.properties === false && !('transcript' in c.generationConfig.responseSchema.properties));
  assert.equal(sent.contents[0].parts[1].inlineData.data, BOARD.toString('base64'));
  assert.equal(routing.decision, 'auto_lock');
});

test('check step: a contradicted cohort holds a school record; an unsupported assignment needs confirmation', async () => {
  const contradicted = mockMeta({ check: { checks: [{ field: 'session.cohort', verdict: 'contradicted', detail: 'board says 8C' }] } });
  const r1 = await engine({ meta: contradicted }).process({ evidence: [{ bytes: BOARD, media_type: 'image/jpeg' }], context: CTX() });
  assert.equal(r1.routing.decision, 'hold');
  assert.deepEqual(r1.flags, [{ field: 'session.cohort', issue: 'contradicted', detail: 'board says 8C' }]);
  assert.equal(r1.capsule.body.provenance.field_confidence['session.cohort'], 0.2);

  const unsupported = mockMeta({ check: { checks: [{ field: 'content.assignments', verdict: 'unsupported', detail: 'not on board' }] } });
  const r2 = await engine({ meta: unsupported }).process({ evidence: [{ bytes: BOARD, media_type: 'image/jpeg' }], context: CTX() });
  assert.equal(r2.routing.decision, 'confirm');
  assert.deepEqual(r2.routing.confirm_fields, ['content.assignments']);
});

test('values the educator gave (e.g. tapped "Period 2", 8B) win over the model and are never flagged', async () => {
  const meta = mockMeta({ record: RECORD({ session: { ...RECORD().session, cohort: '8C' } }), check: { checks: [{ field: 'session.cohort', verdict: 'contradicted', detail: 'x' }] } });
  const { capsule, routing } = await engine({ meta }).process({ text: 'fractions, HW 3.2', context: CTX({ session: { label: 'P2', cohort: '8B' } }) });
  assert.equal(capsule.body.session.cohort, '8B');
  assert.equal(capsule.body.session.label, 'P2');
  assert.equal(capsule.body.provenance.field_confidence['session.cohort'], 1);
  assert.equal(routing.decision, 'auto_lock');
});

test('consent: allow_providers keeps an educator\'s data away from Meta entirely', async () => {
  const meta = mockMeta(), gemini = fakeGemini();
  const { capsule } = await engine({ meta, gemini }).process({ evidence: [{ bytes: BOARD, media_type: 'image/jpeg' }], context: CTX({ allow_providers: ['gemini'] }) });
  assert.equal(meta.calls.length, 0);
  assert.ok(capsule.body.provenance.steps.filter(s => s.status !== 'failed').every(s => s.provider === 'gemini'));
  assert.equal(capsule.body.provenance.fallback_used, false);
});

test('irrelevant evidence is held; a missing subject asks the educator', async () => {
  const r1 = await engine({ meta: mockMeta({ record: RECORD({ relevant: false }) }) }).process({ text: 'good morning', context: CTX() });
  assert.equal(r1.routing.decision, 'hold');
  const r2 = await engine({ meta: mockMeta({ record: RECORD({ session: { ...RECORD().session, subject: '' } }) }) }).process({ text: 'did ch 3', context: CTX() });
  assert.equal(r2.routing.decision, 'confirm');
  assert.ok(r2.routing.confirm_fields.includes('session.subject'));
});

test('university lecture: course is critical; policy is configurable', async () => {
  const rec = RECORD({ session: { kind: 'lecture', label: 'L14', cohort: '', subject: 'Computer Science', course: '', unit: 'Hash tables' } });
  const r = await engine({ meta: mockMeta({ record: rec }) }).process({ text: 'L14 hashing', context: CTX({ institution_type: 'university', country: 'BR', timezone: 'America/Sao_Paulo', locale: 'pt-BR' }) });
  assert.equal(r.capsule.body.session.kind, 'lecture');
  assert.ok(r.routing.confirm_fields.includes('session.course'));
  const relaxed = await engine({ meta: mockMeta({ record: RECORD({ confidence: { ...RECORD().confidence, cohort: 0.8 } }) }) })
    .process({ text: 'x', context: CTX({ policy: 'personal' }) });
  assert.equal(relaxed.routing.decision, 'auto_lock');
  assert.equal(relaxed.routing.policy_profile, 'personal');
});

test('Muse Spark returning null content (reasoning used the budget) falls back', async () => {
  const meta = mockMeta();
  const orig = meta.fetch;
  meta.fetch = async (url, opts) => url.endsWith('/chat/completions')
    ? { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }] }) }
    : orig(url, opts);
  const { capsule } = await engine({ meta, gemini: fakeGemini() }).process({ text: 'fractions', context: CTX() });
  const read = capsule.body.provenance.steps.find(s => s.step === 'read');
  assert.equal(read.provider, 'gemini');
  assert.match(read.attempts[0].error, /empty content/);
});

test('Gemini schema conversion and refusal of contributor models', () => {
  const s = E.toGeminiSchema({ type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'array', items: { type: 'string' } } } });
  assert.deepEqual(s, { type: 'OBJECT', properties: { a: { type: 'ARRAY', items: { type: 'STRING' } } }, propertyOrdering: ['a'], required: ['a'] });
  assert.throws(() => E.createMetaProvider({ apiKey: 'k', models: { spark: 'muse-spark-1.3-contributor' } }), /refusing/);
});

test('no Meta key: Meta is skipped with a reason, not an error', async () => {
  const eng = E.createRecordEngine({ meta: { apiKey: '' }, fallback: E.fromGenerate(fakeGemini().generate) });
  const { capsule } = await eng.process({ text: 'fractions', context: CTX() });
  const read = capsule.body.provenance.steps.find(s => s.step === 'read');
  assert.equal(read.provider, 'gemini');
  assert.match(read.attempts[0].error, /META_API_KEY is not set/);
});

test('nothing usable (only voice note untranscribable, no fallback): no record is invented, draft is held', async () => {
  const meta = mockMeta();
  const { capsule, routing } = await engine({ meta }).process({ evidence: [{ bytes: wav(), media_type: 'audio/wav' }], context: CTX({ locale: 'ml-IN' }) });
  assert.equal(meta.calls.length, 0);
  assert.equal(routing.decision, 'hold');
  assert.match(routing.reasons[0], /no usable evidence/);
  assert.deepEqual(capsule.body.provenance.steps.map(s => `${s.step}:${s.status}`), ['listen:failed', 'read:skipped']);
  assert.equal(tdx.validateCapsule(capsule).ok, true);
});
