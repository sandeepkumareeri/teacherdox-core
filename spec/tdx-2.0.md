# `.tdx` 2.0 — The Universal Teaching Record

| | |
|---|---|
| **Status** | Draft 1 — 27 Oct 2026 |
| **Supersedes** | `.tdx` 1.0 body model (RFC-001); keeps its envelope, signing and trust rules (RFC-001 §2, §4; RFC-002) |
| **Normative keywords** | MUST / SHOULD / MAY (RFC 2119) |

`.tdx` 1.0 described one school period taught by one teacher. `.tdx` 2.0 generalises the body so that **any teaching session** — a school period, a university lecture, a lab, a tutorial, a coaching batch, a corporate workshop — is the same record, with institution-specific vocabulary supplied by packs rather than fields.

---

## 1. What stays the same (from 1.0 / RFC-002)

- **Envelope:** `{ format: "tdx", spec_version, capsule_id (UUIDv7), body, signature }`.
- **Signing input:** JCS (RFC 8785) of `{ format, spec_version, capsule_id, body }`; the signature object is excluded.
- **Capsule hash:** `sha256(JCS(full signed envelope))`.
- **No raw evidence bytes** in a capsule — only content-addressed references (`sha256:…`).
- **No PII** in the body — opaque references only.
- **Lifecycle:** `draft | held | auto_locked | confirmed_locked`; signed capsules are immutable; amendments are new capsules.
- **Chain:** one chain per `(tenant, educator_ref, local session date)`; `prev_hash`, contiguous `sequence_index`, optional daily Merkle seal.

## 2. What changes

| 1.0 | 2.0 | Why |
|---|---|---|
| `actor.teacher_ref`, `actor.school_ref` | `actor.educator_ref`, `actor.institution_ref`, `actor.institution_type` | Any educator, any institution |
| `period { grade, section, period_label, … }` | `session { kind, label, cohort, course, unit, … }` | Periods, lectures, labs, batches, workshops |
| Subject only | `session.subject` + optional `session.course` / `session.unit` | Universities and training have courses and modules |
| India-shaped defaults | `locale`, `country`, `timezone` explicit | Global |
| `content` fixed for school | `content` general (topics, summary, method, assignments, next, materials, notes) | Works for every kind of teaching |
| Provenance: model list | Provenance per **pipeline step** (capability, provider, model, latency, cost, confidence) | Multi-model, auditable engine |
| — | `evidence_findings` | What each piece of evidence contributed (e.g. board region found by segmentation, transcript) |

## 3. Body

```jsonc
{
  "tenant": "t_…",                       // opaque tenant (institution group / platform customer)
  "actor": {
    "educator_ref": "e_…",               // opaque; resolves via Identity
    "institution_ref": "i_…",
    "institution_type": "school"         // school | college | university | academy | training | independent
  },
  "locale": "ml-IN",                     // BCP 47 — language of the educator's capture
  "record_locale": "en",                 // language the record is written in
  "country": "IN",                       // ISO 3166-1 alpha-2
  "session": {
    "kind": "period",                    // period | lecture | lab | tutorial | batch | workshop | other
    "date": "2026-10-28",                // local date
    "starts_at": "2026-10-28T09:40:00",  // local wall clock, optional
    "timezone": "Asia/Kolkata",          // IANA, REQUIRED
    "label": "P2",                       // institution's own label (e.g. "P2", "CS201-L14", "Batch A")
    "cohort": "8B",                      // class/section, year group, batch — optional
    "subject": "Mathematics",
    "course": null,                      // e.g. "CS201 Data Structures" — optional
    "unit": "Fractions",                 // chapter / module / unit — optional
    "duration_min": 40                   // optional
  },
  "source": {
    "channel": "whatsapp",               // whatsapp | web | api | sms | app | lms
    "capture_methods": ["photo", "voice"],
    "captured_at": "2026-10-28T10:22:05Z",
    "lag_seconds": 2525
  },
  "evidence": [
    { "id": "sha256:…", "media_type": "image/jpeg", "bytes": 182311, "role": "board" },
    { "id": "sha256:…", "media_type": "audio/ogg",  "bytes": 51022,  "role": "voice_note", "duration_s": 14 }
  ],
  "evidence_findings": [
    { "evidence": "sha256:…", "step": "locate", "finding": "board_region", "box": [0.08, 0.12, 0.91, 0.78] },
    { "evidence": "sha256:…", "step": "listen", "finding": "transcript", "language": "ml", "text_ref": "tx_…" }
  ],
  "content": {
    "title": "Adding fractions with unlike denominators",
    "topics": ["Fractions", "LCM"],
    "summary": "…",
    "method": "Board explanation and worked examples",
    "assignments": [{ "text": "Exercise 3.2, Q1–5", "due": null }],
    "next": "Subtracting fractions with unlike denominators",
    "materials": ["Textbook p. 42"],
    "notes": null
  },
  "curriculum": { "framework": null, "tags": [] },   // e.g. framework "IN-AP-SCERT", "BR-BNCC", "ID-MERDEKA"
  "provenance": {
    "pipeline_version": "core-0.1",
    "steps": [
      { "step": "locate", "capability": "segment",    "provider": "meta", "model": "sam-3.1",              "ms": 820,  "cost_usd": 0.0004 },
      { "step": "listen", "capability": "transcribe", "provider": "meta", "model": "muse-voice-transcribe", "ms": 1640, "cost_usd": 0.0010 },
      { "step": "read",   "capability": "structure",  "provider": "meta", "model": "muse-spark",            "ms": 3100, "cost_usd": 0.0021 },
      { "step": "check",  "capability": "verify",     "provider": "meta", "model": "muse-spark",            "ms": 1200, "cost_usd": 0.0008 }
    ],
    "fallback_used": false,
    "overall_confidence": 0.91,
    "field_confidence": { "session.cohort": 0.97, "session.subject": 0.99, "content.assignments": 0.72 }
  },
  "attestation": { /* RFC-002 §9: statement_ref, mode, policy_profile, policy_version, auto_accepted_fields, confirmed_fields, confirmation */ },
  "approval": null,                      // countersignature by an approver, when present (role from institution pack)
  "chain": { "sequence_index": 0, "prev_hash": null },
  "amendment": null,                     // { amends_capsule_id, amends_capsule_hash, reason } when correcting
  "ext": {}                              // namespaced extensions (RFC-001 §6 rules)
}
```

Model identifiers above are illustrative; implementations record the exact model id returned by the provider.

## 4. Field classes (for confidence routing)

| Class | 2.0 fields |
|---|---|
| Critical | `session.date`, `session.timezone`, `session.subject`, `session.cohort` (when the institution pack marks it required), `actor.*`, `tenant` |
| Material | `content.assignments`, `content.topics`, `session.unit`, `session.course`, `curriculum.tags` |
| Soft | `content.title`, `content.summary`, `content.method`, `content.next`, `content.materials`, `content.notes` |

Institution packs MAY promote a field (e.g. `session.course` is critical for `university`).

## 5. Compatibility

- A 1.0 capsule is mapped to 2.0 for reading as: `teacher_ref → educator_ref`, `school_ref → institution_ref`, `institution_type = "school"`, `period → session { kind: "period", label: period_label, cohort: grade+section, … }`. **Signed 1.0 capsules are never rewritten**; the mapping is a read-time view and verification always uses the original bytes.
- Consumers MUST ignore unknown fields within a major version and MUST NOT re-emit a modified signed body.

## 6. Conformance (summary)

A conformant producer MUST emit UUIDv7 ids, JCS-canonical signing input, content-addressed evidence, an IANA time zone, and per-step provenance. A conformant verifier MUST implement the RFC-002 §10 algorithm against `.tdx` 2.0. The JSON Schema in [`schema/tdx-2.0.schema.json`](schema/tdx-2.0.schema.json) (JSON Schema 2020-12) is normative for structure; `src/tdx/schema.js` is a dependency-free validator for it, and `verifyCapsule` applies it.

The schema allows unknown members everywhere (consumers MUST ignore them within 2.x). It additionally requires, for `auto_locked` / `confirmed_locked` capsules, a `signature`, a `chain` position and an `attestation`.

## 7. Provenance step fields

Each `provenance.steps[]` item has `step` (`locate | listen | read | check | score`), `capability` (`segment | transcribe | structure | verify | score`) and `provider`, and MAY carry `model`, `status` (`ok | fallback | skipped | failed`), `ms`, `cost_usd` (`null` when the provider's price is unknown — never estimated), `tokens { input, output }`, `evidence` (the evidence hash the step worked on) and `attempts[]` (each provider tried before the one that answered, with its error). `provenance` MAY also carry `flags[]` (fields the check step found contradicted or unsupported by the evidence) and `routing` (the confidence-routing decision: `auto_lock | confirm | hold`, the policy used, and which fields were auto-accepted or need confirmation).

## 8. Countersignatures

An approver (headmaster, head of department, supervisor — the role comes from the institution pack) attests a locked record or a whole sealed day. Because signed capsules are immutable, a countersignature is a separate signed statement that names its target by hash; the capsule's `approval` member stays `null` in capsules produced by the reference implementation.

```jsonc
{
  "type": "tdx-countersignature",
  "target": { "type": "capsule", "id": "<capsule_id>", "hash": "sha256:…" },   // or { "type": "day_seal", "id": "<day scope>", … }
  "approver_ref": "e_…", "role": "headmaster", "decision": "approved",          // approved | returned
  "note": null, "signed_at": "2026-10-28T12:05:00Z",
  "signature": { "alg": "ed25519", "key_id": "…", "sig": "…" }                  // over JCS of everything but `signature`
}
```

The target hash is the capsule hash (§1), or `sha256(JCS(seal))` for a day seal. A verifier MUST check the signature and the key's validity at `signed_at` as for capsules, and MUST check the target hash against the record or seal it is shown with. Countersigning a day seal attests every record the seal covers; when records are added to a day after it was sealed, the day is sealed again and the earlier countersignature keeps pointing at the earlier seal.
