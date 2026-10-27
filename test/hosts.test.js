'use strict';
// hosts/gemini.js — the host-side Gemini generate used by this repo's scripts — and the rule that the
// core never talks to Google itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGeminiGenerate, pickModel } = require('../hosts/gemini');

function mockFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const [, status, body] = routes.find(([re]) => re.test(url)) || [null, 404, { error: 'no route' }];
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}
const REPLY = { candidates: [{ content: { parts: [{ text: '{}' }] } }], modelVersion: 'gemini-9.1-flash' };
const BODY = { contents: [{ parts: [{ text: 'hi' }] }] };

test('pickModel: newest stable Flash, from AI Studio or Vertex lists', () => {
  assert.equal(pickModel([{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.10-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-9.9-flash', supportedGenerationMethods: ['embedContent'] }]), 'gemini-3.8-flash');
  assert.equal(pickModel([{ name: 'publishers/google/models/gemini-3.10-flash' }, { name: 'publishers/google/models/gemini-3.8-flash' }]), 'gemini-3.10-flash');
  assert.equal(pickModel([{ name: 'publishers/google/models/gemini-3.8-pro' }]), null);
});

test('AI Studio (default): key in header, model from the AI Studio list', async () => {
  const m = mockFetch([[/generativelanguage.*\/models\?/, 200, { models: [{ name: 'models/gemini-9.1-flash', supportedGenerationMethods: ['generateContent'] }] }],
    [/generativelanguage.*generateContent/, 200, REPLY]]);
  const g = createGeminiGenerate({ apiKey: 'k1', backend: '', model: '', fetch: m.fetch });
  assert.equal(g.backend, 'studio');
  assert.deepEqual(await g.generate(BODY), REPLY);
  const post = m.calls.at(-1);
  assert.equal(post.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-9.1-flash:generateContent');
  assert.equal(post.init.headers['x-goog-api-key'], 'k1');
  assert.equal(JSON.parse(post.init.body).contents[0].role, undefined);
});

test('Vertex express mode: publisher endpoint, key as query parameter, role added', async () => {
  const m = mockFetch([[/aiplatform.*\/models\?/, 200, { publisherModels: [{ name: 'publishers/google/models/gemini-9.1-flash' }] }],
    [/aiplatform.*generateContent/, 200, REPLY]]);
  const g = createGeminiGenerate({ apiKey: 'k2', backend: 'Vertex', model: '', fetch: m.fetch });
  assert.equal(g.backend, 'vertex');
  await g.generate(BODY);
  const post = m.calls.at(-1);
  assert.equal(post.url, 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-9.1-flash:generateContent?key=k2');
  assert.equal(JSON.parse(post.init.body).contents[0].role, 'user');
  assert.ok(m.calls.every(c => !/generativelanguage/.test(c.url)));
});

test('Vertex: refused model list falls back to the AI Studio list for the name only; errors carry the status', async () => {
  const m = mockFetch([[/aiplatform.*\/models\?/, 403, { error: 'list denied' }],
    [/generativelanguage.*\/models\?/, 200, { models: [{ name: 'models/gemini-9.1-flash', supportedGenerationMethods: ['generateContent'] }] }],
    [/aiplatform.*generateContent/, 402, { error: { code: 402 } }]]);
  const g = createGeminiGenerate({ apiKey: 'k', backend: 'vertex', model: '', fetch: m.fetch });
  assert.equal(await g.resolveModel(), 'gemini-9.1-flash');
  await assert.rejects(g.generate(BODY), /HTTP 402/);
  assert.match(m.calls.at(-1).url, /^https:\/\/aiplatform/);
  const fixed = createGeminiGenerate({ apiKey: 'k', backend: 'vertex', model: 'models/gemini-x-flash', fetch: m.fetch });
  assert.equal(await fixed.resolveModel(), 'gemini-x-flash');
  assert.throws(() => createGeminiGenerate({ apiKey: '' }), /apiKey/);
});

test('Vertex: no model list readable → the product default alias, confirmed by a one-token call', async () => {
  const m = mockFetch([[/aiplatform.*\/models\?/, 401, { error: 'API keys are not supported by this API' }],
    [/generativelanguage/, 403, { error: 'blocked' }],
    [/aiplatform.*gemini-flash-latest:generateContent/, 200, REPLY]]);
  const g = createGeminiGenerate({ apiKey: 'k', backend: 'vertex', model: '', fetch: m.fetch });
  assert.equal(await g.resolveModel(), 'gemini-flash-latest');
  assert.equal(g.answeredBy(), 'gemini-9.1-flash');
  const none = mockFetch([[/./, 401, { error: 'no' }]]);
  await assert.rejects(createGeminiGenerate({ apiKey: 'k', backend: 'vertex', model: '', fetch: none.fetch }).resolveModel(), /model list HTTP 401.*gemini-flash-latest HTTP 401/);
});

test('the core (src/) never calls Google and never requires hosts/', () => {
  const files = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && files.push(path.join(d, e.name)));
  walk(path.join(__dirname, '../src'));
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/googleapis\.com/.test(s), `${f} names a Google endpoint`);
    assert.ok(!/require\(['"][./]*hosts/.test(s), `${f} requires hosts/`);
  }
});
