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

Built on branch `claude/exciting-faraday-exxt9l` (ahead of the plan below; gaps against the quality
bar are listed under "Missing"):
- Spec: `spec/00-core-architecture.md`, `spec/tdx-2.0.md` (§6 schema conformance, §7 provenance step
  fields, §8 countersignatures), normative `spec/schema/tdx-2.0.schema.json`.
- `src/tdx/` trust layer (zero deps): RFC 8785 canonical JSON, UUIDv7, Ed25519 keys/sign/verify with
  validity & revocation, capsule hash, `draft` → `lock` with per-educator daily hash chain, `amend`,
  `verifyCapsule` / `verifyDay`, Merkle day seal + proofs, countersignatures, `schema.js` validator.
- `src/engine/` Record Engine: router (`segment | transcribe | structure | check`, priority order,
  fallback on error/timeout/unsupported input/consent/daily limit, provenance per call); providers
  `meta` (SAM 3.1, Muse Voice Transcribe with OGG→WAV, Muse Spark strict JSON schema; refuses
  `-contributor` models) and `fromGenerate(hostGenerate)` fallback; locate ∥ listen → read → check →
  score → schema-valid draft capsule; nothing usable → held, never invented.
- `packs/` + `src/packs/`: locales en, ml, te, hi, pt-BR, id, fr (non-English = draft translations);
  6 institutions; countries IN, BR, ID, FR, SN; policies personal, school_compliance,
  government_audit, low_connectivity; `describe()`.
- `src/api/` REST `/v1` (capture → durable queue → draft; lock / confirm / amend / countersign; day
  seal, proofs, export; public verify; telemetry), `src/verifier/` (reference + WebCrypto
  implementation, identical reports), `verifier/` public page, `bin/tdx` (verify, validate, hash,
  keygen, process, serve). Docs: `docs/api.md`, `packs/README.md`.
- Tests: `npm test` — 83 (tdx, schema, vectors, engine, packs, verifier, api, queue, baseten, eval).
- Live runs: `.github/workflows/photo-live.yml` (photo pipeline on Meta, synthetic board) — **first
  live run succeeded 27 Oct** (SAM box exact, read correct, check flagged the inferred subject → confirm;
  12.4 s; see `docs/meta-model-api-notes.md`). The repo's `META_API_KEY` lost model access 11:49–~12:20
  UTC; fixed by Sandeep, then answered 404 `model_not_found` again in eval run 40528431277 (15:14 UTC).
  `GEMINI_API_KEY` set; `GEMINI_MODEL` unset → eval picks the newest stable Flash (`gemini-3.8-flash`), but the
  key's AI Studio prepaid credits are depleted (HTTP 402).
  `engine-live.yml` (all languages) not yet run. The sandbox cannot reach api.meta.ai or baseten.co.
- `src/engine/providers/baseten.js`: Muse Spark Open (Meta open weights) on Baseten,
  `meta-models/muse-spark-open-1026`, third in the provider order (Meta API → Baseten → host fallback).
  Facts in `docs/meta-model-api-notes.md` (from docs fetched by `baseten-docs.yml` and the live
  `baseten-probe.yml`): always reasons, schema not enforced server-side (validated here), images/audio
  as data URLs (`audio_url`), $1.25/$4.25 per 1M tokens. Audio input inconsistent → transcription off by
  default (`transcribeLanguages: []`), Malayalam not routed to it.
- `eval/`: cases (12 synthetic boards rendered in CI, 8 espeak voice notes), `score.js` (rules pinned by
  `test/eval.test.js`), `run.js` (meta / baseten / gemini, no cross-provider fallback, API-failed configs
  marked not comparable), `.github/workflows/eval.yml`, `eval/RESULTS.md` (run 40503572389: Meta Model API 81% vs Muse Spark
  Open 67% field accuracy; boards 98% both; Meta voice en/hi/pt good, te/ml held; Gemini not run — no key).

Missing against the quality bar: Gemini column in `eval/RESULTS.md` (needs Gemini credits, and the Meta key working in the same run); API error shape `{error:{code,message}}` + `spec/openapi.yaml`;
CLI `inspect` / `seal`; JSDoc + `tsc --checkJs`; coverage; CI + CodeQL; SECURITY /
CONTRIBUTING / CODE_OF_CONDUCT / CHANGELOG; quickstart + how-a-record-is-born + Mermaid diagrams;
README rewrite; verifier page in brand style (#1B5E3B, DM Sans/Mono); tag v0.1.0.

Open questions to check against dev.meta.ai (do not guess): system-role messages for Muse Spark (the
engine puts instructions in the user turn); exact `languageBias` names beyond Hindi/English/Portuguese;
Muse Spark per-token price (cost is recorded as `null` until known; ASR uses $0.18/h).

## Quality bar — build this like a top platform team would

The repo must read as if a world-class platform team built it: discipline, not size. Every claim
tested, every behaviour written down, a stranger can verify everything in five minutes. (Quality
*like* theirs only — never use Meta's/Apple's names, logos or styling as if they made it.)

1. **Specification** — `.tdx 2.0` in RFC style (MUST/SHOULD/MAY, every field defined), normative
   `spec/schema/tdx-2.0.schema.json`, and **test vectors** in `spec/vectors/` (synthetic records
   with a fixed test key, their canonical bytes, capsule hashes, signatures, chain links, seal roots
   and proofs; valid and deliberately invalid cases) so any implementation in any language can check
   itself. Vectors are generated by a script and verified by the test suite.
2. **Code** — zero runtime deps in `src/tdx`; JSDoc types checked with `tsc --noEmit --checkJs`
   (dev dependency only, no build step); tests for every MUST in the spec (tamper, gaps, duplicates,
   revocation, key validity, amendments, seals); aim for ~100% coverage of the trust layer
   (`node --test --experimental-test-coverage`).
3. **Record Engine** (`src/engine/`) — shows its work: every step writes provenance (provider,
   model, ms, tokens, cost); per-field confidence; uncertain fields routed to the educator, never
   silently saved; Meta first, fallback visible in the record.
4. **API** — `src/api/` on Node `http`, versioned `/v1`, stable error codes (`{error:{code,message}}`),
   `spec/openapi.yaml`; `bin/tdx` CLI (`tdx verify`, `tdx inspect`, `tdx keygen`, `tdx seal`);
   a public **verifier page** (static HTML, verification runs in the browser via WebCrypto Ed25519:
   ✓ signed ✓ unchanged ✓ in the day's chain).
5. **Proof with numbers** — `eval/` harness, Meta vs Gemini on synthetic/consented samples: per-field
   accuracy, latency, cost per record. Publish `eval/RESULTS.md` honestly, including where Meta was
   weaker. Real numbers only, from real runs (GitHub Actions annotations).
6. **Hygiene** — CI on every push (`.github/workflows/ci.yml`: tests, type check, coverage, CodeQL);
   `SECURITY.md` with a threat model (what can be forged, what can't, key compromise, replay);
   `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`; tag release `v0.1.0`.
7. **Docs** — README a judge gets in 30 seconds (one diagram, one sentence, one command);
   `docs/quickstart.md` (5 minutes), `docs/how-a-record-is-born.md` (photo → signed capsule, step
   by step, with a real example output), architecture diagrams (Mermaid).
8. **Presentation** — calm and premium, consistent across README, verifier page and demo: white
   space, one accent colour (TeacherDox green `#1B5E3B`), DM Sans / DM Mono where fonts apply.

Never: fake badges, stars, user numbers, "audited"/"enterprise scale" claims, or SDKs in many
languages (one excellent implementation + test vectors beats that). State what was measured.

## Plan — finish the core in 3 days (27–29 Oct), not by 4 Nov

Work in this order; commit and push working increments often; keep `npm test` green; add a dated
line to `HACKATHON.md` each day. If a day slips, cut scope from the bottom of that day, never skip
tests or the spec.

**Day 1 — Tue 27 Oct: the contract + photo → signed record**
- JSON Schema + light validator (dependency-free) + test vectors + vector tests.
- Engine skeleton: capability router (`segment`, `transcribe`, `structure`, `check`) with providers
  `meta` and `fallback` (fallback supplied by the host via an adapter — core never hard-depends on
  Google); provenance per step.
- Photo pipeline on Meta: SAM 3.1 box → crop → Muse Spark JSON schema → `.tdx 2.0` body with
  per-field confidence (subject separate from unit/chapter) → `draft` capsule. A GitHub Actions
  workflow runs it live on the synthetic board and reports the capsule as annotations.

**Day 2 — Wed 28 Oct: voice, languages, check, API**
- Voice: OGG→WAV via ffmpeg when present; Muse Voice Transcribe; language routing (`ml` → fallback).
- Check pass (second call cross-checks fields against evidence, flags contradictions) + score/route
  by RFC-002 field classes and policy thresholds.
- Packs, minimum useful set: locales en, hi, te, ml, pt-BR; institutions school, university,
  training; policies personal, school_compliance.
- REST API `/v1` + `spec/openapi.yaml` + `bin/tdx` CLI.

**Day 3 — Thu 29 Oct: proof, polish, release**
- Verifier page (browser-side verification).
- Eval harness + first real results in `eval/RESULTS.md`.
- CI, type check, coverage, CodeQL; `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `CHANGELOG.md`; docs (quickstart, how-a-record-is-born, diagrams); README rewrite; tag `v0.1.0`.

**After the core (30 Oct – 4 Nov, in the private `teacherdox` repo):** integrate the engine as the
product's AI backend behind its `gemini.js` boundary (Meta first, Gemini fallback, allow-listed
numbers), live WhatsApp demo with demo/consented data, demo video, submission. Queue-based
processing + telemetry dashboard only if time remains.

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
