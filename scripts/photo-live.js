'use strict';
// Live photo pipeline on Meta's models, on the synthetic board only (never educator data):
//
//   SAM 3.1 board box → crop (ffmpeg) → Muse Spark structured read → Muse Spark check
//   → score/route → draft .tdx 2.0 capsule → (if the policy allows) signed with a throwaway key → verified
//
// Meta only: no fallback provider, so a Meta failure shows as a failure. Results go to GitHub
// annotations, the step summary, and out/ (uploaded as a workflow artifact).
//
// Env: META_API_KEY (required). OUT_DIR (default ./out).
const fs = require('node:fs');
const path = require('node:path');
const tdx = require('../src/tdx');
const { createRecordEngine, media } = require('../src/engine');
const packs = require('../src/packs');

const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'out');
const BOARD = fs.readFileSync(path.join(__dirname, '../test/fixtures/board-synthetic.jpg'));
const clean = s => String(s).replace(/\r?\n/g, ' ⏎ ').replace(/%/g, '%25');
const notice = (title, msg) => console.log(`::notice title=${clean(title)}::${clean(msg).slice(0, 4000)}`);
const error = (title, msg) => console.log(`::error title=${clean(title)}::${clean(msg).slice(0, 4000)}`);

(async () => {
  if (!process.env.META_API_KEY) { error('META_API_KEY missing', 'Add the META_API_KEY repository secret (Settings → Secrets and variables → Actions).'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  notice('ffmpeg', media.hasFfmpeg() ? 'available — the board will be cropped' : 'missing — the whole photo will be read with the board region as a hint');

  const engine = createRecordEngine({ fallback: [], dailyLimit: { meta: 12 }, timeoutMs: { default: 120000 } });
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const t0 = Date.now();
  let r;
  try {
    r = await engine.process({
      evidence: [{ bytes: BOARD, media_type: 'image/jpeg' }],
      context: { tenant: 't_demo', educator_ref: 'e_demo', institution_ref: 'i_demo', institution_type: 'school', country: 'IN', locale: 'en-IN', date, channel: 'api' },
    });
  } catch (e) {
    error('Pipeline failed', `${e.message}${e.attempts ? ' | ' + JSON.stringify(e.attempts) : ''}`);
    process.exit(1);
  }
  const total = Date.now() - t0;
  const b = r.capsule.body;

  for (const s of r.steps) {
    notice(`${s.step}: ${s.provider}/${s.model || '-'} ${s.status}`, `${s.ms ?? '-'} ms; tokens ${s.tokens ? `${s.tokens.input} in / ${s.tokens.output} out` : 'n/a'}; cost ${s.cost_usd ?? 'unknown'}${s.attempts ? ` | attempts ${JSON.stringify(s.attempts)}` : ''}`);
  }
  const box = b.evidence_findings.find(f => f.finding === 'board_region');
  notice('Board found (SAM 3.1)', box ? `normalised box [x1, y1, x2, y2] = ${JSON.stringify(box.box)}; drawn board is about [0.109, 0.125, 0.891, 0.792]` : 'no board box');
  if (r.derived[0]) {
    fs.writeFileSync(path.join(OUT, 'board-crop.jpg'), r.derived[0].bytes);
    notice('Crop', `${r.derived[0].bytes.length} bytes, ${r.derived[0].sha256}`);
  }
  notice('Record', `cohort ${b.session.cohort} · subject ${b.session.subject} · unit ${b.session.unit} · title "${b.content.title}" · topics ${JSON.stringify(b.content.topics)} · homework ${JSON.stringify(b.content.assignments.map(a => a.text))}`);
  notice('Field confidence', JSON.stringify(b.provenance.field_confidence));
  notice(`Routing: ${r.routing.decision}`, `${r.routing.reasons.join('; ') || 'every field meets the school_compliance policy'} | flags ${JSON.stringify(r.flags)} | "${packs.describe(r).status}"`);

  // Sign it the way the API would — only if the policy lets it lock without a person.
  const key = tdx.generateKey(`k_photo_live_${Date.now()}`);
  const registry = { keys: [key.publicEntry] };
  let signed = null;
  if (r.routing.decision === 'auto_lock') {
    signed = tdx.lock(r.capsule, { key, state: 'auto_locked', attestation: { policy_profile: r.routing.policy_profile, policy_version: r.routing.policy_version, auto_accepted_fields: r.routing.auto_accepted_fields } });
    const v = tdx.verifyCapsule(signed, registry);
    notice(`Signed and verified: ${v.ok}`, `capsule ${signed.capsule_id} · hash ${v.hash} · key ${key.keyId} (throwaway)`);
    fs.writeFileSync(path.join(OUT, 'capsule-signed.json'), JSON.stringify(signed, null, 2));
    fs.writeFileSync(path.join(OUT, 'keys.json'), JSON.stringify(registry, null, 2));
  } else {
    notice('Not signed', `routing is ${r.routing.decision}: the educator must confirm ${r.routing.confirm_fields.join(', ') || '(see reasons)'} first`);
  }
  const schema = tdx.validateCapsule(r.capsule);
  notice(`Draft capsule valid against schema: ${schema.ok}`, `${r.capsule.capsule_id} · total ${total} ms`);
  fs.writeFileSync(path.join(OUT, 'capsule-draft.json'), JSON.stringify(r.capsule, null, 2));

  const summary = [
    '## Photo pipeline on Meta — live run (synthetic board)', '',
    `**${b.session.cohort} · ${b.session.subject} · ${b.session.unit}** — ${b.content.title}  `,
    `Homework: ${b.content.assignments.map(a => a.text).join('; ') || '—'} · routing **${r.routing.decision}** · overall confidence ${b.provenance.overall_confidence} · ${total} ms`, '',
    '| step | provider | model | status | ms | tokens in / out | cost USD |', '|---|---|---|---|---|---|---|',
    ...r.steps.map(s => `| ${s.step} | ${s.provider} | ${s.model || ''} | ${s.status} | ${s.ms ?? ''} | ${s.tokens ? `${s.tokens.input} / ${s.tokens.output}` : ''} | ${s.cost_usd ?? 'unknown'} |`), '',
    `Board box (SAM 3.1): \`${JSON.stringify(box?.box)}\` · signed: ${signed ? `yes (\`${signed.capsule_id}\`)` : 'no'}`, '',
    '<details><summary>Draft capsule</summary>', '', '```json', JSON.stringify(r.capsule, null, 2), '```', '</details>', '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else console.log(summary);
  if (!schema.ok || r.steps.some(s => s.step === 'read' && s.provider !== 'meta')) process.exit(1);
})();
