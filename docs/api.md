# TeacherDox Core REST API (`/v1`)

Node `http`, no framework, no dependencies. Start it with `tdx serve` (or `npm run serve`).

## Configuration (environment)

| Variable | Meaning |
|---|---|
| `TDX_API_TOKENS` | `token1:tenant1,token2:tenant2`. Each bearer token belongs to one tenant and only sees that tenant's records. The tenant in a capsule always comes from the token, never from the request body. |
| `TDX_SIGNING_KEY_FILE`, `TDX_SIGNING_KEY_ID` | Ed25519 private key (PEM) made with `tdx keygen <id>` and its id. Without one, a temporary key is made for the process — records then cannot be verified after a restart. |
| `TDX_KEY_REGISTRY` | The published key registry (`{ "keys": [...] }`), must contain the signing key's public entry. Served at `/v1/keys` and `/.well-known/tdx-keys.json`. |
| `TDX_DATA_DIR` | Where capsules, seals, countersignatures and evidence are written (plain files; never overwritten). Without it, everything is in memory. Keep `evidence/` private. |
| `META_API_KEY`, `TDX_META_DAILY_LIMIT` | Meta Model API key for the Record Engine and its daily call limit (default 500). |
| `PORT`, `HOST` | Default `8080`, `127.0.0.1`. |

One process owns a data directory (chain appends are serialised in memory per educator-day).

## Public endpoints (no token)

| | |
|---|---|
| `GET /v1/health` | `{ ok, spec_version, pipeline_version }` |
| `GET /v1/keys`, `GET /.well-known/tdx-keys.json` | The published key registry. |
| `POST /v1/verify` | Body: anything a verifier accepts — a capsule, a list, a day export `{ capsules, seal, countersignatures }` — or `{ input, registry }` to check against another issuer's keys. Returns the full report. |
| `GET /verify/` | The public verifier page. It verifies **in the browser** with WebCrypto; nothing is uploaded. |

## Records (Bearer token)

### `POST /v1/records[?wait=1]` — capture

```json
{
  "evidence": [{ "media_type": "image/jpeg", "data": "<base64>" }, { "media_type": "audio/ogg", "data": "<base64>" }],
  "text": ["P2"],
  "context": { "educator_ref": "e_…", "institution_ref": "i_…", "institution_type": "school", "date": "2026-10-28",
               "country": "IN", "locale": "ml-IN", "channel": "whatsapp", "session": { "label": "P2" },
               "allow_providers": ["meta", "gemini"], "policy": "school_compliance" },
  "auto_lock": false
}
```

Capture returns at once: `202 { job, status_url }`; the Record Engine runs in the background (in-process queue).
With `?wait=1` it waits (up to 2 minutes) and returns `201 { job, record }`. The finished job carries
`routing` (`auto_lock | confirm | hold`, fields to confirm, reasons), `message` (one sentence for the
educator in their language), `steps` (provider, model, status, ms, cost per pipeline step) and the
`transcripts` — which are returned once and never stored in the capsule. With `auto_lock: true` a
record the policy allows to auto-lock is signed straight away.

At most 10 pieces of evidence; images JPEG/PNG/WebP, audio OGG/WAV/MP3/M4A/AAC/WebM/AMR; body ≤ 30 MB.
Evidence bytes are stored under their sha256; the capsule holds only the hash.

### Reading

| | |
|---|---|
| `GET /v1/jobs/:id` | Job status and result. |
| `GET /v1/records?educator_ref=&date=` | The educator's records for a day (each entry's effective capsule). |
| `GET /v1/records/:entry_id[?locale=]` | `{ effective, capsules (full history), countersignatures, message }`. |

### Signing and correcting (signed capsules are never changed)

| | |
|---|---|
| `POST /v1/records/:entry_id/lock` | Auto-lock (`auto_locked`, machine attestation). Refused with `409 { confirm_fields, reasons }` unless the routing decision was `auto_lock`. |
| `POST /v1/records/:entry_id/confirm` | `{ changes?, confirmed_by?, channel? }` → `confirmed_locked`. `changes` may only touch `session.{label,cohort,subject,course,unit,starts_at,duration_min}`, `content.*` and `curriculum.*`; the attestation lists `confirmed_fields` and `edited_fields`. |
| `POST /v1/records/:entry_id/amend` | `{ changes, reason, amended_by? }` → a new capsule with the same `entry_id` that points at the one it corrects; both stay in the chain. |
| `POST /v1/records/:entry_id/countersign` | `{ approver_ref, role, decision?: approved|returned, note? }` → a signed countersignature of the effective record. |

### Days

| | |
|---|---|
| `GET /v1/days/:educator_ref/:date` | The day's locked capsules in chain order, latest seal (and all seals), countersignatures, and a verification summary. This document is the export: give it to `tdx verify` or the verifier page. |
| `POST /v1/days/:educator_ref/:date/seal` | Signed Merkle seal over the day's records. Sealing again later (after more records or corrections) adds a new seal. |
| `POST /v1/days/:educator_ref/:date/countersign` | The approver countersigns the sealed day (the register). Refused if records were added after the latest seal. |
| `GET /v1/days/:educator_ref/:date/proof/:capsule_id` | Merkle inclusion proof of one record against the latest seal. |

Errors are `{ "error": "…" }` with 400 / 401 / 404 / 405 / 409 / 413; internal errors never include details.

## Command line

```bash
tdx keygen k_2026_10                       # keys/k_2026_10.pem + keys/k_2026_10.public.json
tdx verify day.json --keys keys.json       # exit 0 valid, 1 invalid; --json for the report
tdx validate record.json                   # schema only
tdx hash record.json
tdx process --image board.jpg --audio note.ogg --context ctx.json   # Record Engine, prints the draft
tdx serve --port 8080
```
