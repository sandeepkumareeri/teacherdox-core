'use strict';
// The Record Engine: raw classroom evidence → a draft .tdx 2.0 capsule.
//
//   locate  (segment)    each photo: find the board, crop to it
//   listen  (transcribe) each voice note → text, in the educator's language
//   read    (structure)  crops + transcripts + text + context → record fields with confidence
//   check   (verify)     a second pass cross-examines each field against the evidence
//   score                field classes × policy → auto_lock | confirm | hold
//
// Every model call goes through the capability router, so each step records which
// provider and model did the work, how long it took and what it cost. locate and listen
// run in parallel; a failed locate falls back to the whole photo, a failed check means
// the record cannot be auto-locked. Raw evidence bytes and transcripts never enter the
// capsule — only content hashes.

const tdx = require('../tdx');
const media = require('./media');
const P = require('./prompts');
const { route } = require('./score');
const packs = require('../packs');

const PIPELINE_VERSION = 'core-0.2';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isImage = e => /^image\//.test(e.media_type);
const isAudio = e => /^audio\//.test(e.media_type);
const blank = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const clamp01 = x => (Number.isFinite(x) ? Math.min(1, Math.max(0, Math.round(x * 1000) / 1000)) : 0);
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);

/**
 * createEngine({ router, policy, boardQueries, cropMinArea, now })
 *   router:       from createRouter (providers in priority order)
 *   policy:       default policy profile name or object (score.js / packs)
 *   boardQueries: SAM text prompts tried in order until one finds a box
 */
function createEngine({ router, policy = 'school_compliance', boardQueries = ['chalkboard', 'whiteboard'], cropMinArea = 0.08, now = () => new Date() } = {}) {
  if (!router) throw new Error('createEngine: router required');

  /**
   * evidence: [{ bytes, media_type, role? }]   (photos, voice notes)
   * text:     string or [string]              (what the educator typed)
   * context:  {
   *   tenant, educator_ref, institution_ref, institution_type, locale, record_locale, country,
   *   timezone, date, channel, captured_at, session: { kind?, label?, cohort?, subject?, course? },
   *   usual: [{ label, cohort, subject, course }], allow_providers: ['meta','gemini'], policy
   * }
   * → { capsule, routing, transcripts, derived, steps, flags }
   */
  async function processEvidence({ evidence = [], text = [], context }) {
    const ctx = normalizeContext(context);
    const pol = typeof (ctx.policy || policy) === 'string' ? packs.policy(ctx.policy || policy) : (ctx.policy || policy);
    const inst = packs.institution(ctx.institution_type);
    const allow = ctx.allow_providers;
    const texts = [].concat(text || []).map(t => String(t).trim()).filter(Boolean);
    const items = evidence.map(e => ({ ...e, bytes: Buffer.from(e.bytes), id: tdx.sha256(Buffer.from(e.bytes)) }));
    const steps = [], findings = [], derived = [];

    // ── locate + listen, in parallel ──────────────────────────────────────────────
    const locate = items.filter(isImage).map(async img => {
      let best = null;
      for (const query of pol.steps?.locate === false ? [] : boardQueries) {
        try {
          const r = await router.run('segment', { image: img, query }, { allow, step: 'locate', evidence: img.id });
          steps.push(r.step);
          best = largest(r.output.boxes);
          if (best) break;
        } catch (e) {
          steps.push(failedStep('locate', 'segment', e, img.id));
          break;
        }
      }
      const out = { img, box: best, crop: null };
      if (best) {
        findings.push({ evidence: img.id, step: 'locate', finding: 'board_region', box: normBox(best) });
        const area = ((best.x2 - best.x1) * (best.y2 - best.y1)) / (best.width * best.height);
        if (area >= cropMinArea && area < 0.97 && media.hasFfmpeg()) {
          try {
            out.crop = { bytes: await media.cropImage(img.bytes, best), media_type: 'image/jpeg' };
            derived.push({ evidence: img.id, kind: 'board_crop', media_type: 'image/jpeg', bytes: out.crop.bytes, sha256: tdx.sha256(out.crop.bytes) });
          } catch { /* read the whole photo with the region as a hint */ }
        }
      }
      return out;
    });
    const listen = items.filter(isAudio).map(async a => {
      try {
        const r = await router.run('transcribe', { audio: a, language: ctx.locale }, { allow, step: 'listen', evidence: a.id });
        steps.push(r.step);
        const t = { evidence: a.id, language: r.output.language || primary(ctx.locale), text: r.output.text, duration_ms: r.output.duration_ms };
        findings.push({ evidence: a.id, step: 'listen', finding: t.text ? 'transcript' : 'no_speech', language: t.language, text_ref: t.text ? tdx.sha256(t.text) : null });
        if (t.duration_ms != null) a.duration_s = Math.round(t.duration_ms / 100) / 10;
        return t;
      } catch (e) {
        steps.push(failedStep('listen', 'transcribe', e, a.id));
        findings.push({ evidence: a.id, step: 'listen', finding: 'not_transcribed' });
        return null;
      }
    });
    const located = await Promise.all(locate);
    const transcripts = (await Promise.all(listen)).filter(t => t && t.text);

    // ── read ─────────────────────────────────────────────────────────────────────
    const images = [], imageNotes = [];
    located.forEach(({ img, box, crop }, i) => {
      if (crop) { images.push(crop); imageNotes.push(`Image ${images.length}: photo ${i + 1}, cropped to the board.`); }
      else {
        images.push({ bytes: img.bytes, media_type: img.media_type });
        imageNotes.push(`Image ${images.length}: photo ${i + 1}${box ? `; the board is at x ${Math.round(normBox(box)[0] * 100)}–${Math.round(normBox(box)[2] * 100)}%, y ${Math.round(normBox(box)[1] * 100)}–${Math.round(normBox(box)[3] * 100)}% of the image` : ''}.`);
      }
    });
    const known = { label: ctx.session.label, cohort: ctx.session.cohort, subject: ctx.session.subject, course: ctx.session.course };
    const evText = P.evidenceText({ date: ctx.date, label: ctx.session.label, known, usual: ctx.usual, texts, transcripts, imageNotes });
    const pctx = { institutionType: ctx.institution_type, recordLanguage: languageName(ctx.record_locale) };

    // Nothing usable (e.g. the only voice note could not be transcribed): no model is asked
    // to invent a record from nothing — the draft is held for the educator.
    const usable = images.length || transcripts.length || texts.length;
    let rec;
    if (usable) {
      const read = await router.run('structure', { instructions: P.readPrompt(pctx), text: evText, images, schema: P.RECORD_SCHEMA, schemaName: 'tdx_record' }, { allow, step: 'read' });
      steps.push(read.step);
      rec = cleanRecord(read.output, ctx);
    } else {
      steps.push({ step: 'read', capability: 'structure', provider: 'none', model: null, status: 'skipped', ms: null, cost_usd: null, tokens: null });
      rec = cleanRecord({ relevant: false }, ctx);
    }

    // ── check ────────────────────────────────────────────────────────────────────
    const flags = [];
    let checkRan = false;
    const draftView = JSON.stringify({ session: rec.session, content: rec.content });
    if (usable && pol.steps?.check !== false) try {
      const chk = await router.run('verify', { instructions: P.checkPrompt(pctx), text: `${evText}\n\nDraft record:\n${draftView}`, images, schema: P.CHECK_SCHEMA, schemaName: 'tdx_check' }, { allow, step: 'check' });
      steps.push(chk.step);
      checkRan = true;
      for (const c of chk.output.checks || []) {
        if (!(c.field in rec.confidence) || !present(fieldValue(rec, c.field)) || fromEducator(c.field, known)) continue;
        if (c.verdict === 'contradicted') { rec.confidence[c.field] = Math.min(rec.confidence[c.field], 0.2); flags.push({ field: c.field, issue: 'contradicted', detail: String(c.detail || '').slice(0, 200) }); }
        else if (c.verdict === 'unsupported') { rec.confidence[c.field] = Math.min(rec.confidence[c.field], 0.5); flags.push({ field: c.field, issue: 'unsupported', detail: String(c.detail || '').slice(0, 200) }); }
      }
    } catch (e) {
      steps.push(failedStep('check', 'verify', e));
    }

    // ── score ────────────────────────────────────────────────────────────────────
    const values = {
      ...Object.fromEntries(['label', 'cohort', 'subject', 'course', 'unit'].map(k => [`session.${k}`, rec.session[k]])),
      ...Object.fromEntries(Object.entries(rec.content).map(([k, v]) => [`content.${k}`, v])),
    };
    const capturedAt = ctx.captured_at || now().toISOString();
    const routing = route({ values, confidence: rec.confidence, flags, relevant: rec.relevant, usable: !!usable, checkRan, lagDays: lagDays(ctx.date, capturedAt, ctx.timezone), institutionType: ctx.institution_type, policy: pol });
    const field_confidence = Object.fromEntries(Object.entries(rec.confidence).filter(([f]) => present(values[f])));

    // ── draft capsule ────────────────────────────────────────────────────────────
    const body = {
      ...(UUIDV7.test(String(ctx.entry_id || '')) ? { entry_id: ctx.entry_id } : {}),   // a queue pre-assigns it so a retried job is idempotent
      tenant: ctx.tenant,
      actor: { educator_ref: ctx.educator_ref, institution_ref: ctx.institution_ref, institution_type: ctx.institution_type },
      locale: ctx.locale, record_locale: ctx.record_locale, country: ctx.country,
      session: {
        kind: ctx.session.kind || (inst.session_kinds.includes(rec.kind) ? rec.kind : inst.default_kind),
        date: ctx.date, ...(ctx.session.starts_at ? { starts_at: ctx.session.starts_at } : {}), timezone: ctx.timezone,
        label: rec.session.label, cohort: rec.session.cohort, subject: rec.session.subject, course: rec.session.course, unit: rec.session.unit,
        ...(ctx.session.duration_min ? { duration_min: ctx.session.duration_min } : {}),
      },
      source: {
        channel: ctx.channel,
        capture_methods: [...new Set([...items.map(e => isImage(e) ? 'photo' : isAudio(e) ? 'voice' : 'document'), ...(texts.length ? ['text'] : [])])],
        captured_at: capturedAt,
      },
      evidence: items.map(e => ({ id: e.id, media_type: e.media_type, bytes: e.bytes.length, role: e.role || (isImage(e) ? 'board' : isAudio(e) ? 'voice_note' : 'document'), ...(e.duration_s != null ? { duration_s: e.duration_s } : {}) })),
      evidence_findings: findings,
      content: rec.content,
      curriculum: { framework: null, tags: [] },
      provenance: {
        pipeline_version: PIPELINE_VERSION,
        steps: [...steps.filter(s => s.step === 'locate'), ...steps.filter(s => s.step === 'listen'), ...steps.filter(s => s.step === 'read'), ...steps.filter(s => s.step === 'check')],
        fallback_used: steps.some(s => s.status === 'fallback'),
        overall_confidence: routing.overall_confidence,
        field_confidence,
        flags,
        routing: { decision: routing.decision, policy_profile: routing.policy_profile, policy_version: routing.policy_version, auto_accepted_fields: routing.auto_accepted_fields, confirm_fields: routing.confirm_fields, reasons: routing.reasons },
      },
      amendment: null,
      ext: {},
    };
    const capsule = tdx.draft(body);
    const v = tdx.validateCapsule(capsule);
    if (!v.ok) throw new Error(`engine produced an invalid capsule: ${v.errors.slice(0, 5).join('; ')}`);
    return { capsule, routing, transcripts, derived, steps: capsule.body.provenance.steps, flags };
  }

  return { process: processEvidence, PIPELINE_VERSION };
}

/** Fill defaults from the country pack: its only (or default) time zone and record language. */
function normalizeContext(c = {}) {
  const country = packs.country(c.country);
  const timezone = c.timezone || country?.default_timezone || (country?.timezones?.length === 1 ? country.timezones[0] : null);
  for (const k of ['tenant', 'educator_ref', 'institution_ref', 'institution_type', 'date']) {
    if (!c[k]) throw new Error(`engine: context.${k} is required`);
  }
  if (!timezone) throw new Error(`engine: context.timezone is required${country ? ` (${country.name} has several)` : ''}`);
  return {
    locale: country?.locales?.[0] || 'en', channel: 'api', usual: [], session: {},
    ...c,
    country: c.country ? String(c.country).toUpperCase() : undefined,
    timezone,
    record_locale: c.record_locale || country?.default_record_locale || 'en',
    session: { ...(c.session || {}) },
    allow_providers: c.allow_providers || undefined,
  };
}

/** Model output → clean record: "" → null, filtered lists, dotted confidence keys; educator-known values win. */
function cleanRecord(o = {}, ctx) {
  const s = o.session || {}, c = o.content || {}, conf = o.confidence || {};
  const known = ctx.session;
  const session = {};
  const confidence = {};
  for (const k of ['label', 'cohort', 'subject', 'course', 'unit']) {
    const fromCtx = blank(known[k]);
    session[k] = fromCtx || blank(s[k]);
    confidence[`session.${k}`] = fromCtx ? 1 : session[k] ? clamp01(conf[k]) : 0;
  }
  const list = a => (Array.isArray(a) ? a.map(blank).filter(Boolean) : []);
  const content = {
    title: blank(c.title), topics: list(c.topics).slice(0, 8), summary: blank(c.summary), method: blank(c.method),
    assignments: (Array.isArray(c.assignments) ? c.assignments : []).map(a => ({ text: blank(a?.text), due: validDate(a?.due) ? a.due : null })).filter(a => a.text),
    next: blank(c.next), materials: list(c.materials), notes: blank(c.notes),
  };
  for (const k of ['title', 'topics', 'summary', 'method', 'assignments', 'next', 'materials']) confidence[`content.${k}`] = clamp01(conf[k]);
  return { relevant: o.relevant !== false, kind: P.KINDS.includes(s.kind) ? s.kind : null, session, content, confidence };
}

const present = v => (Array.isArray(v) ? v.length > 0 : v != null);
const fieldValue = (rec, field) => { const [g, k] = field.split('.'); return g === 'session' ? rec.session[k] : rec.content[k]; };
const fromEducator = (field, known) => field.startsWith('session.') && !!blank(known[field.slice(8)]);
/** English name of a language for prompts ("Portuguese (Brazil)"), from its locale pack. */
const languageName = tag => (packs.locale(tag)?.locale.split('-')[0] === primary(tag) ? packs.locale(tag).name : tag);

/** Whole days between the session date and the local date the evidence was captured. */
function lagDays(date, capturedAt, timezone) {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(capturedAt));
  return Math.round((Date.parse(local) - Date.parse(date)) / 86400000);
}

const primary = l => String(l || '').toLowerCase().split('-')[0];
const largest = boxes => (boxes || []).reduce((b, x) => (!b || (x.x2 - x.x1) * (x.y2 - x.y1) > (b.x2 - b.x1) * (b.y2 - b.y1) ? x : b), null);
const normBox = b => [b.x1 / b.width, b.y1 / b.height, b.x2 / b.width, b.y2 / b.height].map(x => Math.round(Math.min(1, Math.max(0, x)) * 10000) / 10000);

function failedStep(step, capability, e, evidence) {
  return {
    step, capability, provider: 'none', model: null, status: 'failed', ms: null, cost_usd: null, tokens: null,
    ...(evidence ? { evidence } : {}),
    attempts: e.attempts || [{ provider: 'none', error: String(e.message || e).slice(0, 300) }],
  };
}

module.exports = { createEngine, PIPELINE_VERSION, cleanRecord };
