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
| `src/tdx/` | Reference implementation: canonical form, signing, chain, verification, seals |
| `test/` | Tests (`npm test`) |

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

## License

Apache-2.0. The `.tdx` format is open so that institutions, ministries and software vendors can read, store and verify teaching records without depending on TeacherDox.

TeacherDox Private Limited · teacherdox.com
