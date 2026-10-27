'use strict';
// Live Record Engine run on synthetic evidence only (never educator data): the synthetic
// board photo in test/fixtures plus synthetic voice notes from LIVE_AUDIO_DIR (made with
// espeak-ng by .github/workflows/engine-live.yml). Prints each record, its pipeline
// steps (provider, model, status, ms, cost) and routing, as GitHub annotations and a
// step summary.
//
// Env: META_API_KEY (required). Optional fallback for the demo: GEMINI_API_KEY + GEMINI_MODEL
// (the script, not the core, talks to Google; the core only takes a generate function).
const fs = require('node:fs');
const path = require('node:path');
const { createRecordEngine, fromGenerate } = require('../src/engine');

const BOARD = fs.readFileSync(path.join(__dirname, '../test/fixtures/board-synthetic.jpg'));
const AUDIO = process.env.LIVE_AUDIO_DIR;
const summary = [];
const note = (title, msg) => console.log(`::notice title=${title}::${String(msg).replace(/\r?\n/g, ' ⏎ ').slice(0, 3500)}`);

function geminiGenerate() {
  const { GEMINI_API_KEY: key, GEMINI_MODEL: model } = process.env;
  if (!key || !model) return null;
  return async (body, { signal } = {}) => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
}

const audio = name => {
  const f = AUDIO && path.join(AUDIO, `${name}.ogg`);
  return f && fs.existsSync(f) ? { bytes: fs.readFileSync(f), media_type: 'audio/ogg' } : null;
};

const CTX = over => ({
  tenant: 't_demo', educator_ref: 'e_demo', institution_ref: 'i_demo', institution_type: 'school',
  locale: 'en-IN', record_locale: 'en', country: 'IN', timezone: 'Asia/Kolkata',
  date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), channel: 'api', ...over,
});

const CASES = [
  { name: 'board photo', evidence: [{ bytes: BOARD, media_type: 'image/jpeg' }], context: CTX() },
  { name: 'board + English voice', evidence: [{ bytes: BOARD, media_type: 'image/jpeg' }, audio('en')], context: CTX({ session: { label: 'P2' } }) },
  { name: 'Hindi voice only', evidence: [audio('hi')], context: CTX({ locale: 'hi-IN' }) },
  { name: 'Telugu voice only', evidence: [audio('te')], context: CTX({ locale: 'te-IN' }) },
  { name: 'Malayalam voice (routes to fallback)', evidence: [audio('ml')], context: CTX({ locale: 'ml-IN' }) },
  { name: 'Portuguese university lecture', evidence: [audio('pt')], context: CTX({ locale: 'pt-BR', country: 'BR', timezone: 'America/Sao_Paulo', institution_type: 'university' }) },
];

(async () => {
  if (!process.env.META_API_KEY) { console.log('::error::META_API_KEY secret is not set'); process.exit(1); }
  const gen = geminiGenerate();
  const engine = createRecordEngine({ fallback: gen ? fromGenerate(gen) : [], dailyLimit: { meta: 60 }, timeoutMs: { default: 90000, transcribe: 60000 } });
  summary.push('## Record Engine — live run (synthetic evidence)', '', `Fallback provider: ${gen ? 'Gemini' : 'none configured'}`, '');

  for (const c of CASES) {
    const evidence = c.evidence.filter(Boolean);
    if (!evidence.length) continue;
    const t0 = Date.now();
    try {
      const { capsule, routing, transcripts, flags } = await engine.process({ evidence, context: c.context });
      const b = capsule.body;
      const fields = `${b.session.cohort || '—'} · ${b.session.subject || '—'} · ${b.session.unit || '—'} · "${b.content.title || ''}" · HW: ${b.content.assignments.map(a => a.text).join('; ') || '—'}`;
      note(`${c.name} (${Date.now() - t0} ms) → ${routing.decision}`, `${fields} | overall ${b.provenance.overall_confidence} | flags ${JSON.stringify(flags)} | transcripts ${JSON.stringify(transcripts.map(t => t.text))}`);
      summary.push(`### ${c.name} — ${routing.decision} (${Date.now() - t0} ms)`, '', fields, '',
        '| step | provider | model | status | ms | tokens in/out | cost USD |', '|---|---|---|---|---|---|---|',
        ...b.provenance.steps.map(s => `| ${s.step} | ${s.provider} | ${s.model || ''} | ${s.status}${s.attempts ? ` (${s.attempts.map(a => `${a.provider}: ${a.error}`).join('; ').replace(/\|/g, '/')})` : ''} | ${s.ms ?? ''} | ${s.tokens ? `${s.tokens.input}/${s.tokens.output}` : ''} | ${s.cost_usd ?? 'n/a'} |`),
        '', `Routing: ${routing.reasons.join('; ') || 'all fields meet the policy'}`, '');
    } catch (e) {
      note(`${c.name} FAILED`, e.message);
      summary.push(`### ${c.name} — FAILED`, '', e.message, '');
    }
  }
  fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/stdout', summary.join('\n') + '\n');
})();
