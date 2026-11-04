'use strict';
// WhatsApp channel: Cloud API wire format (signature, handshake, webhook parsing, Graph client)
// and the end-to-end path WhatsApp message → Record Engine → signed record, through the API.
// All payloads are synthetic, in the shape of Meta's Cloud API webhook reference.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const tdx = require('../src/tdx');
const wa = require('../src/channels/whatsapp');
const { createApi, createStore } = require('../src/api');
const { BOARD, RECORD, mockMeta, engine } = require('./helpers');

const SECRET = 'app-secret-for-tests';
const PHONE = '919800000001';
const sign = (raw, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

const ts = s => String(Math.floor(Date.parse(s) / 1000));
function webhook(messages, { contacts = [{ wa_id: PHONE, profile: { name: 'Lakshmi' } }], statuses } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '910000000000', phone_number_id: 'PNID' },
      contacts, messages, ...(statuses ? { statuses } : {}),
    } }] }],
  };
}
const image = (id, at, caption) => ({ from: PHONE, id, timestamp: ts(at), type: 'image', image: { id: `media-${id}`, mime_type: 'image/jpeg', ...(caption ? { caption } : {}) } });
const text = (id, at, body, from = PHONE) => ({ from, id, timestamp: ts(at), type: 'text', text: { body } });
const tap = (id, at, buttonId, from = PHONE) => ({ from, id, timestamp: ts(at), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'Sign' } } });

test('cloud-api: X-Hub-Signature-256 is checked over the raw body', () => {
  const raw = Buffer.from(JSON.stringify(webhook([])));
  assert.equal(wa.verifySignature(raw, sign(raw), SECRET), true);
  assert.equal(wa.verifySignature(raw, sign(raw, 'other-secret'), SECRET), false, 'wrong app secret');
  assert.equal(wa.verifySignature(Buffer.concat([raw, Buffer.from(' ')]), sign(raw), SECRET), false, 'body changed after signing');
  assert.equal(wa.verifySignature(raw, undefined, SECRET), false, 'no header');
  assert.equal(wa.verifySignature(raw, sign(raw).replace('sha256=', 'sha1='), SECRET), false, 'other scheme');
  assert.equal(wa.verifySignature(raw, sign(raw), ''), false, 'no secret configured never verifies');
});

test('cloud-api: verification handshake echoes the challenge only for the right token', () => {
  const q = o => new URLSearchParams(o);
  assert.equal(wa.handshake(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '12345' }), 'vt'), '12345');
  assert.equal(wa.handshake(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '12345' }), 'vt'), null);
  assert.equal(wa.handshake(q({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'vt', 'hub.challenge': '1' }), 'vt'), null);
  assert.equal(wa.handshake(q({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }), ''), null, 'no token configured');
});

test('cloud-api: webhook → photo, voice, text, button and other events; statuses apart', () => {
  const body = webhook([
    text('m3', '2026-10-28T05:02:00Z', 'P2 8B fractions'),
    image('m1', '2026-10-28T05:00:00Z', 'board'),
    { from: PHONE, id: 'm2', timestamp: ts('2026-10-28T05:01:00Z'), type: 'audio', audio: { id: 'media-m2', mime_type: 'audio/ogg; codecs=opus', voice: true } },
    { from: PHONE, id: 'm4', timestamp: ts('2026-10-28T05:03:00Z'), type: 'document', document: { id: 'media-m4', mime_type: 'image/png', filename: 'b.png' } },
    tap('m5', '2026-10-28T05:04:00Z', 'tdx_sign:x'),
    { from: PHONE, id: 'm6', timestamp: ts('2026-10-28T05:05:00Z'), type: 'button', button: { payload: 'p', text: 'Yes' } },
    { from: PHONE, id: 'm7', timestamp: ts('2026-10-28T05:06:00Z'), type: 'sticker', sticker: { id: 's' } },
  ], { statuses: [{ id: 'out1', status: 'failed', recipient_id: PHONE, errors: [{ code: 131047 }] }] });
  const { events, statuses } = wa.parseWebhook(body);
  assert.deepEqual(events.map(e => [e.id, e.type]), [['m1', 'photo'], ['m2', 'voice'], ['m3', 'text'], ['m4', 'photo'], ['m5', 'button'], ['m6', 'button'], ['m7', 'other']], 'oldest first');
  assert.equal(events[0].name, 'Lakshmi');
  assert.equal(events[0].caption, 'board');
  assert.equal(events[1].media_type, 'audio/ogg', 'codec parameters dropped');
  assert.equal(events[4].button_id, 'tdx_sign:x');
  assert.equal(events[0].at, '2026-10-28T05:00:00.000Z');
  assert.deepEqual(statuses, [{ id: 'out1', status: 'failed', to: PHONE, errors: [{ code: 131047 }] }]);
  assert.deepEqual(wa.parseWebhook({ object: 'page', entry: [] }), { events: [], statuses: [] }, 'not a WhatsApp webhook');
  assert.deepEqual(wa.parseWebhook({ topic: 'message.sender.user', data: {} }).events, [], 'a BSP forward is not the Cloud API format');
});

test('cloud-api: Graph client downloads media in two steps and sends text / buttons', async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const ok = (obj, bin) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), arrayBuffer: async () => bin });
    if (url === 'https://graph.facebook.com/v21.0/media-1') return ok({ url: 'https://lookaside.example/abc', mime_type: 'image/jpeg', file_size: BOARD.length });
    if (url === 'https://lookaside.example/abc') return ok(null, BOARD.buffer.slice(BOARD.byteOffset, BOARD.byteOffset + BOARD.length));
    if (url.endsWith('/PNID/messages')) return ok({ messages: [{ id: 'wamid.1' }] });
    return { ok: false, status: 404, text: async () => 'nope' };
  };
  const c = wa.createClient({ token: 'TOKEN', phoneNumberId: 'PNID', fetch });
  const m = await c.downloadMedia('media-1');
  assert.ok(m.bytes.equals(BOARD));
  assert.equal(m.media_type, 'image/jpeg');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer TOKEN', 'the media URL needs the token too');
  assert.equal(await c.sendText('+91 98000 00001', 'hi'), 'wamid.1');
  const sent = JSON.parse(calls[2].init.body);
  assert.deepEqual(sent, { messaging_product: 'whatsapp', recipient_type: 'individual', to: PHONE, type: 'text', text: { body: 'hi', preview_url: false } });
  await c.sendButtons(PHONE, 'Check', [{ id: 'a', title: 'A very long button title indeed' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'd', title: 'D' }]);
  const btn = JSON.parse(calls[3].init.body).interactive.action.buttons;
  assert.equal(btn.length, 3, 'WhatsApp allows at most 3 reply buttons');
  assert.equal(btn[0].reply.title.length, 20, 'titles are cut to 20 characters');
  await assert.rejects(c.downloadMedia('missing'), /HTTP 404/);
  assert.throws(() => wa.createClient({ token: 'x' }), /phoneNumberId/);
});

// ── end to end, through the API ───────────────────────────────────────────────────

const key = tdx.generateKey('k_wa', { validFrom: '2026-01-01T00:00:00Z' });
const registry = { keys: [key.publicEntry] };

function fakeClient() {
  const sent = [];
  return {
    sent,
    downloadMedia: async id => ({ bytes: BOARD, media_type: 'image/jpeg', id }),
    sendText: async (to, body) => { sent.push({ to, text: body }); return 'wamid'; },
    sendButtons: async (to, body, buttons) => { sent.push({ to, text: body, buttons }); return 'wamid'; },
  };
}

async function server({ meta = mockMeta(), whatsapp = {} } = {}) {
  const client = fakeClient();
  const store = createStore();
  const api = createApi({
    engine: engine({ meta }), store, key: { keyId: key.keyId, privateKeyPem: key.privateKeyPem }, registry, tokens: { tok: { tenant: 't_wa' } },
    whatsapp: { client, appSecret: SECRET, verifyToken: 'vt', tenant: 't_wa', institution_ref: 'i_1', institution_type: 'school', country: 'IN', locale: 'en-IN', quietMs: 60000, verifyUrl: 'https://example.org/verify/', ...whatsapp },
  });
  const srv = await api.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (body, { signature, secret } = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    const res = await fetch(base + '/v1/whatsapp/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature ?? sign(raw, secret) }, body: raw });
    return { status: res.status, json: await res.json() };
  };
  const get = p => fetch(base + p);
  return { api, store, client, post, get, close: () => new Promise(r => { api.close(); srv.close(r); }) };
}

test('WhatsApp → record: photo + text become one signed record; the phone number never enters it', async t => {
  const s = await server();
  t.after(s.close);

  // Meta's handshake
  assert.equal(await (await s.get('/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=777')).text(), '777');
  assert.equal((await s.get('/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=777')).status, 403);

  // Unsigned or wrongly signed deliveries are refused and nothing is processed
  assert.equal((await s.post(webhook([text('x1', '2026-10-28T05:00:00Z', 'hello')]), { signature: '' })).status, 401);
  assert.equal((await s.post(webhook([text('x2', '2026-10-28T05:00:00Z', 'hello')]), { secret: 'wrong' })).status, 401);
  assert.deepEqual(s.api.whatsapp.pending(), []);

  // A board photo, then a line of text, as two webhooks
  assert.deepEqual((await s.post(webhook([image('w1', '2026-10-28T05:00:00Z')]))).json, { received: 1 });
  await s.post(webhook([text('w2', '2026-10-28T05:00:20Z', 'P2 8B fractions, HW Ex 3.2')]));
  await s.post(webhook([text('w2', '2026-10-28T05:00:20Z', 'P2 8B fractions, HW Ex 3.2')]));   // Meta retry: ignored
  assert.deepEqual(s.api.whatsapp.pending(), [PHONE], 'waiting for the educator to be quiet');

  const r = await s.api.whatsapp.flush(PHONE);          // the quiet timer, without waiting 60 s
  assert.equal(r.routing.decision, 'auto_lock');
  assert.equal(r.state, 'auto_locked');

  const locked = s.store.byEntry(r.entry_id).find(c => c.body.lifecycle.state === 'auto_locked');
  const draft = s.store.byEntry(r.entry_id)[0];
  assert.ok(JSON.stringify(draft.body).includes('"channel":"whatsapp"'), 'captured on the whatsapp channel');
  assert.match(locked.body.actor.educator_ref, /^wa_[0-9a-f]{24}$/);
  assert.equal(locked.body.session.date, '2026-10-28', 'the day in the institution\'s time zone');
  assert.ok(!JSON.stringify(s.store.byEntry(r.entry_id)).includes(PHONE), 'the phone number is not in any capsule');
  assert.equal(tdx.verifyCapsule(locked, { keys: registry.keys }).ok, true);
  assert.equal(draft.body.evidence.length, 1, 'one photo');

  const reply = s.client.sent.at(-1);
  assert.equal(reply.to, PHONE);
  assert.match(reply.text, /8B/);
  assert.match(reply.text, /Recorded\. Ready to sign\./);
  assert.match(reply.text, /1 record signed\./);
  assert.match(reply.text, /https:\/\/example\.org\/verify\//);
});

test('WhatsApp → record (college): a missing course asks the lecturer, the Sign button signs it, others cannot', async t => {
  const s = await server({ whatsapp: { institution_type: 'college' } });   // the college pack requires a course
  t.after(s.close);

  await s.post(webhook([image('c1', '2026-10-28T06:00:00Z', 'P3 8B')]));
  const r = await s.api.whatsapp.flush(PHONE);
  assert.equal(r.routing.decision, 'confirm');
  assert.equal(s.store.byEntry(r.entry_id).at(-1).body.lifecycle.state, 'draft', 'not signed until the educator says so');
  assert.equal(s.store.byEntry(r.entry_id)[0].body.actor.institution_type, 'college', 'not only schools');
  const ask = s.client.sent.at(-1);
  assert.match(ask.text, /Please check: course/, 'the college vocabulary, from the institution pack');
  assert.deepEqual(ask.buttons, [{ id: `tdx_sign:${r.entry_id}`, title: 'Sign' }]);

  // Someone else tapping the same button id cannot sign it
  const other = '919800000002';
  await s.post(webhook([tap('c2', '2026-10-28T06:01:00Z', `tdx_sign:${r.entry_id}`, other)], { contacts: [{ wa_id: other, profile: { name: 'X' } }] }));
  await s.api.whatsapp.idle();
  assert.equal(s.store.byEntry(r.entry_id).at(-1).body.lifecycle.state, 'draft');

  // The educator taps Sign
  await s.post(webhook([tap('c3', '2026-10-28T06:02:00Z', `tdx_sign:${r.entry_id}`)]));
  await s.api.whatsapp.idle();
  const signed = s.store.byEntry(r.entry_id).at(-1);
  assert.equal(signed.body.lifecycle.state, 'confirmed_locked');
  assert.equal(signed.body.attestation.confirmation.channel, 'whatsapp');
  assert.equal(signed.body.attestation.mode, 'human', 'the lecturer signed it, not the machine');
  assert.ok(signed.body.attestation.confirmed_fields.includes('session.course'));
  assert.equal(tdx.verifyCapsule(signed, { keys: registry.keys }).ok, true);
  assert.match(s.client.sent.at(-1).text, /1 record signed\./);
});

test('WhatsApp → record: "sign" as a text signs the waiting draft; an unclear or off-topic capture is held, not invented', async t => {
  const s = await server({ whatsapp: { institution_type: 'college' } });
  t.after(s.close);
  await s.post(webhook([image('s1', '2026-10-28T07:00:00Z')]));
  const r = await s.api.whatsapp.flush(PHONE);
  await s.post(webhook([text('s2', '2026-10-28T07:01:00Z', 'Sign')]));
  await s.api.whatsapp.idle();
  assert.equal(r.routing.decision, 'confirm');
  assert.equal(s.store.byEntry(r.entry_id).at(-1).body.lifecycle.state, 'confirmed_locked');

  const s3 = await server({ meta: mockMeta({ record: RECORD({ confidence: { ...RECORD().confidence, subject: 0.2 } }) }) });
  t.after(s3.close);
  await s3.post(webhook([image('u1', '2026-10-28T07:30:00Z')]));
  const u = await s3.api.whatsapp.flush(PHONE);
  assert.equal(u.routing.decision, 'hold', 'too unsure to even ask: held');
  assert.equal(s3.client.sent.at(-1).buttons, undefined);

  const s2 = await server({ meta: mockMeta({ record: RECORD({ relevant: false }) }) });
  t.after(s2.close);
  await s2.post(webhook([text('h1', '2026-10-28T08:00:00Z', 'good morning everyone')]));
  const h = await s2.api.whatsapp.flush(PHONE);
  assert.equal(h.routing.decision, 'hold');
  assert.equal(s2.client.sent.at(-1).buttons, undefined, 'no Sign button for a held capture');
  assert.match(s2.client.sent.at(-1).text, /does not look like a class/);
});

test('WhatsApp channel: refuses to start without an app secret, unless explicitly unsigned', () => {
  const base = { engine: engine(), store: createStore(), key: { keyId: key.keyId, privateKeyPem: key.privateKeyPem }, registry };
  const cfg = { client: fakeClient(), tenant: 't', institution_ref: 'i' };
  assert.throws(() => createApi({ ...base, whatsapp: cfg }), /appSecret/);
  const api = createApi({ ...base, whatsapp: { ...cfg, allowUnsigned: true } });
  assert.ok(api.whatsapp);
  api.close();
  assert.throws(() => createApi({ ...base, whatsapp: { client: fakeClient(), appSecret: 's' } }), /tenant and institution_ref/);
});
