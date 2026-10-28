# Security

This document says what a `.tdx` record can and cannot prove, what an attacker can and cannot do,
and how to report a problem. It describes the code in this repository (version 0.1.0). The format
is specified in [`spec/tdx-2.0.md`](spec/tdx-2.0.md); the failure codes a verifier reports are in
§9 of the spec.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository.
Do not open a public issue for a vulnerability. Include what you found, how to reproduce it, and
which version or commit you tested.

We aim to acknowledge a report within 3 working days and to tell you within 10 working days what
we will do about it. Fixes are released as new versions with a `CHANGELOG.md` entry; we credit
reporters who want to be credited.

In scope: the trust layer (`src/tdx`), the verifiers (`src/verifier`, `verifier/`), the CLI
(`bin/tdx`), the REST API (`src/api`) and the Record Engine (`src/engine`). Out of scope: the
third-party model APIs the engine calls, and denial of service by sending very large volumes of
requests to a server you run yourself.

## What is signed, and by whom

A capsule is a JSON envelope. When it is locked, the **signer** (the institution or operator
running the Record Engine or the API, holding an Ed25519 private key) signs the RFC 8785 canonical
form of `{format, spec_version, capsule_id, body}`. Each locked capsule also carries its position in
the educator's daily hash chain (`sequence_index`, `prev_hash` = hash of the previous locked
capsule). At the end of the day the signer can seal the day: a signed Merkle root over every locked
capsule hash. An approver (a headmaster, a head of department) can countersign a capsule or a sealed
day with their own key. Public keys are published in a **key registry** (`{ keys: [...] }`, with
`valid_from`, `valid_to`, `revoked_at` per key).

## What verification proves

When `tdx verify` (or the verifier page, or `verifyCapsule` / `verifyDay`) reports ✓:

- **Signed:** the capsule was signed by the private key behind a registry entry, and that key was
  valid and not revoked at the capsule's `signed_at`.
- **Unchanged:** not one byte of the signed content has changed since it was signed. Any edit to the
  body, id or format breaks the signature (`signature_mismatch`).
- **In the day's chain:** within one educator-day, no locked record has been removed, inserted,
  reordered or duplicated after the fact (`sequence_gap`, `chain_broken`,
  `first_prev_hash_not_null`), provided the verifier is given the whole day.
- **In the sealed day:** with a seal and a Merkle proof, one record belongs to the sealed day,
  without seeing the other records.
- **Corrections are visible:** an amendment is a new capsule that points at the hash of the one it
  corrects; the original stays in the chain (`amendment_hash_mismatch`, `amendment_changes_entry`).
- **Approved by:** a countersignature was made by the approver's key over exactly this capsule's or
  seal's hash (`countersignature_wrong_target`).

## What verification does not prove

- **That the lesson happened, or that the record is true.** A signature proves who signed and that
  nothing changed since; it does not prove the content. The record says how it was made
  (`provenance`: which model read which evidence, with what confidence) and who attested it
  (`attestation.mode`: `machine` for auto-locked, `human` for confirmed by the educator), but those
  are statements by the signer.
- **That the educator personally confirmed it.** In the reference API the signer holds the key, not
  the educator. `confirmed_locked` records that the signer received a confirmation; the receipt it
  references is the signer's evidence, not a signature by the educator.
- **When it was signed.** `signed_at` is written by the signer. There is no trusted timestamp in
  0.1.0; a signer with a valid key can sign with any `signed_at` inside the key's validity window
  (see "Backdating" below).
- **That the evidence is the evidence.** Capsules hold content hashes (`sha256:…`) of photos and voice
  notes, never the bytes. Whoever holds the original file can prove it matches; the capsule alone
  cannot show the file.
- **That a whole day was shown.** A verifier given only part of a day can check the part's
  signatures and links, but cannot know records were left off the end. A day seal fixes the count;
  ask for the seal.

## Threat model

| Threat | Can it be done? | Why |
|---|---|---|
| Edit a signed record (change homework, subject, date) | **No**, without the private key | Signature covers the canonical body; any change → `signature_mismatch`. |
| Forge a record for a signer | **No**, without the private key | Ed25519 (`node:crypto`, WebCrypto in the browser). |
| Delete or insert a record in the middle of a signed day | **Detected** | Each record links to the previous hash; sequence indexes must be contiguous. |
| Delete the last records of a day | **Detected only with the day seal** | The chain has no forward link; the seal's `count` and Merkle root fix the set. |
| Replay a record into another educator's or another day's chain | **Detected** | Tenant, educator and date are inside the signed body and define the chain scope; the `prev_hash` link binds it to its position. |
| Present an old, correct record instead of its correction | **Detected when the day is shown** | The amendment is in the same chain; the verifier reports the effective record per entry. |
| Re-use a countersignature for a different record | **No** | It signs the target's hash and type. |
| Swap the key registry | **Possible if the registry itself is not trusted** | Verification is only as good as the registry you verify against. Get the registry from the institution's published source, not from the same place as the records. |
| Signer backdates a record | **Possible within the key's validity window** | See "Backdating". |
| Signer rewrites a whole day before anyone has a copy | **Possible** | A signer can re-sign an entire day. Sealing, countersigning and sharing seals early with approvers is what makes later rewriting visible. |
| A model invents content | **Contained, not prevented** | The engine never fills a field it could not read: unreadable → `held`; contradicted or low-confidence fields go to the educator to confirm (`confirm`); the check step's flags and per-field confidence are in the record. |

### Key compromise and revocation

- Keep private keys out of the repository and out of logs. `tdx keygen` writes the key file with
  mode `0600` in a directory with mode `0700` and refuses to overwrite an existing key.
- If a key leaks: set its `revoked_at` in the published registry to the earliest moment it may
  have been exposed, generate a new key, and re-sign (as amendments or a new seal) any records
  that must stay valid. Verifiers then reject every signature with `signed_at` at or after
  `revoked_at` (`key_revoked`).
- Records signed before `revoked_at` still verify. That is deliberate (honest history stays valid),
  and it is also the limit: an attacker holding a leaked key can sign with an earlier `signed_at`.
  To narrow this, set `revoked_at` conservatively, rotate keys often (`valid_to`), and seal and
  share days promptly — a seal an approver already holds cannot be silently replaced.

### Backdating

`signed_at` is not proven by anything outside the signer. Within a key's validity window a signer can
choose it. Day seals that approvers receive and countersign on the day are the 0.1.0 defence;
external timestamping (RFC 3161) or publishing seal roots to a public log are possible later
extensions and are not implemented.

### The REST API

- Every non-public endpoint needs `Authorization: Bearer <token>`; each token belongs to one tenant
  and only sees that tenant's records. Tokens are compared as SHA-256 digests in constant time.
- Public without a token: health, the key registry, verification, the verifier page.
- Run it behind HTTPS. The file-backed store keeps records and queued jobs on local disk in plain
  JSON; protect that directory like any other database.
- Without `TDX_SIGNING_KEY_FILE` the server makes a temporary key for its own process; records signed
  with it do not verify after a restart. Use it only for demos.

### Model providers and data

The engine sends evidence (photos, voice notes, text) to the configured model providers (Meta Model
API, Muse Spark Open on Baseten, and a host-supplied fallback). Only send what the educator and the
institution have agreed to. Per-tenant consent lists (`allow_providers`) restrict which providers a
record may use; the provenance of every record lists the providers that actually saw it. Provider API
keys are read from the environment and never written into records or logs.

### Windows: private key file permissions

On Windows, Node.js cannot set POSIX file modes: `tdx keygen`'s `0600` has no effect, and the key
file inherits the folder's access control list. Keep keys in a folder only your account can read,
for example:

```powershell
icacls .\keys /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"
```

or use a key store (Windows certificate store, an HSM or a cloud KMS) for production signing keys.
The test suite skips the file-mode check on Windows for this reason.

## Supported versions

Only the latest release receives security fixes.
