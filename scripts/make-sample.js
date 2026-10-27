'use strict';
// Builds the verifier page's sample: one synthetic school day (three periods, one
// correction, a day seal and the headmaster's countersignature), signed with a demo key
// made just for this and thrown away — only its public half is written. The records are
// marked as samples in `ext`; they were not produced by a live model run.
//
//   node scripts/make-sample.js   → verifier/samples/day-demo.json, verifier/samples/keys-demo.json

const fs = require('node:fs');
const path = require('node:path');
const tdx = require('../src/tdx');

const OUT = path.join(__dirname, '../verifier/samples');
const key = tdx.generateKey('k_demo_sample', { validFrom: '2026-10-01T00:00:00Z' });
const DATE = '2026-10-28';

const step = (s, capability, model) => ({ step: s, capability, provider: 'meta', model, status: 'ok' });
const STEPS = [step('locate', 'segment', 'sam-3.1'), step('listen', 'transcribe', 'muse-voice-transcribe-1.0'), step('read', 'structure', 'muse-spark-1.3'), step('check', 'check', 'muse-spark-1.3')];

const periods = [
  { label: 'P2', cohort: '8B', subject: 'Mathematics', unit: 'Fractions', title: 'Adding fractions with unlike denominators', topics: ['Fractions', 'LCM'], hw: 'Ex 3.2 Q1-5', at: '04:52:05' },
  { label: 'P4', cohort: '9A', subject: 'Mathematics', unit: 'Linear equations', title: 'Solving equations in one variable', topics: ['Linear equations'], hw: 'Ex 2.1 Q1-4', at: '06:40:12' },
  { label: 'P6', cohort: '8B', subject: 'Science', unit: 'Force and pressure', title: 'Pressure exerted by liquids', topics: ['Pressure', 'Liquids'], hw: null, at: '08:31:40' },
];

const body = p => ({
  tenant: 't_demo', locale: 'ml-IN', record_locale: 'en', country: 'IN',
  actor: { educator_ref: 'e_demo_teacher', institution_ref: 'i_demo_school', institution_type: 'school' },
  session: { kind: 'period', date: DATE, timezone: 'Asia/Kolkata', label: p.label, cohort: p.cohort, subject: p.subject, unit: p.unit },
  source: { channel: 'whatsapp', capture_methods: ['photo', 'voice'], captured_at: `${DATE}T${p.at}Z` },
  evidence: [{ id: tdx.sha256(`sample board ${p.label}`), media_type: 'image/jpeg', role: 'board' }, { id: tdx.sha256(`sample voice ${p.label}`), media_type: 'audio/ogg', role: 'voice_note' }],
  content: { title: p.title, topics: p.topics, assignments: p.hw ? [{ text: p.hw, due: null }] : [] },
  provenance: { pipeline_version: 'core-0.2', steps: STEPS, fallback_used: false, overall_confidence: 0.93, field_confidence: { 'session.cohort': 0.97, 'session.subject': 0.96 } },
  ext: { 'org.teacherdox.sample': 'synthetic demo record; not produced by a live model run' },
});

const capsules = [];
periods.forEach((p, i) => {
  const d = tdx.draft(body(p));
  capsules.push(tdx.lock(d, {
    key, prev: capsules[capsules.length - 1] || null, state: 'confirmed_locked', signedAt: `${DATE}T11:0${i}:00Z`,
    attestation: { policy_profile: 'school_compliance', policy_version: '1', confirmed_fields: [], confirmation: { by: 'e_demo_teacher', at: `${DATE}T11:00:00Z`, channel: 'whatsapp' } },
  }));
});
capsules.push(tdx.amend(capsules[1], { content: { assignments: [{ text: 'Ex 2.1 Q1-6', due: null }] } }, {
  key, prev: capsules[capsules.length - 1], reason: 'Homework was questions 1 to 6', amendedFields: ['content.assignments'], amenderRef: 'e_demo_teacher', signedAt: `${DATE}T11:20:00Z`,
  attestation: { confirmation: { by: 'e_demo_teacher', at: `${DATE}T11:20:00Z`, channel: 'whatsapp' } },
}));
const seal = tdx.sealDay({ scope: tdx.chainScope(capsules[0]), hashes: capsules.map(tdx.capsuleHash), key, sealedAt: `${DATE}T11:30:00Z` });
const countersignatures = [tdx.countersign(seal, { key, approverRef: 'e_demo_headmaster', role: 'headmaster', decision: 'approved', signedAt: `${DATE}T12:05:00Z` })];

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'day-demo.json'), JSON.stringify({ capsules, seal, countersignatures }, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'keys-demo.json'), JSON.stringify({ keys: [key.publicEntry] }, null, 2) + '\n');
console.log(`wrote ${capsules.length} capsules, a seal and a countersignature to ${path.relative(process.cwd(), OUT)}`);
