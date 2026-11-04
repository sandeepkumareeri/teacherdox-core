'use strict';
// WhatsApp Cloud API (Meta, direct) — the wire level, no dependencies.
//
//   verifySignature(rawBody, header, appSecret)  X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(appSecret, raw body)
//   handshake(query, verifyToken)                GET webhook verification → the challenge to echo, or null
//   parseWebhook(body)                           webhook JSON → inbound events (one per user message)
//   createClient({ token, phoneNumberId })       downloadMedia, sendText, sendButtons, markRead (Graph API)
//
// Formats follow Meta's Cloud API reference for webhooks ("messages" field) and the
// /{phone-number-id}/messages and /{media-id} endpoints. Only what a teaching record needs
// is parsed: photos, voice notes / audio, text, reply-button taps. Everything else becomes
// an `other` event the channel can ignore.

const crypto = require('node:crypto');

const GRAPH = 'https://graph.facebook.com';
const DEFAULT_VERSION = 'v21.0';

/** true when `header` is a valid signature of `rawBody` (a Buffer) with `appSecret`. */
function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !Buffer.isBuffer(rawBody) || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** Meta's GET verification: hub.mode=subscribe + matching hub.verify_token → hub.challenge, else null. */
function handshake(query, verifyToken) {
  const get = k => (typeof query.get === 'function' ? query.get(k) : query[k]);
  if (!verifyToken || get('hub.mode') !== 'subscribe' || get('hub.verify_token') !== verifyToken) return null;
  const challenge = get('hub.challenge');
  return challenge == null ? null : String(challenge);
}

const digits = v => String(v || '').replace(/\D/g, '');

/**
 * Webhook body → events, oldest first:
 *   { from, name, id, at, type: 'photo'|'voice'|'text'|'button'|'other',
 *     media_id?, media_type?, caption?, text?, button_id?, raw_type? }
 * Delivery statuses (sent / delivered / read / failed) are returned separately as `statuses`.
 */
function parseWebhook(body) {
  const events = [], statuses = [];
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return { events, statuses };
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map(c => [digits(c.wa_id), c.profile?.name || null]));
      for (const s of v.statuses || []) statuses.push({ id: s.id, status: s.status, to: digits(s.recipient_id), errors: s.errors || [] });
      for (const m of v.messages || []) {
        const from = digits(m.from);
        const base = { from, name: names[from] || null, id: m.id, at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null };
        const doc = m.type === 'document' ? m.document || {} : null;
        if (m.type === 'image' || (doc && /^image\//.test(doc.mime_type || ''))) {
          const media = m.image || doc;
          events.push({ ...base, type: 'photo', media_id: media.id, media_type: media.mime_type || 'image/jpeg', caption: media.caption || '' });
        } else if (m.type === 'audio' || (doc && /^audio\//.test(doc.mime_type || ''))) {
          const media = m.audio || doc;
          events.push({ ...base, type: 'voice', media_id: media.id, media_type: (media.mime_type || 'audio/ogg').split(';')[0].trim() });
        } else if (m.type === 'text') {
          events.push({ ...base, type: 'text', text: m.text?.body || '' });
        } else if (m.type === 'interactive' && (m.interactive?.button_reply || m.interactive?.list_reply)) {
          const r = m.interactive.button_reply || m.interactive.list_reply;
          events.push({ ...base, type: 'button', button_id: r.id, text: r.title || '' });
        } else if (m.type === 'button') {
          events.push({ ...base, type: 'button', button_id: m.button?.payload || '', text: m.button?.text || '' });
        } else {
          events.push({ ...base, type: 'other', raw_type: m.type });
        }
      }
    }
  }
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { events, statuses };
}

/**
 * Graph API client for one business phone number.
 *   token          a permanent System User token (whatsapp_business_messaging)
 *   phoneNumberId  the number's Phone number ID (not the phone number)
 *   fetch          injectable for tests (default: global fetch)
 */
function createClient({ token, phoneNumberId, apiVersion = DEFAULT_VERSION, fetch: f = globalThis.fetch, maxMediaBytes = 16 * 1024 * 1024 } = {}) {
  if (!token || !phoneNumberId) throw new Error('whatsapp: token and phoneNumberId are required');
  const auth = { Authorization: `Bearer ${token}` };
  async function json(url, init = {}) {
    const res = await f(url, { ...init, headers: { ...auth, ...(init.headers || {}) } });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`whatsapp: HTTP ${res.status} ${text.slice(0, 300)}`), { status: res.status });
    return text ? JSON.parse(text) : {};
  }
  async function send(to, payload) {
    const r = await json(`${GRAPH}/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(to), ...payload }),
    });
    return r.messages?.[0]?.id || null;
  }
  return {
    /** media id → { bytes, media_type }. Media ids expire, so download as soon as the webhook arrives. */
    async downloadMedia(mediaId) {
      const meta = await json(`${GRAPH}/${apiVersion}/${encodeURIComponent(mediaId)}`);
      if (!meta.url) throw new Error('whatsapp: media has no url');
      if (meta.file_size && meta.file_size > maxMediaBytes) throw new Error(`whatsapp: media is larger than ${maxMediaBytes} bytes`);
      const res = await f(meta.url, { headers: auth });
      if (!res.ok) throw Object.assign(new Error(`whatsapp: media download HTTP ${res.status}`), { status: res.status });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxMediaBytes) throw new Error(`whatsapp: media is larger than ${maxMediaBytes} bytes`);
      return { bytes, media_type: String(meta.mime_type || '').split(';')[0].trim() || 'application/octet-stream' };
    },
    sendText: (to, text) => send(to, { type: 'text', text: { body: String(text).slice(0, 4096), preview_url: false } }),
    /** Reply buttons: at most 3, titles at most 20 characters (WhatsApp's limits). */
    sendButtons: (to, text, buttons) => send(to, {
      type: 'interactive',
      interactive: {
        type: 'button', body: { text: String(text).slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } })) },
      },
    }),
    markRead: messageId => json(`${GRAPH}/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    }).catch(() => null),
  };
}

module.exports = { verifySignature, handshake, parseWebhook, createClient, DEFAULT_VERSION };
