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

## Status (27 Oct 2026)

Done:
- `spec/00-core-architecture.md`, `spec/tdx-2.0.md`.
- `src/tdx/` trust layer: RFC 8785 canonical JSON, UUIDv7, Ed25519 keys/sign/verify with validity &
  revocation, capsule hash, `draft` → `lock` (auto/confirmed) with per-educator daily hash chain,
  `amend` (new capsule, same entry_id), `verifyCapsule` / `verifyDay` (RFC-002 §10), Merkle day seal
  + inclusion proofs. 9 passing tests in `test/tdx.test.js`.
- Meta Model API probed live (see `docs/meta-model-api-notes.md`): Muse Spark text + vision + JSON
  schema, SAM 3.1 board box, Muse Voice Transcribe (WAV only; no Malayalam).

Next, in order:
1. `spec/schema/tdx-2.0.schema.json` (normative JSON Schema) + a light validator.
2. **Record Engine** `src/engine/`: capability router (`segment`, `transcribe`, `structure`, `verify`)
   → providers `meta` (Meta Model API) and `fallback` (Gemini, supplied by the host app via an
   adapter — the core must not hard-depend on Google); per-step provenance (provider, model, ms,
   tokens, cost); language routing (Malayalam → fallback for transcription); OGG→WAV conversion
   via ffmpeg when available.
   Pipeline: locate (SAM 3.1 box → crop) → listen → read (Muse Spark JSON schema producing a
   `.tdx` 2.0 body + per-field confidence; separate subject vs unit) → check (second pass that
   cross-checks fields against evidence, flags contradictions) → score/route (RFC-002 field classes,
   policy thresholds) → `draft` capsule.
3. Packs `packs/`: locales (en, ml, te, hi, pt-BR, id, fr), institutions (school, university, academy,
   training), countries (IN, BR, ID, FR/SN…), policies (personal, school_compliance,
   government_audit, low_connectivity).
4. REST API `src/api/` (Node http, no framework needed) + public verifier page + `bin/tdx` CLI
   (`tdx verify file.json --keys keys.json`).
5. Queue-based processing + cost/latency telemetry.
6. `eval/`: harness comparing Meta vs Gemini on consented samples (accuracy, latency, cost).
7. Integration into the private product as the first channel (its `gemini.js` boundary).

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
