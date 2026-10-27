'use strict';
// Eval harness: the same synthetic cases through each model configuration, scored per field.
//
//   meta     — Meta Model API: SAM 3.1 locate, Muse Voice Transcribe, Muse Spark read + check
//   baseten  — Muse Spark Open (Meta's open weights) on Baseten: transcribe, read + check (no
//              segmentation model, so the whole photo is read). Transcription enabled for every
//              language here so it is measured, whatever the engine's default routing is.
//   gemini   — Gemini via generateContent (GEMINI_API_KEY + GEMINI_MODEL); no segmentation
//
// No cross-provider fallback inside a configuration: every number belongs to one provider.
// Writes OUT_DIR/results.json and OUT_DIR/RESULTS.md, and prints the table to the log.
//
// Env: META_API_KEY, BASETEN_API_KEY, GEMINI_API_KEY + GEMINI_MODEL (each optional; missing = not run),
//      EVAL_DATA (rendered boards/ and voices/), OUT_DIR, EVAL_CONFIGS (default meta,baseten,gemini)
const fs = require('node:fs');
const path = require('node:path');
const E = require('../src/engine');
const { scoreRecord, FIELDS } = require('./score');

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const DATA = process.env.EVAL_DATA || path.join(__dirname, 'data');
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out');
const CONFIGS = (process.env.EVAL_CONFIGS || 'meta,baseten,gemini').split(',').map(s => s.trim()).filter(Boolean);
const LABEL = { meta: 'Meta Model API', baseten: 'Muse Spark Open (Baseten)', gemini: 'Gemini' };
const notice = (t, m) => console.log(`::notice title=${t}::${String(m).replace(/\r?\n/g, ' ⏎ ').slice(0, 3500)}`);

function geminiGenerate() {
  const { GEMINI_API_KEY: key, GEMINI_MODEL: model } = process.env;
  return async (body, { signal } = {}) => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
}

/** One engine per configuration, or the reason it cannot run. */
function engineFor(config) {
  let providers;
  if (config === 'meta') {
    if (!process.env.META_API_KEY) return { skip: 'META_API_KEY not set' };
    providers = [E.createMetaProvider()];
  } else if (config === 'baseten') {
    if (!process.env.BASETEN_API_KEY) return { skip: 'BASETEN_API_KEY not set' };
    providers = [E.createBasetenProvider({ transcribeLanguages: '*' })];
  } else if (config === 'gemini') {
    if (!process.env.GEMINI_API_KEY || !process.env.GEMINI_MODEL) return { skip: 'GEMINI_API_KEY secret / GEMINI_MODEL variable not set' };
    providers = [E.fromGenerate(geminiGenerate(), { name: 'gemini' })];
  } else return { skip: `unknown configuration ${config}` };
  const router = E.createRouter({ providers, dailyLimit: { meta: 300, baseten: 300, gemini: 300 }, timeoutMs: { default: 180000 } });
  return { engine: E.createEngine({ router }) };
}

const baseContext = over => ({
  tenant: 't_eval', educator_ref: 'e_eval', institution_ref: 'i_eval', institution_type: 'school',
  country: 'IN', locale: 'en-IN', record_locale: 'en', timezone: 'Asia/Kolkata', date: '2026-10-28',
  captured_at: '2026-10-28T06:00:00Z', channel: 'api', ...over,
});

function inputs() {
  const list = [];
  for (const b of CASES.boards) {
    list.push({ id: b.id, kind: 'board', lang: 'en', truth: b.truth, evidence: [{ bytes: fs.readFileSync(path.join(DATA, 'boards', `${b.id}.jpg`)), media_type: 'image/jpeg' }], context: baseContext(b.context) });
  }
  for (const v of CASES.voices) {
    const f = path.join(DATA, 'voices', `${v.id}.ogg`);
    if (!fs.existsSync(f)) continue;
    list.push({ id: v.id, kind: 'voice', lang: v.lang.split('-')[0], truth: v.truth, evidence: [{ bytes: fs.readFileSync(f), media_type: 'audio/ogg' }], context: baseContext({ locale: v.lang.includes('-') ? v.lang : `${v.lang}-IN`, ...v.context }) });
  }
  return list;
}

async function runConfig(config, cases) {
  const { engine, skip } = engineFor(config);
  if (skip) return { config, skip };
  const rows = [];
  for (const c of cases) {
    const t0 = Date.now();
    let row;
    try {
      const r = await engine.process({ evidence: c.evidence, context: c.context });
      const b = r.capsule.body;
      const steps = b.provenance.steps.map(s => ({ step: s.step, provider: s.provider, model: s.model, status: s.status, ms: s.ms, tokens: s.tokens, cost_usd: s.cost_usd, error: s.attempts?.map(a => a.error).join('; ') }));
      row = { id: c.id, kind: c.kind, lang: c.lang, ok: true, decision: r.routing.decision, fields: scoreRecord(c.truth, b),
        got: { cohort: b.session.cohort, subject: b.session.subject, unit: b.session.unit, title: b.content.title, assignments: b.content.assignments.map(a => a.text) },
        steps, model_ms: steps.reduce((s, x) => s + (x.ms || 0), 0), wall_ms: Date.now() - t0,
        cost_usd: priceOf(steps),
        tokens: steps.reduce((a, x) => ({ input: a.input + (x.tokens?.input || 0), output: a.output + (x.tokens?.output || 0) }), { input: 0, output: 0 }) };
    } catch (e) {
      row = { id: c.id, kind: c.kind, lang: c.lang, ok: false, error: String(e.message).slice(0, 300), fields: Object.fromEntries(FIELDS.map(f => [f, false])), wall_ms: Date.now() - t0 };
    }
    rows.push(row);
    console.log(`[${config}] ${c.id}: ${row.ok ? `${row.decision} ${FIELDS.filter(f => row.fields[f]).length}/${FIELDS.length} ${row.wall_ms} ms` : `ERROR ${row.error}`}`);
  }
  return { config, rows };
}

/** Known cost of a record: only when it had served steps and every served step has a published price. */
function priceOf(steps) {
  const served = steps.filter(x => x.status !== 'failed' && x.status !== 'skipped');
  return served.length && served.every(x => x.cost_usd != null) ? served.reduce((s, x) => s + x.cost_usd, 0) : null;
}

const pct = (v, p) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] : null; };
const mean = v => { const s = v.filter(Number.isFinite); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const acc = (rows, f) => rows.length ? rows.filter(r => (f ? r.fields[f] : FIELDS.every(x => r.fields[x]))).length / rows.length : null;
const fieldAcc = rows => rows.length ? mean(rows.map(r => FIELDS.filter(f => r.fields[f]).length / FIELDS.length)) : null;

function summarise({ config, rows }) {
  const ok = rows.filter(r => r.ok);
  const priced = ok.filter(r => r.cost_usd != null);
  const errors = rows.filter(r => !r.ok);
  return {
    config, label: LABEL[config], n: rows.length, produced: ok.length,
    // Most cases failing on API errors measures the account, not the model: report it, compare nothing.
    comparable: errors.length <= rows.length / 2, first_error: errors[0]?.error || null,
    field_accuracy: fieldAcc(rows), by_field: Object.fromEntries(FIELDS.map(f => [f, acc(rows, f)])),
    boards: fieldAcc(rows.filter(r => r.kind === 'board')),
    voices_by_lang: Object.fromEntries([...new Set(rows.filter(r => r.kind === 'voice').map(r => r.lang))].map(l => [l, fieldAcc(rows.filter(r => r.kind === 'voice' && r.lang === l))])),
    decisions: ok.reduce((d, r) => ({ ...d, [r.decision]: (d[r.decision] || 0) + 1 }), {}),
    model_ms: { p50: pct(ok.map(r => r.model_ms), 50), mean: mean(ok.map(r => r.model_ms)), p95: pct(ok.map(r => r.model_ms), 95) },
    wall_ms: { p50: pct(ok.map(r => r.wall_ms), 50) },
    tokens_per_record: { input: mean(ok.map(r => r.tokens.input)), output: mean(ok.map(r => r.tokens.output)) },
    cost_per_record_usd: priced.length ? mean(priced.map(r => r.cost_usd)) : null, records_priced: priced.length, records_unpriced: ok.length - priced.length,
  };
}

const p100 = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
const secs = x => (x == null ? '—' : `${(x / 1000).toFixed(1)} s`);

function markdown(results, meta) {
  const all = results.filter(r => !r.skip).map(summarise);
  const run = all.filter(s => s.comparable);
  const cols = run.map(s => s.label);
  const row = (name, f) => `| ${name} | ${run.map(f).join(' | ')} |`;
  const langs = [...new Set(run.flatMap(s => Object.keys(s.voices_by_lang)))];
  const lines = [
    '# Evaluation results', '',
    `Run: ${meta.run_url || 'local'} · commit \`${meta.sha || 'local'}\` · ${meta.date}`, '',
    `**${meta.cases.boards} synthetic boards** (rendered from text: chalk, whiteboard, tilted, faded, cluttered) and **${meta.cases.voices} synthetic voice notes** (espeak-ng, OGG/Opus like WhatsApp) — no real classroom data. Ground truth in \`eval/cases.json\`; scoring rules in \`eval/score.js\`. Synthetic voices are robotic, so voice numbers understate what real recordings would give, and differently per language. Small sample: treat differences of one or two cases as noise.`, '',
    ...results.filter(r => r.skip).map(r => `- **${LABEL[r.config]}: not run** — ${r.skip}.`),
    ...all.filter(s => !s.comparable).map(s => `- **${s.label}: not comparable** — ${s.n - s.produced} of ${s.n} cases failed on the API, not on the model (first error: \`${(s.first_error || '').slice(0, 160)}\`). Its numbers are left out.`),
    results.some(r => r.skip) || all.some(s => !s.comparable) ? '' : null,
    `| | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`,
    row('Records produced', s => `${s.produced} / ${s.n}`),
    row('**Field accuracy (all cases)**', s => `**${p100(s.field_accuracy)}**`),
    ...['cohort', 'subject', 'unit', 'assignments', 'topics'].map(f => row(`— ${f === 'assignments' ? 'homework' : f}`, s => p100(s.by_field[f]))),
    row('Boards (field accuracy)', s => p100(s.boards)),
    ...langs.map(l => row(`Voice notes: ${l}`, s => p100(s.voices_by_lang[l]))),
    row('Latency per record, model time p50 / p95', s => `${secs(s.model_ms.p50)} / ${secs(s.model_ms.p95)}`),
    row('Tokens per record (in / out, incl. reasoning)', s => s.tokens_per_record.input == null ? '—' : `${Math.round(s.tokens_per_record.input)} / ${Math.round(s.tokens_per_record.output)}`),
    // A mean over a few priced records (e.g. only the held ones) is not the configuration's cost: say unknown.
    row('Cost per record', s => (s.cost_per_record_usd != null && s.records_priced >= s.produced / 2
      ? `$${s.cost_per_record_usd.toFixed(5)} (${s.records_priced} of ${s.produced} priced)`
      : `unknown — ${s.records_unpriced} of ${s.produced} records include a step with no published price`)),
    row('Routing: auto-lock / confirm / hold', s => `${s.decisions.auto_lock || 0} / ${s.decisions.confirm || 0} / ${s.decisions.hold || 0}`),
    '',
    '## Where each configuration was weaker', '',
    ...weaker(run), '',
    '## Per case', '',
    '<details><summary>Every case, every configuration</summary>', '',
    '| case | ' + shown(results, run).map(r => LABEL[r.config]).join(' | ') + ' |', '|---|' + shown(results, run).map(() => '---').join('|') + '|',
    ...(shown(results, run)[0]?.rows.map(c => `| ${c.id} | ${shown(results, run).map(r => cell(r.rows.find(x => x.id === c.id))).join(' | ')} |`) || []),
    '', '</details>', '',
  ].filter(x => x !== null);
  return lines.join('\n');
}

const shown = (results, run) => results.filter(r => !r.skip && run.some(s => s.config === r.config));

function cell(r) {
  if (!r) return '—';
  if (!r.ok) return `error: ${r.error.slice(0, 60)}`;
  const miss = FIELDS.filter(f => !r.fields[f]);
  return `${FIELDS.length - miss.length}/${FIELDS.length}${miss.length ? ` (missed ${miss.join(', ')})` : ''} · ${secs(r.model_ms)}`;
}

function weaker(run) {
  if (run.length < 2) return ['- Only one configuration ran; nothing to compare.'];
  const out = [];
  for (const f of [...FIELDS, 'boards']) {
    const get = s => (f === 'boards' ? s.boards : s.by_field[f]);
    const best = Math.max(...run.map(get));
    for (const s of run) if (get(s) != null && best - get(s) >= 0.1) out.push(`- **${s.label}** on ${f === 'assignments' ? 'homework' : f}: ${p100(get(s))} vs best ${p100(best)}.`);
  }
  for (const l of [...new Set(run.flatMap(s => Object.keys(s.voices_by_lang)))]) {
    const best = Math.max(...run.map(s => s.voices_by_lang[l] ?? 0));
    for (const s of run) if ((s.voices_by_lang[l] ?? 0) <= best - 0.1) out.push(`- **${s.label}** on ${l} voice notes: ${p100(s.voices_by_lang[l])} vs best ${p100(best)}.`);
  }
  const fastest = Math.min(...run.map(s => s.model_ms.p50 ?? Infinity));
  for (const s of run) if (s.model_ms.p50 > fastest * 1.5) out.push(`- **${s.label}** was slower: p50 ${secs(s.model_ms.p50)} vs ${secs(fastest)}.`);
  return out.length ? out : ['- No configuration trailed another by 10 points or more on any field.'];
}

(async () => {
  const cases = inputs();
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`${cases.length} cases (${cases.filter(c => c.kind === 'board').length} boards, ${cases.filter(c => c.kind === 'voice').length} voice notes); configurations: ${CONFIGS.join(', ')}`);
  const results = await Promise.all(CONFIGS.map(c => runConfig(c, cases)));
  const meta = {
    date: new Date().toISOString(), sha: process.env.GITHUB_SHA,
    run_url: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    cases: { boards: cases.filter(c => c.kind === 'board').length, voices: cases.filter(c => c.kind === 'voice').length },
  };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, summaries: results.filter(r => !r.skip).map(summarise), results }, null, 2));
  const md = markdown(results, meta);
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), md);
  console.log('\n' + md);
  for (const s of results.filter(r => !r.skip).map(summarise).filter(x => x.comparable)) notice(`${s.label}: ${p100(s.field_accuracy)} field accuracy`, `produced ${s.produced}/${s.n} · boards ${p100(s.boards)} · voices ${JSON.stringify(Object.fromEntries(Object.entries(s.voices_by_lang).map(([k, v]) => [k, p100(v)])))} · p50 ${secs(s.model_ms.p50)} · cost/record ${s.cost_per_record_usd ?? 'unknown'}`);
  for (const r of results.filter(r => r.skip)) notice(`${LABEL[r.config]}: not run`, r.skip);
  for (const s of results.filter(r => !r.skip).map(summarise).filter(x => !x.comparable)) notice(`${s.label}: not comparable`, `${s.n - s.produced}/${s.n} cases failed on the API: ${s.first_error}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
})();
