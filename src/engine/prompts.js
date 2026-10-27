'use strict';
// Prompts and strict output schemas for the read (structure) and check (verify) steps.
// Strict structured output needs every property required and additionalProperties:false,
// so "unknown" is an empty string or empty list here; the engine turns those into null.

const KINDS = ['period', 'lecture', 'lab', 'tutorial', 'batch', 'workshop', 'other'];
const CONFIDENCE_FIELDS = ['kind', 'label', 'cohort', 'subject', 'course', 'unit', 'title', 'topics', 'summary', 'method', 'assignments', 'next', 'materials'];
const CHECKED_FIELDS = ['session.cohort', 'session.subject', 'session.course', 'session.unit', 'session.label',
  'content.title', 'content.topics', 'content.summary', 'content.method', 'content.assignments', 'content.next', 'content.materials'];

const str = { type: 'string' };
const strList = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

const RECORD_SCHEMA = obj({
  relevant: { type: 'boolean' },
  session: obj({ kind: { type: 'string', enum: KINDS }, label: str, cohort: str, subject: str, course: str, unit: str }),
  content: obj({
    title: str, topics: strList, summary: str, method: str,
    assignments: { type: 'array', items: obj({ text: str, due: str }) },
    next: str, materials: strList, notes: str,
  }),
  confidence: obj(Object.fromEntries(CONFIDENCE_FIELDS.map(f => [f, { type: 'number' }]))),
});

const CHECK_SCHEMA = obj({
  checks: {
    type: 'array',
    items: obj({
      field: { type: 'string', enum: CHECKED_FIELDS },
      verdict: { type: 'string', enum: ['supported', 'unsupported', 'contradicted'] },
      detail: str,
    }),
  },
});

const VOCAB = {
  school: 'a school teacher; sessions are periods; cohort is class and section (e.g. "8B", "10-A")',
  college: 'a college lecturer; sessions are lectures or labs; cohort is year/section; course is the paper or course code',
  university: 'a university lecturer or professor; sessions are lectures, labs or tutorials; course is the course code and name (e.g. "CS201 Data Structures"); cohort is the year group or section if stated',
  academy: 'a tutor or coaching-centre educator; sessions are batches or tutorials; cohort is the batch name',
  training: 'a corporate or vocational trainer; sessions are workshops; course is the programme; unit is the module',
  independent: 'an independent educator; sessions may be any kind',
};

function readPrompt(ctx) {
  return [
    'You turn raw classroom evidence into one structured teaching record (the .tdx record body).',
    `The educator is ${VOCAB[ctx.institutionType] || VOCAB.independent}.`,
    `Write every text field in ${ctx.recordLanguage}, whatever language the evidence is in. Keep codes, formulas and exercise numbers exactly as written.`,
    'Rules:',
    '- subject is the discipline (e.g. "Mathematics", "Physics", "English"), never the chapter. The chapter, unit or topic heading goes in unit (e.g. subject "Mathematics", unit "Fractions").',
    '- topics: 1–5 short topic names actually taught. title: one short line naming the lesson. summary: 1–2 plain sentences of what was taught. method: how it was taught, only if the evidence shows it.',
    '- assignments: homework or tasks given ("HW", "home work", "assignment", "exercise for tomorrow"); due as YYYY-MM-DD only if a date is stated, else "".',
    '- next: what the educator says comes next, only if stated. materials: textbook pages, worksheets, apparatus, only if stated.',
    '- Use "" or [] for anything the evidence does not show. Never invent cohorts, exercise numbers or pages.',
    '- confidence: for each field, 0–1, how sure you are that the value is right given the evidence (1 = clearly written or said; 0.5 = inferred; 0 = no value). For empty fields give 0.',
    '- relevant: false if the evidence is not about a teaching session at all (a selfie, a meme, an unrelated chat).',
    '- When a "known session" value is given below, it came from the educator and is correct.',
  ].join('\n');
}

function checkPrompt(ctx) {
  return [
    'You are the verification step of a teaching-record pipeline. A draft record was produced from the evidence below.',
    'Cross-examine each non-empty field of the draft against the evidence only (images, transcripts, the educator\'s text, and known session values).',
    'For each non-empty field return one check:',
    '- "supported": the evidence shows this value.',
    '- "unsupported": the evidence neither shows nor contradicts it (it was inferred or guessed).',
    '- "contradicted": the evidence shows a different value (say which in detail, e.g. "board says 8C").',
    'Be strict about cohorts, exercise numbers, page numbers and dates. Keep detail under 20 words, in English.',
    `The record language is ${ctx.recordLanguage}; a translation of evidence into that language counts as supported.`,
  ].join('\n');
}

/** The evidence part of a prompt (shared by read and check). */
function evidenceText({ date, label, known, usual, texts, transcripts, imageNotes }) {
  const lines = [`Session date: ${date}.`];
  if (label) lines.push(`Session hint from the educator: "${label}".`);
  const k = Object.entries(known || {}).filter(([, v]) => v);
  if (k.length) lines.push('Known session values (from the educator): ' + k.map(([f, v]) => `${f} = "${v}"`).join(', ') + '.');
  if (usual?.length) lines.push('The educator usually teaches: ' + usual.map(u => [u.label, u.cohort, u.subject, u.course].filter(Boolean).join(' ')).join('; ') + '. Prefer these spellings when the evidence matches one.');
  imageNotes.forEach(n => lines.push(n));
  transcripts.forEach((t, i) => lines.push(`Voice note ${i + 1} transcript (${t.language || 'unknown language'}): """${t.text}"""`));
  texts.forEach((t, i) => lines.push(`Educator's message ${i + 1}: """${t}"""`));
  if (!imageNotes.length && !transcripts.length && !texts.length) lines.push('(no evidence content)');
  return lines.join('\n');
}

module.exports = { RECORD_SCHEMA, CHECK_SCHEMA, KINDS, CONFIDENCE_FIELDS, CHECKED_FIELDS, readPrompt, checkPrompt, evidenceText };
