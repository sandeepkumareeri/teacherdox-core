# TeacherDox Core — Architecture

| | |
|---|---|
| **Document** | CORE-00 |
| **Status** | Draft 1 — 27 Oct 2026 |
| **Builds on** | `.tdx` 1.0 (RFC-001, Capsule Specification) and RFC-002 (Lifecycle & Trust), written before Oct 2026 for the TeacherDox product |
| **Introduces** | `.tdx` 2.0 — the universal teaching record (see `tdx-2.0.md`) |

> **Teaching documentation infrastructure for the world.**
> Every session taught, anywhere, in any language, captured in seconds and recorded for good.

---

## 1. The problem, stated generally

Almost everyone who teaches must prove what they taught:

| Who teaches | What they must record | Why |
|---|---|---|
| School teachers | Teaching diary / lesson log, per period | Inspection, headmaster countersignature |
| Lecturers and professors | Course file, lecture record, attendance | Accreditation (e.g. NAAC/NBA in India, ABET/AACSB elsewhere) |
| Tutors and coaching centres | Session notes | Parents, owners, payment |
| Corporate and vocational trainers | Training record | Compliance, certification |
| Independent / online educators | Proof of sessions delivered | Clients, invoicing |

Today these records are written **by hand, hours later, from memory**, in formats that cannot be exchanged, verified or analysed. The cost is time (30–45 minutes a day for a school teacher), accuracy (memory decays), and trust (a handwritten diary proves nothing).

**TeacherDox Core** is the layer that turns raw classroom evidence into a **verified, signed, portable teaching record** — for any educator, any institution, any country, any language.

---

## 2. Design principles

1. **Capture is a reflex, never a form.** The educator sends what they already have — a board photo, a 15-second voice note, a line of text — on a channel they already use. Nothing else is asked.
2. **AI carries the cognitive load, honestly.** Models do the reading, listening and structuring; every field carries a confidence; nothing guessed is presented as certain.
3. **One record shape for all teaching.** A school period, a university lecture, a lab, a tutoring hour and a corporate workshop are the same kind of record (`.tdx` 2.0), configured differently.
4. **Trust is verifiable, not asserted.** Locked records are canonical, signed, hash-chained and checkable by anyone with the public keys — without trusting our database.
5. **New country, new language, new kind of institution = configuration, not code.** Language, institution and country behaviour live in packs.
6. **Capture never waits for AI.** Evidence is accepted instantly and processed asynchronously; a burst of thousands of educators at the end of the day degrades latency, never correctness.
7. **Privacy by construction.** Records carry opaque references, not names. Evidence is content-addressed and stored separately. Data stays in the region chosen by the institution.
8. **Open at the edges.** The record format, schema and verifier are open (Apache-2.0) so ministries, LMS vendors and institutions can read, store and verify records without depending on TeacherDox.

---

## 3. System overview

```
                 ┌───────────────────────────── Channels ─────────────────────────────┐
                 │  WhatsApp (first)   ·   Web/API   ·   (later: SMS, offline app, LMS)  │
                 └──────────────────────────────────┬─────────────────────────────────┘
                                                    │ evidence (photo · voice · text) + context
                                                    ▼
┌──────────────┐   accept    ┌────────────────────────────────────────────────────────────┐
│  CAPTURE     │───instant──▶│  Evidence store (content-addressed, sha256)  + work queue   │
└──────────────┘             └──────────────────────────┬─────────────────────────────────┘
                                                        ▼
┌──────────────────────────────── RECORD ENGINE (agentic, multi-model) ───────────────────────────────┐
│  1. Locate   — SAM 3.1 finds and crops the board / slide / document in a photo                       │
│  2. Listen   — Muse Voice Transcribe: voice note → text, any language                                │
│  3. Read     — Muse Spark: board + transcript + educator context → structured session record         │
│  4. Check    — verifier step: cross-checks fields against evidence, flags contradictions             │
│  5. Score    — per-field confidence + field classes (critical / material / soft) → routing decision  │
│  Model router: Meta models first; fallback model on error/limit; provenance recorded per field        │
└──────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                               ▼
┌──────────────────────────────── TRUST LAYER ────────────────────────────────┐
│  draft → (auto_locked | confirmed_locked | held)   per policy profile       │
│  JCS canonical form → Ed25519 signature → capsule_hash → daily hash chain   │
│  amendments = new capsules (never mutation) · optional daily Merkle seal    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌──────────────────────────────── CONSUME ────────────────────────────────────┐
│  REST API · web record view · approver countersign · PDF registers          │
│  Public verifier (web + CLI + library) · exports to institution systems     │
└─────────────────────────────────────────────────────────────────────────────┘

Packs (configuration): locales/ · institutions/ · countries/ · policies/
```

---

## 4. Components

### 4.1 Capture
- Accepts evidence from any channel adapter, stores bytes once under `sha256:<hash>`, enqueues a job, and acknowledges immediately.
- Context attached at capture: educator ref, institution ref, channel, captured_at (UTC), optional session hint ("Period 2", "Lecture CS201", "8B").
- WhatsApp is the reference channel (the existing TeacherDox product). Channels are adapters; the core never depends on one.

### 4.2 Record Engine
- **Agentic pipeline** of small, single-purpose steps (locate, listen, read, check, score). Each step is a model call with a typed input/output, logged with model id, latency, cost and confidence.
- **Model router.** Each step names a capability (`segment`, `transcribe`, `structure`, `verify`), not a model. The router maps capabilities to providers in priority order (Meta Model API → Meta open weights via a partner → fallback provider), retries, and falls back on error, timeout or budget limit. The chosen provider is written into the record's provenance.
- **Output** is a `.tdx` 2.0 body in `draft`, with per-field confidence and evidence links.

### 4.3 Trust layer
- Implements RFC-002 generalised to `.tdx` 2.0: lifecycle states, confidence-gated routing, policy profiles, custodial Ed25519 signing with a published key registry, per-educator daily hash chain, amendments as new capsules, optional daily Merkle seal.
- **Verification needs only public keys** and the capsules — no access to TeacherDox systems.

### 4.4 Packs
- **Locale packs** (`packs/locales/<bcp47>.json`): every educator-facing string. Starting set: `en`, `ml`, `te`, `hi`, `pt-BR`, `id`, `fr`.
- **Institution packs** (`packs/institutions/<type>.json`): vocabulary and session model — `school` (period, class, section, headmaster), `university` (course, lecture, lab, head of department), `academy` (batch, session, owner), `training` (programme, module, supervisor).
- **Country packs** (`packs/countries/<iso>.json`): default time zone(s), approver hierarchy names (e.g. India: headmaster → MEO → DEO), academic calendar conventions, default locale(s), data-residency region.
- **Policy packs** (`packs/policies/<profile>.json`): confidence thresholds and signing requirements per trust profile.

### 4.5 Interfaces
- **REST API** (`/v1`): submit evidence, read records, confirm fields, countersign, fetch day chains and seals, verify.
- **Verifier**: a dependency-light JavaScript library + CLI (`tdx verify`) + a public web page.
- **Renderers** (web view, PDF) consume only locked capsules.

---

## 5. Scale model

| Concern | Approach |
|---|---|
| Bursty load (end of day) | Accept-then-queue; workers scale by queue depth; capture latency stays flat |
| Cost per record | Measured per step (tokens, seconds, provider) and reported per educator / per institution |
| Model outages and quota | Router fallback chain; every record still produced, provenance shows which model |
| Storage | Capsules are kilobytes (evidence by hash, never inline); evidence in object storage with lifecycle rules |
| Multi-region | Institution chooses a residency region; capsules and evidence stay there; verification is global |

---

## 6. What this hackathon builds (Oct 27 – Nov 4, 2026)

Everything in this repository is new work for the Meta Global AI Developer Hackathon unless marked otherwise. `.tdx` 1.0 / RFC-001 / RFC-002 pre-date the hackathon and are the starting point; see `HACKATHON.md` for a dated log.

1. `.tdx` 2.0 specification, JSON Schema and reference implementation (canonical form, hashing, signing, chain, verification).
2. Record Engine on Meta's models (SAM 3.1, Muse Voice Transcribe, Muse Spark) with a capability router and fallback.
3. Locale, institution, country and policy packs.
4. REST API and public verifier (web + CLI).
5. Queue-based capture pipeline and cost/latency telemetry.
6. Evaluation harness and results on real, consented samples.
7. Integration into the live TeacherDox WhatsApp product as the first channel.
