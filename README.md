# TeacherDox Core

**▶ [Watch the 3-minute demo](https://www.youtube.com/watch?v=BRQtIwP1mf4)** · Meta Global AI Developer Hackathon, Startup track

**WhatsApp-first teaching records infrastructure** for everyone who teaches and keeps a teaching
diary: school teachers, college lecturers, professors, tutors and trainers. An educator sends a
board photo and a voice note on WhatsApp; Meta's models turn it into a structured entry; the
educator's signature makes it a record that anyone can verify. Live in India; the open `.tdx`
record works for schools, colleges, universities, academies, training centres and independent
educators, in any country and language.

Educators already write the lesson on the board — then wipe it off and copy the same lesson into
the teaching diary by hand. **TeacherDox reads the board and writes the diary.**

| Step | What happens | Model |
|---|---|---|
| capture | after the class, the educator snaps the board and records a voice note on WhatsApp | — |
| locate | cut the photo down to the board, so only the writing is read (the wall, desks and glare around it are cut away) | **SAM 3.1** (Meta Model API) |
| listen | transcribe the voice note, in the educator's language | **Muse Voice Transcribe** (Meta Model API) |
| read | **read the board** (and the voice note and any text) and write the diary entry: class, subject, topic, summary, homework, each with a confidence | **Muse Spark** (Meta Model API) |
| check | a second call checks every field against the evidence | **Muse Spark** (Meta Model API) |
| read, check (second provider) | the same steps on Meta's open weights | **Muse Spark Open** on Baseten |
| fallback | whatever the Meta models cannot do (e.g. Malayalam speech) | a model the host plugs in (e.g. Gemini) |

```mermaid
flowchart LR
  A["photo · voice note · text"] --> B["Record Engine<br/>locate → listen → read → check"]
  B --> C{"confidence<br/>policy"}
  C -- sure --> D[signed .tdx record]
  C -- unsure --> E[educator confirms] --> D
  C -- nothing readable --> F[held, never invented]
  D --> G["daily hash chain · Merkle seal"]
  G --> H["anyone verifies<br/>with public keys"]
```

## Try it

**Check a signed teaching diary yourself (1 minute).** You need only Node.js 22 or newer — nothing
to install, no accounts:

```bash
git clone https://github.com/sandeepkumareeri/teacherdox-core && cd teacherdox-core
node bin/tdx verify verifier/samples/day-demo.json --keys verifier/samples/keys-demo.json   # → VALID
```

This checks a sample day of signed records: each one is unchanged since it was signed, signed by
the right key, and none of the day's records is missing.

**Run it on WhatsApp.** Connect a WhatsApp Business number (Meta's WhatsApp Cloud API) to
TeacherDox Core. An educator sends the number a photo of the board and a voice note; WhatsApp
replies with the diary entry and a **Sign** button. Setup: [`docs/whatsapp.md`](docs/whatsapp.md).

**Learn more.**
- [`docs/quickstart.md`](docs/quickstart.md) — make and sign your first record (5 minutes).
- [`docs/how-a-record-is-born.md`](docs/how-a-record-is-born.md) — a (synthetic) board photo becoming a
  signed record on Meta's models, step by step, with the output of a live run.

## How well the models do (measured, synthetic data)

12 synthetic board photos and 8 synthetic voice notes, each provider on its own. Full table, per
case, method and caveats: [`eval/RESULTS.md`](eval/RESULTS.md).

| | Meta Model API | Muse Spark Open (Baseten) | Gemini (`gemini-3.8-flash`) |
|---|---|---|---|
| Field accuracy, all 20 cases | **81%** | 69% | 77% |
| Boards | **98%** | **98%** | 82% (2 of 12 refused with HTTP 429; 98% on the rest) |
| Voice: en / hi / pt | 90 / 80 / 100% | 90 / 0 / 20% | 100 / 90 / 100% |
| Voice: Malayalam, Telugu | held (ml not supported; te not heard) | not heard | ml 1 of 2; te held |
| Time per record, p50 | **9.3 s** | 11.3 s | 16.1 s |
| Cost per record | not published | $0.0104 | not recorded |

Where Meta was weaker: Malayalam and Telugu voice notes, and the robotic synthetic voices may make
those numbers worse than real recordings would be. The Meta and Gemini columns come from two runs 44
minutes apart, because the Meta Model API answered 404 during the Gemini run. Twenty cases is a small
sample.

## What a record proves

Each locked record is RFC 8785 canonical JSON signed with Ed25519, linked by hash to the
educator's previous record that day, and can be covered by a signed Merkle root at the end of the day. A
verifier needs only the record and the institution's published public keys. It can show that the
record is unchanged since signing, who signed it with which key, and that no record of the day was
removed or inserted. It cannot show that the lesson happened as written. [`SECURITY.md`](SECURITY.md)
sets out what can and cannot be forged.

Corrections never edit a signed record: they are new records that point at the old one. Every
model step is written into the record (provider, model, time, tokens, cost), and fields the models
were unsure of are confirmed by the educator, never saved silently.

## What is in the repository

| Path | What |
|---|---|
| [`spec/tdx-2.0.md`](spec/tdx-2.0.md), [`spec/schema/`](spec/schema/tdx-2.0.schema.json) | The `.tdx` 2.0 record (RFC style) and its normative JSON Schema |
| [`spec/vectors/`](spec/vectors/README.md) | Test vectors with a published test key, so other implementations can check themselves |
| `src/tdx/` | Reference implementation: canonical form, signing, chain, amendments, seals, countersignatures, schema validator. No dependencies, type-checked |
| `src/engine/` | Record Engine: capability router with fallback, providers (Meta Model API, Baseten, host-supplied), confidence routing |
| [`packs/`](packs/README.md) | Languages (en, ml, te, hi, pt-BR, id, fr), institution types, countries, policies |
| [`src/channels/whatsapp/`](docs/whatsapp.md) | **WhatsApp channel** (Cloud API, no dependencies): signed webhooks → one capture per educator → Record Engine → reply; a "Sign" tap signs the record. The phone number never enters a record |
| `src/api/` | REST API `/v1`: capture, confirm, amend, countersign, seal, verify, telemetry, WhatsApp webhook ([`docs/api.md`](docs/api.md)) |
| [`verifier/`](verifier/index.html) | Verifier page: checks records in the browser with WebCrypto, nothing uploaded |
| `bin/tdx` | CLI: `verify`, `validate`, `hash`, `keygen`, `process`, `serve` |
| [`eval/`](eval/RESULTS.md) | Evaluation harness and results |
| [`docs/meta-model-api-notes.md`](docs/meta-model-api-notes.md) | What was observed calling Meta's models |

```bash
npm test              # 98 tests, Linux and Windows
npm run typecheck     # after npm install (dev dependencies only)
npm run coverage
```

CI runs all three plus CodeQL on every push. Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md).
Changes: [`CHANGELOG.md`](CHANGELOG.md). Built during the Meta Global AI Developer Hackathon
(26 Oct – 4 Nov 2026); [`HACKATHON.md`](HACKATHON.md) logs what was built and when.

## Using it from code

```js
const { createRecordEngine, fromGenerate } = require('./src/engine');
const tdx = require('./src/tdx');

const engine = createRecordEngine({ fallback: fromGenerate(hostGenerate), dailyLimit: { meta: 500 } });
const { capsule, routing } = await engine.process({
  evidence: [{ bytes: boardJpeg, media_type: 'image/jpeg' }],
  context: { tenant: 't_1', educator_ref: 'e_1', institution_ref: 'i_1', institution_type: 'school',
             country: 'IN', locale: 'en-IN', date: '2026-10-28', channel: 'whatsapp' },
});
// routing.decision: 'auto_lock' | 'confirm' | 'hold'
const record = tdx.lock(capsule, { key, state: 'auto_locked' });
tdx.verifyCapsule(record, { keys: [publicEntry] });   // → { ok: true, hash, errors: [] }
```

`hostGenerate` is any function that takes a Gemini `generateContent` request and returns its response.
The core never calls Google itself; `hosts/gemini.js` is the one this repository's scripts use.

## Meta Global AI Developer Hackathon

Startup track, theme *Build for Your World*.

- **Built before the hackathon (not part of this submission):** the TeacherDox WhatsApp product
  (private repository, live at [app.teacherdox.in](https://app.teacherdox.in)) and the `.tdx` 1.0
  design documents.
- **Built during the hackathon (26 Oct – 4 Nov 2026):** everything in this repository: the `.tdx` 2.0
  spec and vectors, the trust layer, the Record Engine on Meta's models, packs, API, verifier, CLI and
  eval. Every commit is dated; [`HACKATHON.md`](HACKATHON.md) lists the work day by day.
- **In the product:** the Meta models sit behind the product's single model boundary, Meta first and
  Gemini as fallback, for allow-listed demo and consenting numbers only (free-credit content may be
  used by Meta for product improvement, so real educators stay on the existing backend).

## License

Apache-2.0 (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE): TeacherDox Core — Copyright 2026
TeacherDox Private Limited). The `.tdx` format is open so that institutions, ministries and software
vendors can read, store and verify teaching records without depending on TeacherDox.
