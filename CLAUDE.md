# CLAUDE.md — TeacherDox Core

Guidance for Claude Code in this repository.

## What this is

**TeacherDox Core — teaching documentation infrastructure for the world.** The infrastructure layer
behind the TeacherDox WhatsApp product (private repo `sandeepkumareeri/teacherdox`): the open `.tdx`
2.0 teaching record, a multimodal Record Engine on Meta's models, a verifiable trust layer, packs
(locale / institution / country / policy) and a REST API. Any educator (school teacher, lecturer,
professor, tutor, trainer), any institution, any country, any language.

This repo is the **public submission repository for the Meta Global AI Developer Hackathon**
(building Oct 27 – Nov 4, 2026; submit by Nov 4 9 PM ET = Nov 5 07:30 IST). Everything here is new
hackathon work; keep `HACKATHON.md` updated with a dated line per day of work.

Read first: `spec/00-core-architecture.md`, `spec/tdx-2.0.md`, `docs/meta-model-api-notes.md`.
The private product's hackathon brief is `docs/meta-hackathon.md` in the `teacherdox` repo
(rules, framing, demo plan).

## Commands

```bash
npm test        # node --test test/*.test.js — no dependencies needed
```

Node ≥ 20, plain CommonJS, **no runtime dependencies so far** — keep `src/tdx` dependency-free.

## Status (27 Oct 2026, evening)

Done:
- `spec/00-core-architecture.md`, `spec/tdx-2.0.md` (§6 schema conformance, §7 provenance step fields).
- `src/tdx/` trust layer: RFC 8785 canonical JSON, UUIDv7, Ed25519 keys/sign/verify with validity &
  revocation, capsule hash, `draft` → `lock` (auto/confirmed) with per-educator daily hash chain,
  `amend` (new capsule, same entry_id), `verifyCapsule` / `verifyDay` (RFC-002 §10), Merkle day seal
  + inclusion proofs.
- `spec/schema/tdx-2.0.schema.json` (normative, JSON Schema 2020-12) + `src/tdx/schema.js`
  (dependency-free validator; `verifyCapsule` applies it).
- `src/engine/` Record Engine: `router.js` (capabilities `segment|transcribe|structure|verify`,
  priority order, fallback on error/timeout/unsupported input/consent/daily limit, provenance step per
  call), `providers/meta.js` (SAM 3.1 `/responses` box parsing, Muse Voice Transcribe `/asr/transcribe`
  with OGG→WAV via ffmpeg and no Malayalam, Muse Spark strict JSON schema; refuses `-contributor`
  models), `providers/gemini.js` (`fromGenerate(hostGenerate)` — the host supplies Gemini, the core
  never calls Google), `media.js` (ffmpeg optional: WAV conversion, board crop), `prompts.js`
  (read + check prompts and strict schemas; subject ≠ unit), `score.js` (field classes, institution
  promotions, policies `personal|school_compliance|government_audit` → `auto_lock|confirm|hold`),
  `engine.js` (locate ∥ listen → read → check → score → schema-valid draft capsule; transcripts and
  crops returned beside the capsule, never inside it).
- `packs/` + `src/packs/` (see `packs/README.md`): locales en, ml, te, hi, pt-BR, id, fr (non-English
  marked `review: draft translation` until a native speaker checks them); institutions for all six
  `institution_type`s (session kinds, field terms, promotions, approver, model vocabulary); countries
  IN, BR, ID, FR, SN (time zones, record language, approver hierarchy, calendar); policies personal,
  school_compliance, government_audit, low_connectivity (thresholds, steps, max capture lag, auto-lock,
  approval). The engine takes promotions/vocabulary/kinds from institution packs, time zone and record
  language defaults from country packs, thresholds/steps/lag/auto-lock from policy packs.
  `packs.describe(result)` = one educator-facing sentence per outcome.
- Tests: 42 passing (`test/tdx.test.js`, `test/schema.test.js`, `test/engine.test.js`,
  `test/packs.test.js`; shared mocks in `test/helpers.js` — the Meta API mocked per the notes;
  ffmpeg tests skip without ffmpeg).
- `scripts/engine-live.js` + `.github/workflows/engine-live.yml`: live run on synthetic evidence
  (board fixture + espeak-ng OGG voice notes in en/hi/te/ml/pt). **Not yet run** — needs the
  `META_API_KEY` secret on this repo (optional `GEMINI_API_KEY` secret + `GEMINI_MODEL` variable).
- Meta Model API probed live (see `docs/meta-model-api-notes.md`): Muse Spark text + vision + JSON
  schema, SAM 3.1 board box, Muse Voice Transcribe (WAV only; no Malayalam).

Open questions to check against dev.meta.ai (do not guess): system-role messages for Muse Spark (the
engine puts instructions in the user turn); exact `languageBias` names beyond Hindi/English/Portuguese;
Muse Spark per-token price (cost is recorded as `null` until known; ASR uses $0.18/h).

Next, in order:
1. Run *Engine live run* in Actions; fix anything the real API disagrees with; record results in
   `docs/meta-model-api-notes.md`.
2. Native-speaker review of the ml / te / hi / pt-BR / id / fr packs (ask Sandeep).
3. REST API `src/api/` (Node http, no framework needed) + public verifier page + `bin/tdx` CLI
   (`tdx verify file.json --keys keys.json`).
4. Queue-based processing + cost/latency telemetry.
5. `eval/`: harness comparing Meta vs Gemini on consented samples (accuracy, latency, cost).
6. Integration into the private product as the first channel (its `gemini.js` boundary:
   `fromGenerate(gemini.generate)` as fallback, `allow_providers` from `META_AI_PHONES`).

## Rules

- **Never commit secrets, keys, real educator data, photos or voice notes.** Fixtures must be
  synthetic or explicitly consented. `.gitignore` covers `*.pem`, `keys/`, `eval/data/`.
- Meta calls need `META_API_KEY`; the sandbox may not reach api.meta.ai — run live calls from GitHub
  Actions or the TeacherDox server, report results as annotations.
- Don't guess Meta API details beyond `docs/meta-model-api-notes.md`; check dev.meta.ai docs.
- Frame everything as infrastructure / an agentic verifiable-records pipeline, never as an
  "AI for education chatbot" or "image analyzer" (banned hackathon categories).
- Honest claims only: no user numbers, endorsements or partnerships we don't have.
- Signed capsules are immutable; corrections are new capsules (`amend`).
