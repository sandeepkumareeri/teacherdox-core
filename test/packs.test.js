'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const packs = require('../src/packs');
const { BASE_CLASSES } = require('../src/engine/score');
const SCHEMA = require('../spec/schema/tdx-2.0.schema.json');
const { mockMeta, RECORD, CTX, engine } = require('./helpers');

const EN = packs.load('locales', 'en');
const holes = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
const forms = v => (typeof v === 'object' ? Object.values(v) : [v]);

test('every locale pack has exactly the English keys, same placeholders, valid plural forms', () => {
  const locales = packs.list('locales');
  assert.deepEqual(locales, ['en', 'fr', 'hi', 'id', 'ml', 'pt-BR', 'te']);
  for (const id of locales) {
    const L = packs.load('locales', id);
    assert.equal(L.locale, id);
    assert.ok(new Intl.PluralRules(L.locale).resolvedOptions().locale.startsWith(id.split('-')[0]), `${id}: Intl knows the locale`);
    for (const part of ['messages', 'terms']) {
      assert.deepEqual(Object.keys(L[part]).sort(), Object.keys(EN[part]).sort(), `${id}.${part} keys`);
      for (const [k, v] of Object.entries(L[part])) {
        const want = new Set(forms(EN[part][k]).flatMap(holes));
        for (const f of forms(v)) for (const h of holes(f)) assert.ok(want.has(h), `${id}.${k}: unknown placeholder {${h}}`);
        if (typeof v === 'object') {
          assert.ok(v.other, `${id}.${k}: plural needs "other"`);
          const cats = new Intl.PluralRules(L.locale).resolvedOptions().pluralCategories;
          for (const c of Object.keys(v)) assert.ok(cats.includes(c), `${id}.${k}: ${c} is not a plural category of ${id}`);
          assert.ok(holes(v.other).includes('n'), `${id}.${k}: "other" must show {n}`);
        } else {
          assert.deepEqual(holes(v), holes(EN[part][k]), `${id}.${k} placeholders`);
        }
      }
    }
  }
});

test('institution packs: one per schema institution type, consistent with schema and terms', () => {
  const types = SCHEMA.$defs.actor.properties.institution_type.enum;
  const kinds = SCHEMA.$defs.session.properties.kind.enum;
  assert.deepEqual(packs.list('institutions'), [...types].sort());
  for (const type of types) {
    const I = packs.load('institutions', type);
    assert.equal(I.type, type);
    assert.ok(I.session_kinds.every(k => kinds.includes(k)), `${type}: session kinds`);
    assert.ok(I.session_kinds.includes(I.default_kind), `${type}: default kind`);
    for (const term of Object.values(I.field_terms)) assert.ok(EN.terms[term], `${type}: term ${term}`);
    for (const f of Object.keys(I.field_terms)) assert.ok(f in BASE_CLASSES, `${type}: field ${f}`);
    for (const [f, c] of Object.entries(I.promotions)) assert.ok(f in BASE_CLASSES && ['critical', 'material', 'soft'].includes(c), `${type}: promotion ${f}`);
    assert.ok(I.approver_role === null || EN.terms[I.approver_role], `${type}: approver role`);
    assert.ok(I.model_vocabulary.length > 20);
  }
});

test('country packs: real IANA time zones, a record language with a pack, sane calendar', () => {
  assert.deepEqual(packs.list('countries'), ['BR', 'FR', 'ID', 'IN', 'SN']);
  for (const iso of packs.list('countries')) {
    const C = packs.country(iso);
    assert.equal(C.country, iso);
    for (const tz of C.timezones) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: tz }), `${iso}: ${tz}`);
    assert.ok(C.default_timezone === null || C.timezones.includes(C.default_timezone), `${iso}: default time zone`);
    assert.equal(packs.locale(C.default_record_locale).locale.split('-')[0], C.default_record_locale.split('-')[0], `${iso}: record locale pack`);
    assert.ok(C.academic_year_start_month >= 1 && C.academic_year_start_month <= 12);
    assert.ok(C.approver_hierarchy.length >= 2);
  }
});

test('policy packs: thresholds in 0..1, stricter profiles are stricter', () => {
  const P = Object.fromEntries(packs.list('policies').map(n => [n, packs.policy(n)]));
  assert.deepEqual(Object.keys(P), ['government_audit', 'low_connectivity', 'personal', 'school_compliance']);
  for (const p of Object.values(P)) {
    for (const v of [...Object.values(p.min), ...Object.values(p.hold_below)]) assert.ok(v >= 0 && v <= 1);
    assert.equal(typeof p.require_check, 'boolean');
    assert.equal(typeof p.allow_auto_lock, 'boolean');
  }
  for (const c of ['critical', 'material', 'soft']) {
    assert.ok(P.personal.min[c] <= P.school_compliance.min[c]);
    assert.ok(P.school_compliance.min[c] <= P.government_audit.min[c]);
  }
  assert.ok(P.low_connectivity.max_capture_lag_days > P.school_compliance.max_capture_lag_days);
  assert.throws(() => packs.policy('nope'), /unknown policy/);
});

test('t(): locale fallback, plurals, placeholders', () => {
  assert.equal(packs.locale('pt').locale, 'pt-BR');
  assert.equal(packs.locale('ml-IN').locale, 'ml');
  assert.equal(packs.locale('sw').locale, 'en');
  assert.equal(packs.t('ml', 'signed', { n: 1 }), 'ഒരു രേഖയിൽ ഒപ്പിട്ടു.');
  assert.equal(packs.t('ml', 'signed', { n: 4 }), '4 രേഖകളിൽ ഒപ്പിട്ടു.');
  assert.equal(packs.t('fr', 'signed', { n: 0 }), '0 fiche signée.');
  assert.equal(packs.t('id', 'digest', { n: 1, date: '28 Okt' }), '28 Okt · 1 catatan');
  assert.equal(packs.t('sw', 'action.sign'), 'Sign');
  assert.equal(packs.t('en', 'no.such.key'), 'no.such.key');
});

test('field labels follow the institution: a school "class", an academy "batch", a training "programme"', () => {
  assert.equal(packs.fieldLabel('session.cohort', { locale: 'en', institution_type: 'school' }), 'class');
  assert.equal(packs.fieldLabel('session.cohort', { locale: 'en', institution_type: 'academy' }), 'batch');
  assert.equal(packs.fieldLabel('session.course', { locale: 'en', institution_type: 'training' }), 'programme');
  assert.equal(packs.fieldLabel('content.assignments', { locale: 'te', institution_type: 'school' }), 'హోంవర్క్');
  assert.equal(packs.fieldList(['session.cohort', 'session.subject', 'content.assignments'], { locale: 'en', institution_type: 'school' }), 'class, subject, and homework');
});

test('describe(): one message per engine outcome, in the educator\'s language', async () => {
  const run = (meta, ctx) => engine({ meta }).process({ text: 'fractions 8B', context: CTX(ctx) });
  const ok = await run(mockMeta(), { locale: 'ml-IN' });
  assert.deepEqual(packs.describe(ok), { status: 'രേഖപ്പെടുത്തി. ഒപ്പിടാൻ തയ്യാർ.', line: '8B · Mathematics · Fractions', fields: [] });

  const contradicted = await run(mockMeta({ check: { checks: [{ field: 'session.cohort', verdict: 'contradicted', detail: '8C' }] } }), { locale: 'te-IN' });
  assert.equal(packs.describe(contradicted).status, 'తరగతి పంపినదానితో సరిపోలడం లేదు. దయచేసి చూడండి.');

  const confirm = await run(mockMeta({ check: { checks: [{ field: 'content.assignments', verdict: 'unsupported', detail: '' }] } }), { locale: 'pt-BR' });
  assert.equal(packs.describe(confirm).status, 'Registrado. Confira: tarefa de casa.');

  const irrelevant = await run(mockMeta({ record: RECORD({ relevant: false }) }), { locale: 'hi-IN' });
  assert.equal(packs.describe(irrelevant).status, 'यह किसी कक्षा के बारे में नहीं लगता। कुछ दर्ज नहीं किया गया।');
});

test('engine + country packs: time zone and record language come from the country', async () => {
  const fr = await engine().process({ text: 'x', context: CTX({ country: 'FR', timezone: undefined, record_locale: undefined, locale: 'fr' }) });
  assert.equal(fr.capsule.body.session.timezone, 'Europe/Paris');
  assert.equal(fr.capsule.body.record_locale, 'fr');
  const meta = mockMeta();
  await engine({ meta }).process({ text: 'x', context: CTX({ country: 'FR', timezone: undefined, record_locale: undefined }) });
  assert.match(meta.calls.find(c => c.path === '/chat/completions').json.messages[0].content[0].text, /Write every text field in French/);
  await assert.rejects(engine().process({ text: 'x', context: CTX({ country: 'BR', timezone: undefined }) }), /Brazil has several/);
});

test('engine + policy packs: audit never auto-locks, late capture needs confirmation, personal skips the check', async () => {
  const audit = await engine().process({ text: 'x', context: CTX({ policy: 'government_audit', session: { cohort: '8B', subject: 'Mathematics' } }) });
  assert.equal(audit.routing.decision, 'confirm');
  assert.match(audit.routing.reasons.join(), /person to confirm every record/);

  const late = { captured_at: '2026-10-31T06:00:00Z', session: { cohort: '8B', subject: 'Mathematics' } };
  const r1 = await engine().process({ text: 'x', context: CTX(late) });
  assert.equal(r1.routing.decision, 'confirm');
  assert.equal(r1.routing.late_days, 3);
  assert.equal(packs.describe(r1).status, 'Sent 3 days after the class. Please confirm it.');
  const r2 = await engine().process({ text: 'x', context: CTX({ ...late, policy: 'low_connectivity' }) });
  assert.equal(r2.routing.decision, 'auto_lock');

  const meta = mockMeta();
  const personal = await engine({ meta }).process({ text: 'x', context: CTX({ policy: 'personal' }) });
  assert.ok(!personal.steps.some(s => s.step === 'check'));
  assert.equal(meta.calls.filter(c => c.path === '/chat/completions').length, 1);
});

test('engine + institution packs: vocabulary in the prompt; session kind stays within the institution', async () => {
  const meta = mockMeta({ record: RECORD({ session: { ...RECORD().session, kind: 'lecture' } }) });
  const r = await engine({ meta }).process({ text: 'x', context: CTX() });
  assert.equal(r.capsule.body.session.kind, 'period');
  const academy = mockMeta();
  await engine({ meta: academy }).process({ text: 'x', context: CTX({ institution_type: 'academy' }) });
  assert.match(academy.calls[0].json.messages[0].content[0].text, /cohort is the batch name/);
});
