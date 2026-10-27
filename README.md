# TeacherDox Core

**Teaching documentation infrastructure for the world.**

Every session taught — a school period, a university lecture, a lab, a tutoring hour, a corporate workshop — captured in seconds from a photo or a voice note, in any language, and turned into a **verified, signed, portable teaching record**.

TeacherDox Core is the infrastructure layer behind the TeacherDox WhatsApp product: an open record format (`.tdx` 2.0), a multimodal record engine built on Meta's models, and a trust layer that anyone can verify.

> Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). See [`HACKATHON.md`](HACKATHON.md) for exactly what was built and when.

## Why

Almost everyone who teaches has to prove what they taught — for inspections, accreditation, parents, clients or compliance. Today that means writing it by hand, hours later, from memory, in formats nobody can verify or exchange. School teachers alone spend 30–45 minutes a day on it.

## How it works

```
photo · voice note · text  ──▶  Record Engine (Meta models)  ──▶  .tdx record  ──▶  sign · chain · verify
   (WhatsApp first)              locate → listen → read → check       (any institution,     (anyone, with
                                                                       any language)          public keys)
```

- **Capture** on the channel educators already use (WhatsApp first). Capture never waits for AI.
- **Record Engine:** SAM 3.1 finds the board, Muse Voice Transcribe hears the voice note in any language, Muse Spark reads and structures the session, a check step cross-examines the result; every field carries a confidence.
- **Trust:** canonical JSON (RFC 8785), Ed25519 signatures, per-educator daily hash chains, amendments as new records, daily Merkle seals. Verification needs only public keys.
- **Global by configuration:** language, institution and country packs.

## Repository

| Path | What |
|---|---|
| [`spec/00-core-architecture.md`](spec/00-core-architecture.md) | System architecture |
| [`spec/tdx-2.0.md`](spec/tdx-2.0.md) | The `.tdx` 2.0 universal teaching record |
| [`spec/schema/tdx-2.0.schema.json`](spec/schema/tdx-2.0.schema.json) | Normative JSON Schema (2020-12) |
| `src/tdx/` | Reference implementation: canonical form, signing, chain, verification, seals, schema validator |
| `src/engine/` | Record Engine: capability router, Meta provider (SAM 3.1, Muse Voice Transcribe, Muse Spark), host-supplied fallback, locate → listen → read → check → score |
| [`packs/`](packs/README.md) | Locale (en, ml, te, hi, pt-BR, id, fr), institution, country (IN, BR, ID, FR, SN) and policy packs |
| `src/packs/` | Pack loader, `t()` with plurals, field labels per institution, `describe()` for engine results |
| `src/api/` | REST API `/v1` on `node:http` — capture, lock / confirm / amend, countersign, day seal, proofs, verify, telemetry; durable work queue ([`docs/api.md`](docs/api.md)) |
| `src/verifier/` | Verification report for any input; a second, WebCrypto-only verifier that runs in the browser |
| [`verifier/`](verifier/index.html) | Public verifier page (served at `/verify/`), its browser bundle and a synthetic sample day |
| `bin/tdx` | CLI: `verify`, `validate`, `hash`, `keygen`, `process`, `serve` |
| `test/` | Tests (`npm test`) — Meta API mocked with the shapes in `docs/meta-model-api-notes.md` |
| `scripts/engine-live.js` | Live run on synthetic evidence (Actions → *Engine live run*, needs `META_API_KEY`) |

## Quick start

```bash
npm test
```

```js
const tdx = require('./src/tdx');
const key = tdx.generateKey('k_2026_10');
const draft = tdx.draft({ tenant: 't_demo', actor: { educator_ref: 'e_1', institution_ref: 'i_1', institution_type: 'university' },
  session: { kind: 'lecture', date: '2026-10-28', timezone: 'America/Sao_Paulo', course: 'CS201', subject: 'Data Structures' } });
const record = tdx.lock(draft, { key });
tdx.verifyCapsule(record, { keys: [key.publicEntry] });   // → { ok: true, ... }
```

### Record Engine

```js
const { createRecordEngine, fromGenerate } = require('./src/engine');
const engine = createRecordEngine({
  fallback: fromGenerate(myGeminiGenerate),        // optional; the core never calls Google itself
  dailyLimit: { meta: 500 },                       // a bug cannot burn the credits
});
const { capsule, routing, transcripts } = await engine.process({
  evidence: [{ bytes: boardJpeg, media_type: 'image/jpeg' }, { bytes: voiceOgg, media_type: 'audio/ogg' }],
  text: 'P2',
  context: { tenant: 't_demo', educator_ref: 'e_1', institution_ref: 'i_1', institution_type: 'school',
    locale: 'te-IN', record_locale: 'en', country: 'IN', timezone: 'Asia/Kolkata', date: '2026-10-28',
    channel: 'whatsapp', session: { label: 'P2' }, allow_providers: ['meta', 'gemini'] },
});
// capsule: a valid draft .tdx 2.0 record (hashes only, no bytes or transcripts), with
//          per-step provenance: provider, model, status, ms, tokens, cost
// routing: { decision: 'auto_lock' | 'confirm' | 'hold', confirm_fields, reasons, ... }
```

| Step | Capability | Meta model | Without it |
|---|---|---|---|
| locate | `segment` | SAM 3.1 — finds the board; ffmpeg crops to it | whole photo is read |
| listen | `transcribe` | Muse Voice Transcribe — OGG/Opus → 16 kHz WAV via ffmpeg | fallback provider (always for Malayalam, which Meta does not support) |
| read | `structure` | Muse Spark, strict JSON schema, per-field confidence | fallback provider |
| check | `verify` | Muse Spark, second pass: each field supported / unsupported / contradicted | record cannot be auto-locked |
| score | — | field classes (critical / material / soft) × policy | — |

Institution, country and policy packs shape every run: the vocabulary the model is given, which fields are critical (a university's course, a school's class), the time zone and record language when the channel does not send them, the confidence thresholds, and how late a capture may be. `packs.describe(result)` turns the outcome into one sentence in the educator's language (e.g. Malayalam: "രേഖപ്പെടുത്തി. ഒപ്പിടാൻ തയ്യാർ.").

Providers are tried in order and skipped when they lack the capability, cannot take the input, are not allowed for this educator (`allow_providers`, for consent) or have hit their daily limit; errors and timeouts fall through. If nothing usable was read or heard, no model is asked to invent a record — the draft is held.

### API, verifier and CLI

```bash
tdx keygen k_2026_10                                   # signing key (keys/ is git-ignored)
TDX_API_TOKENS=tok:t_demo TDX_SIGNING_KEY_FILE=keys/k_2026_10.pem TDX_SIGNING_KEY_ID=k_2026_10 \
  TDX_KEY_REGISTRY=keys/k_2026_10.public.json TDX_DATA_DIR=data META_API_KEY=… tdx serve
tdx verify verifier/samples/day-demo.json --keys verifier/samples/keys-demo.json   # → VALID
```

The record lifecycle over HTTP: `POST /v1/records` (capture; returns at once, the engine runs in the background) → `lock` (only if the policy allows auto-lock) or `confirm` (the educator, optionally with corrections) → `amend` (a correction is a new signed record) → `countersign` (an approver) → `POST /v1/days/…/seal` → `GET /v1/days/…` (the exportable day). See [`docs/api.md`](docs/api.md).

**Capture never waits for AI.** Capture writes the evidence and a job and returns; workers run the engine. Jobs are files, so a restart re-runs unfinished work without ever making a record twice (each job carries its entry id), transient model outages are retried with backoff, and a full queue answers `503 Retry-After` instead of slowing everyone down. `GET /v1/telemetry` reports cost, latency, fallback rate and routing outcomes per step, provider and model — computed from the provenance each record already carries.

**Verification never needs our servers.** The verifier page at `/verify/` checks signatures, the day's hash chain, the Merkle seal and countersignatures in the browser with WebCrypto — a second implementation, independent of the reference one, and the tests require both to give identical reports. The same check runs from the command line (`tdx verify`) or as a library.

## License

Apache-2.0. The `.tdx` format is open so that institutions, ministries and software vendors can read, store and verify teaching records without depending on TeacherDox.

TeacherDox Private Limited · teacherdox.com
