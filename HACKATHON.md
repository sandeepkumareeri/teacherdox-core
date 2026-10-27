# Hackathon log — Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026)

TeacherDox is entered in the **Startup track**, theme **Build for Your World**.

## Built before the hackathon (starting point, not hackathon work)
- The TeacherDox WhatsApp product (private repository): capture on WhatsApp, live diary, sign/countersign, dashboards, PDFs, Gemini-based entries.
- `.tdx` 1.0 capsule specification (RFC-001) and lifecycle & trust model (RFC-002), as design documents. No reference implementation existed.

## Built during the hackathon (this repository)
Every commit in this repository is dated. Summary by day:

| Date (IST) | Work |
|---|---|
| Tue Oct 27 | CORE-00 architecture; `.tdx` 2.0 universal teaching record spec; reference implementation of the trust layer (RFC 8785 canonical form, UUIDv7, Ed25519 signing, capsule hash, daily hash chain, amendments, verification, Merkle day seal) with tests; Meta Model API probed live (Muse Spark text/vision/JSON schema, SAM 3.1, Muse Voice Transcribe) — notes in `docs/meta-model-api-notes.md`; CLAUDE.md handover |
| Tue Oct 27 (evening) | `.tdx` 2.0 normative JSON Schema + dependency-free validator (applied by `verifyCapsule`); **Record Engine** (`src/engine/`): capability router with fallback, consent filter and daily limits; Meta provider (SAM 3.1 board box, Muse Voice Transcribe with OGG→WAV, Muse Spark strict-schema read and verify); host-supplied Gemini fallback; locate → listen → read → check → score pipeline producing schema-valid draft capsules with per-step provenance and confidence routing; 32 tests; live-run workflow on synthetic evidence |
| Tue Oct 27 (night) | **Packs**: locale packs in 7 languages (en, ml, te, hi, pt-BR, id, fr; non-English marked as draft translations pending native review), institution packs for school / college / university / academy / training / independent, country packs IN / BR / ID / FR / SN, policy packs personal / school_compliance / government_audit / low_connectivity; pack loader with plurals and per-institution field labels; the Record Engine now takes vocabulary, field classes, time zone, record language, thresholds, steps and capture-lag rules from packs; `describe()` gives one educator-facing sentence per outcome; 42 tests |
| Tue Oct 27 (API) | **REST API** `/v1` on `node:http` (capture → background job → draft; lock / confirm with corrections / amend; approver countersignatures of records and of sealed days; day seal and Merkle proofs; exportable day; public verify; per-tenant tokens; file-backed store); **countersignatures** in the trust layer (spec §8); **public verifier page** that verifies in the browser with a second, WebCrypto-only implementation that must agree with the reference; **`tdx` CLI** (verify, validate, hash, keygen, process, serve); synthetic sample day; 53 tests |
| Tue Oct 27 (queue) | **Durable work queue**: capture returns at once; jobs are files that survive restarts and are re-run, with pre-assigned entry ids so a crash never makes a record twice; retry with backoff for model outages; back-pressure (`503 Retry-After`). **Telemetry** (`GET /v1/telemetry`): cost, latency percentiles, tokens, fallback rate and routing outcomes per step, provider and model, computed from record provenance; 60 tests |
