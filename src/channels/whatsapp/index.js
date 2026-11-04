'use strict';
// WhatsApp channel: an educator's WhatsApp messages → teaching records.
//
// The educator sends what they already have after a class — a photo of the board, a voice
// note, a line of text — in any order, as several messages. The channel downloads the media
// at once (Cloud API media ids expire), waits until the educator has been quiet for
// `quietMs`, and hands everything as ONE capture to `submit` (the Record Engine through the
// API's queue). The reply is the educator-facing sentence from the locale pack:
//
//   auto_lock → "Recorded. Ready to sign." + the record line, signed on the spot
//   confirm   → "Recorded. Please check: subject." + a "Sign" button
//   hold      → "This could not be read. Send it again, or type what you taught."
//
// Tapping "Sign" (or sending "sign") locks the draft as confirmed_locked: the educator's
// confirmation is the signature event, with channel "whatsapp" in the attestation.
//
// Privacy: the phone number never enters a record. `contextFor` maps it to an opaque
// educator_ref; transcripts and media stay in the API's store, as for any other capture.

const { packs } = require('../../packs');
const cloud = require('./cloud-api');

const SIGN_WORDS = /^\s*\/?(sign|confirm|ok|okay|yes|signed|done|✅|👍)\s*[.!]*\s*$/i;
const BUTTON = 'tdx_sign:';

/**
 * createWhatsAppChannel({ client, submit, confirm, contextFor, quietMs, verifyUrl, log, timers })
 *   client      { downloadMedia, sendText, sendButtons, markRead? } (cloud-api createClient)
 *   submit      async ({ evidence: [{ bytes, media_type, role }], text: [string], context }) →
 *               { entry_id, state, routing, message: { status, line, fields } }
 *   confirm     async ({ entry_id, educator_ref }) → locked capsule (throws if not theirs / already locked)
 *   contextFor  (from, at) → engine context (tenant, educator_ref, institution_ref, institution_type, date, locale, …)
 *   quietMs     how long the educator must be quiet before the capture is processed (default 10 s)
 *   verifyUrl   optional public verifier link added to "signed" replies
 *   timers      { set, clear } for tests (default setTimeout / clearTimeout)
 */
function createWhatsAppChannel({ client, submit, confirm, contextFor, quietMs = 10000, verifyUrl = null, log = () => {}, timers = {} }) {
  if (!client || !submit || !confirm || !contextFor) throw new Error('whatsapp channel: client, submit, confirm and contextFor are required');
  const set = timers.set || setTimeout, clear = timers.clear || clearTimeout;
  const buffers = new Map();     // from → { evidence, text, at, timer, pending: Promise[] }
  const drafts = new Map();      // from → entry_id of the last draft waiting for "Sign"
  const seen = new Set();        // message ids already handled (Meta retries deliveries)
  const running = new Set();

  const say = (to, text) => client.sendText(to, text).catch(e => log({ type: 'whatsapp_send_failed', error: e.message }));

  function buffer(from) {
    let b = buffers.get(from);
    if (!b) buffers.set(from, (b = { evidence: [], text: [], at: null, timer: null, pending: [] }));
    return b;
  }
  function schedule(from) {
    const b = buffer(from);
    if (b.timer) clear(b.timer);
    b.timer = set(() => { b.timer = null; track(flush(from)); }, quietMs);
    if (b.timer && typeof b.timer.unref === 'function') b.timer.unref();
  }
  function track(p) { running.add(p); p.finally(() => running.delete(p)); return p; }

  /** Process everything the educator sent since the last capture. */
  async function flush(from) {
    const b = buffers.get(from);
    if (!b) return null;
    if (b.timer) { clear(b.timer); b.timer = null; }
    await Promise.allSettled(b.pending);
    buffers.delete(from);
    if (!b.evidence.length && !b.text.length) return null;
    const context = { ...contextFor(from, b.at || new Date().toISOString()), channel: 'whatsapp' };
    let r;
    try {
      r = await submit({ evidence: b.evidence, text: b.text, context });
    } catch (e) {
      log({ type: 'whatsapp_submit_failed', error: e.message });
      await say(from, packs.t(context.locale, 'status.hold.unusable'));
      return null;
    }
    const line = r.message?.line ? `${r.message.line}\n` : '';
    if (r.state === 'auto_locked') {
      drafts.delete(from);
      await say(from, `${line}${r.message.status}\n${packs.t(context.locale, 'signed', { n: 1 })}${verifyUrl ? `\n${verifyUrl}` : ''}`);
    } else if (r.routing?.decision === 'hold') {
      drafts.delete(from);
      await say(from, r.message.status);
    } else {
      drafts.set(from, r.entry_id);
      await client.sendButtons(from, `${line}${r.message.status}`, [{ id: BUTTON + r.entry_id, title: packs.t(context.locale, 'action.sign') }])
        .catch(e => log({ type: 'whatsapp_send_failed', error: e.message }));
    }
    log({ type: 'whatsapp_record', entry_id: r.entry_id, decision: r.routing?.decision, state: r.state });
    return r;
  }

  async function sign(from, entryId) {
    const context = contextFor(from, new Date().toISOString());
    try {
      await confirm({ entry_id: entryId, educator_ref: context.educator_ref });
      if (drafts.get(from) === entryId) drafts.delete(from);
      await say(from, `${packs.t(context.locale, 'signed', { n: 1 })}${verifyUrl ? `\n${verifyUrl}` : ''}`);
    } catch (e) {
      log({ type: 'whatsapp_sign_failed', entry_id: entryId, error: e.message });
      await say(from, e.status === 409 ? packs.t(context.locale, 'signed', { n: 1 }) : packs.t(context.locale, 'status.hold.unusable'));
    }
  }

  /** Handle parsed webhook events (from cloud-api parseWebhook). Resolves when all are queued. */
  async function handle(events) {
    for (const e of events) {
      if (!e.from || (e.id && seen.has(e.id))) continue;
      if (e.id) { seen.add(e.id); if (seen.size > 5000) seen.delete(seen.values().next().value); }
      if (client.markRead && e.id) client.markRead(e.id);
      if (e.type === 'button' && String(e.button_id).startsWith(BUTTON)) {
        await track(sign(e.from, e.button_id.slice(BUTTON.length)));
      } else if (e.type === 'text' && SIGN_WORDS.test(e.text) && drafts.has(e.from) && !buffers.has(e.from)) {
        await track(sign(e.from, drafts.get(e.from)));
      } else if (e.type === 'photo' || e.type === 'voice') {
        const b = buffer(e.from);
        b.at ||= e.at;
        const role = e.type === 'photo' ? 'board' : 'voice_note';
        b.pending.push(client.downloadMedia(e.media_id).then(
          m => { b.evidence.push({ bytes: m.bytes, media_type: m.media_type || e.media_type, role }); },
          err => log({ type: 'whatsapp_media_failed', error: err.message }),
        ));
        if (e.caption) b.text.push(e.caption);
        schedule(e.from);
      } else if (e.type === 'text' && e.text.trim()) {
        const b = buffer(e.from);
        b.at ||= e.at;
        b.text.push(e.text.trim());
        schedule(e.from);
      }
    }
  }

  return {
    handle,
    flush,
    /** Wait until every capture and signature in flight is done (tests, graceful shutdown). */
    async idle() { while (running.size) await Promise.allSettled([...running]); },
    pending: () => [...buffers.keys()],
  };
}

module.exports = { createWhatsAppChannel, ...cloud };
