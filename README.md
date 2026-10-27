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

Providers are tried in order and skipped when they lack the capability, cannot take the input, are not allowed for this educator (`allow_providers`, for consent) or have hit their daily limit; errors and timeouts fall through. If nothing usable was read or heard, no model is asked to invent a record — the draft is held.

## License

Apache-2.0. The `.tdx` format is open so that institutions, ministries and software vendors can read, store and verify teaching records without depending on TeacherDox.

TeacherDox Private Limited · teacherdox.com
