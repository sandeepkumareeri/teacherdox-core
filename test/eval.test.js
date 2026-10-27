'use strict';
// The eval scoring rules (eval/score.js) — written down and pinned, so published numbers can be re-derived.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreRecord } = require('../eval/score');
const cases = require('../eval/cases.json');

const rec = (session, content) => ({ session, content: { topics: [], assignments: [], ...content } });

test('cohort: normalised exact match; null truth needs an empty cohort', () => {
  const t = { cohort: '8B', subject: 'Mathematics', unit: 'Fractions', assignments: [], topics: ['fraction'] };
  assert.equal(scoreRecord(t, rec({ cohort: 'Class 8-B' })).cohort, true);
  assert.equal(scoreRecord(t, rec({ cohort: '8C' })).cohort, false);
  assert.equal(scoreRecord({ ...t, cohort: null }, rec({ cohort: 'Year 2' })).cohort, false);
});

test('subject: spelling aliases only — Maths = Mathematics, Biology ≠ Science', () => {
  const t = { cohort: null, subject: 'Mathematics', unit: 'x', assignments: [], topics: [] };
  assert.equal(scoreRecord(t, rec({ subject: 'Maths' })).subject, true);
  assert.equal(scoreRecord({ ...t, subject: 'Science' }, rec({ subject: 'Biology' })).subject, false);
});

test('homework: every marker present; no homework means none recorded', () => {
  const t = { cohort: null, subject: 'x', unit: 'x', assignments: ['3.2'], topics: [] };
  assert.equal(scoreRecord(t, rec({}, { assignments: [{ text: 'Ex 3.2 Q1-5' }] })).assignments, true);
  assert.equal(scoreRecord(t, rec({}, { assignments: [{ text: 'Ex 3.3' }] })).assignments, false);
  assert.equal(scoreRecord({ ...t, assignments: [] }, rec({}, { assignments: [{ text: 'Revise' }] })).assignments, false);
});

test('topics: a short keyword never matches by accident', () => {
  const t = { cohort: null, subject: 'x', unit: 'x', assignments: [], topics: ['lcm'] };
  assert.equal(scoreRecord(t, rec({}, { title: 'Numbers' })).topics, false);
  assert.equal(scoreRecord(t, rec({}, { topics: ['LCM'] })).topics, true);
});

test('every case has complete ground truth', () => {
  for (const c of [...cases.boards, ...cases.voices]) {
    for (const k of ['cohort', 'subject', 'unit', 'assignments', 'topics']) assert.ok(k in c.truth, `${c.id}.${k}`);
    assert.ok(c.truth.topics.length > 0, c.id);
  }
});
