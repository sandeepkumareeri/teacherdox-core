'use strict';
// Field scoring for the eval harness. Deliberately simple and written down, so anyone can
// re-score the raw results:
//
//   cohort       normalised exact match ("Class 8-B" = "8B"); when the truth is null, correct only if empty
//   subject      exact discipline, with spelling aliases only (Maths = Mathematics); Biology ≠ Science
//   unit         a significant word of the true unit appears in the predicted unit or title
//   assignments  every true marker ("3.2", "52", "lab 6") appears in the predicted homework text;
//                when there is no homework, correct only if none was recorded
//   topics       a true keyword appears in topics, title or summary
//
// A field the engine left empty counts as wrong, except where the truth is empty. A record with no content
// at all (held: nothing read or heard) scores zero on every field.

const ALIASES = [
  ['mathematics', 'maths', 'math'],
  ['computer science', 'computing', 'cs'],
  ['english', 'english language', 'english grammar'],
];
const FIELDS = ['cohort', 'subject', 'unit', 'assignments', 'topics'];

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.]+/g, ' ').trim();
const cohortKey = s => norm(s).replace(/\b(class|std|standard|grade|turma|kelas|classe|commerce|science|arts)\b/g, '').replace(/[^a-z0-9]/g, '').toUpperCase();
const subjectKey = s => { const n = norm(s); const g = ALIASES.find(a => a.includes(n)); return g ? g[0] : n; };
const stem = w => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
const words = s => norm(s).split(' ').filter(w => w.length >= 4).map(stem);

function scoreRecord(truth, rec) {
  const s = rec?.session || {}, c = rec?.content || {};
  const hw = (c.assignments || []).map(a => a.text).join(' ; ');
  const text = norm([c.title, ...(c.topics || []), c.summary, s.unit].join(' '));
  const unitText = norm([s.unit, c.title].join(' '));
  const out = {};
  // A held record with no content (nothing could be read or heard) gets no credit — not even for "no homework".
  if (!s.subject && !s.unit && !s.cohort && !c.title) return Object.fromEntries(FIELDS.map(f => [f, false]));
  out.cohort = truth.cohort == null ? !s.cohort : !!s.cohort && cohortKey(s.cohort) === cohortKey(truth.cohort);
  out.subject = !!s.subject && subjectKey(s.subject) === subjectKey(truth.subject);
  out.unit = words(truth.unit).some(w => words(unitText).includes(w) || unitText.includes(w));
  out.assignments = truth.assignments.length === 0 ? (c.assignments || []).length === 0
    : !!hw && truth.assignments.every(m => norm(hw).includes(norm(m)));
  out.topics = truth.topics.some(k => text.includes(norm(k)) || (words(k).length > 0 && words(k).every(w => text.includes(w))));
  return out;
}

module.exports = { scoreRecord, FIELDS, cohortKey, subjectKey };
