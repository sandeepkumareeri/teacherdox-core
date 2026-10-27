# Packs

A new language, kind of institution, country or trust profile is a JSON file here, not code
(CORE-00 §4.4). `src/packs` loads them; the Record Engine and any channel use them.

| Kind | File | What it sets | Used by |
|---|---|---|---|
| Locale | `locales/<bcp47>.json` | `messages` (educator-facing sentences, plural forms by `Intl.PluralRules`) and `terms` (field names, session kinds, approver roles) | `packs.t()`, `packs.describe()` |
| Institution | `institutions/<type>.json` | session kinds and default kind, which term names each field (a school "class", an academy "batch"), field-class `promotions`, approver role, the vocabulary given to the model | engine prompt, scoring, labels |
| Country | `countries/<iso>.json` | IANA time zones (and a default only when it is safe), locales, the language records are written in, approver hierarchy, academic calendar, curriculum frameworks, data-residency region | engine context defaults |
| Policy | `policies/<profile>.json` | confidence each field class needs (`min`), when a critical field holds the record (`hold_below`), which steps run, how many days late a capture may be, whether auto-lock is allowed, whether an approver must countersign | scoring / routing |

## Current packs

- Locales: `en`, `ml`, `te`, `hi`, `pt-BR`, `id`, `fr`. **All non-English packs are draft translations
  and say so in their `review` field** until a native speaker has checked them.
- Institutions: `school`, `college`, `university`, `academy`, `training`, `independent` (the `.tdx` 2.0
  `institution_type` values).
- Countries: `IN`, `BR`, `ID`, `FR`, `SN`. Brazil and Indonesia have several time zones, so they have no
  default: the channel must send the educator's zone.
- Policies: `personal`, `school_compliance` (default), `government_audit`, `low_connectivity`.

## Adding one

- **Language:** copy `locales/en.json`, translate every value, keep every `{placeholder}`, use only the
  plural categories `Intl.PluralRules` gives for the language, and add `"review"` until checked.
- **Country:** time zones must be IANA names; set `default_timezone` only when one zone covers everyone.
- `npm test` checks every pack: same keys as English, matching placeholders, valid plural categories,
  real time zones, institution types and session kinds from the schema, terms that exist, thresholds
  in 0–1 and stricter policies being stricter.
