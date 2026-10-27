'use strict';
// Record store for the API: capsules, evidence, day seals and countersignatures, kept
// in memory and — when `dir` is given — written to disk as plain files and loaded again
// at start, so a restart loses nothing but unfinished jobs. Capsules and seals are never
// rewritten: every write is a new file. Jobs are the exception — their status changes —
// and are replaced atomically (write + rename). One process owns a directory.
//
//   dir/capsules/<capsule_id>.json
//   dir/seals/<n>.json               (all seals, newest last per day)
//   dir/countersignatures/<n>.json
//   dir/evidence/<sha256 hex>        (raw bytes — keep this directory private)
//   dir/jobs/<job id>.json           (the work queue: the only files that are rewritten, atomically)

const fs = require('node:fs');
const path = require('node:path');
const { chainScope, uuidv7Time } = require('../tdx');

const LOCKED = new Set(['auto_locked', 'confirmed_locked']);

function createStore({ dir = null } = {}) {
  const capsules = new Map();          // capsule_id → capsule
  const entries = new Map();           // entry_id → [capsule_id]
  const days = new Map();              // scope → [locked capsule_id] in sequence order
  const seals = new Map();             // scope → [seal]
  const countersigs = [];              // all
  const evidence = new Map();          // sha256 → { bytes, media_type } (memory only when no dir)
  const jobs = new Map();
  let fileNo = 0;

  const write = (sub, name, data) => {
    if (!dir) return;
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, sub, name), data, { flag: 'wx' });   // never overwrite
  };
  const nextName = () => `${Date.now()}-${String(++fileNo).padStart(6, '0')}.json`;

  function index(c) {
    capsules.set(c.capsule_id, c);
    const e = c.body.entry_id;
    if (!entries.has(e)) entries.set(e, []);
    entries.get(e).push(c.capsule_id);
    entries.get(e).sort((a, b) => uuidv7Time(a) - uuidv7Time(b) || (a < b ? -1 : 1));
    if (LOCKED.has(c.body.lifecycle.state)) {
      const s = chainScope(c);
      if (!days.has(s)) days.set(s, []);
      days.get(s).push(c.capsule_id);
      days.get(s).sort((a, b) => capsules.get(a).body.chain.sequence_index - capsules.get(b).body.chain.sequence_index);
    }
  }

  if (dir) {
    const read = sub => {
      try { return fs.readdirSync(path.join(dir, sub)).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, sub, f), 'utf8'))); } catch { return []; }
    };
    read('capsules').forEach(index);
    read('seals').forEach(s => { if (!seals.has(s.scope)) seals.set(s.scope, []); seals.get(s.scope).push(s); });
    countersigs.push(...read('countersignatures'));
    read('jobs').forEach(j => jobs.set(j.id, j));
  }

  return {
    putEvidence(id, bytes, media_type) {
      if (evidence.has(id)) return;
      evidence.set(id, { media_type, bytes: dir ? null : bytes });
      if (dir && !fs.existsSync(path.join(dir, 'evidence', id.slice(7)))) write('evidence', id.slice(7), bytes);
    },
    hasEvidence: id => evidence.has(id) || (!!dir && fs.existsSync(path.join(dir, 'evidence', String(id).slice(7)))),

    putCapsule(c) {
      if (capsules.has(c.capsule_id)) throw new Error(`capsule ${c.capsule_id} already stored`);
      write('capsules', `${c.capsule_id}.json`, JSON.stringify(c));
      index(c);
    },
    getCapsule: id => capsules.get(id) || null,
    /** All capsules of an entry, oldest first. */
    byEntry: entryId => (entries.get(entryId) || []).map(id => capsules.get(id)),
    /** Locked capsules of one educator-day, in chain order. */
    day: scope => (days.get(scope) || []).map(id => capsules.get(id)),
    lastLocked(scope) { const d = days.get(scope); return d && d.length ? capsules.get(d[d.length - 1]) : null; },
    /** Entry ids with any capsule on a day for an educator (drafts included). */
    entriesOn(tenant, educatorRef, date) {
      const out = [];
      for (const [e, ids] of entries) {
        const b = capsules.get(ids[0]).body;
        if (b.tenant === tenant && b.actor.educator_ref === educatorRef && b.session.date === date) out.push(e);
      }
      return out;
    },

    putSeal(seal) {
      write('seals', nextName(), JSON.stringify(seal));
      if (!seals.has(seal.scope)) seals.set(seal.scope, []);
      seals.get(seal.scope).push(seal);
    },
    seals: scope => seals.get(scope) || [],
    latestSeal(scope) { const s = seals.get(scope); return s && s.length ? s[s.length - 1] : null; },

    putCountersignature(cs) { write('countersignatures', nextName(), JSON.stringify(cs)); countersigs.push(cs); },
    countersignaturesFor: (type, id) => countersigs.filter(cs => cs.target.type === type && cs.target.id === id),

    /** Evidence bytes by hash (from memory, or from disk after a restart). */
    getEvidence(id) {
      const m = evidence.get(id);
      if (m && m.bytes) return m.bytes;
      if (!dir) return null;
      try { return fs.readFileSync(path.join(dir, 'evidence', String(id).slice(7))); } catch { return null; }
    },

    /** All capsules (optionally one tenant's), in no particular order. */
    *capsules(tenant) { for (const c of capsules.values()) if (!tenant || c.body.tenant === tenant) yield c; },

    /** Jobs: kept in memory; with a dir, also on disk minus anything marked `volatile` (e.g. transcripts). */
    putJob(job) {
      jobs.set(job.id, job);
      if (!dir) return;
      const { waiters, volatile, ...durable } = job;
      fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
      const file = path.join(dir, 'jobs', `${job.id}.json`);
      fs.writeFileSync(file + '.tmp', JSON.stringify(durable));
      fs.renameSync(file + '.tmp', file);
    },
    getJob: id => jobs.get(id) || null,
    jobs: () => [...jobs.values()],
    deleteJob(id) {
      jobs.delete(id);
      if (dir) try { fs.unlinkSync(path.join(dir, 'jobs', `${id}.json`)); } catch { /* already gone */ }
    },
  };
}

module.exports = { createStore };
