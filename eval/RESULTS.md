# Evaluation results

Run: https://github.com/sandeepkumareeri/teacherdox-core/actions/runs/40503572389 · commit `7d143a6` · 2026-10-27 12:28 UTC

**12 synthetic boards** (rendered from text: chalk, whiteboard, tilted, faded, cluttered) and **8 synthetic voice notes** (espeak-ng, OGG/Opus like WhatsApp) — no real classroom data. Ground truth in `eval/cases.json`; scoring rules in `eval/score.js` (pinned by `test/eval.test.js`). Each configuration runs alone — no fallback to another provider — so every number belongs to one provider. Synthetic voices are robotic, so voice numbers understate what real recordings would give, and differently per language. Small sample: treat differences of one or two cases as noise.

- **Gemini: not run** — the `GEMINI_API_KEY` secret and `GEMINI_MODEL` variable were empty in this run.

| | Meta Model API | Muse Spark Open (Baseten) |
|---|---|---|
| Models | SAM 3.1 · Muse Voice Transcribe · Muse Spark 1.3 | Muse Spark Open (`meta-models/muse-spark-open-1026`), whole photo (no segmentation model) |
| Records produced | 20 / 20 | 20 / 20 |
| **Field accuracy (all cases)** | **81%** | **67%** |
| — cohort | 75% | 60% |
| — subject | 85% | 70% |
| — unit | 85% | 70% |
| — homework | 75% | 65% |
| — topics | 85% | 70% |
| **Boards (field accuracy)** | **98%** | **98%** |
| Voice notes: en | 90% | 80% |
| Voice notes: hi | 80% | 0% |
| Voice notes: te | 0% | 0% |
| Voice notes: ml | 0% (not supported → held) | 0% |
| Voice notes: pt | 100% | 0% |
| Latency per record, model time p50 / p95 | 9.5 s / 13.2 s | 9.1 s / 12.2 s |
| Tokens per record (in / out, incl. reasoning) | 1985 / 2029 | 2996 / 933 |
| Cost per record | unknown — Muse Spark's price is not published (only Muse Voice Transcribe's $0.18/h is) | $0.0103 (Baseten's published price) |
| Routing: auto-lock / confirm / hold | 9 / 8 / 3 | 6 / 8 / 6 |

## What this says

- **Boards: both 98%** (59 of 60 fields). The one miss is the same for both: on b05 they recorded "Revise the order of planets" as homework; the ground truth says none. Tilted, low-contrast and cluttered boards were all read correctly by both.
- **Voice notes: the Meta Model API is much stronger.** Muse Voice Transcribe handled English, Hindi and Portuguese; Muse Spark Open's audio input heard only English (and in earlier probes not even that, consistently). That is why the engine sends voice notes to Muse Voice Transcribe and leaves Muse Spark Open transcription off.
- **Where the Meta Model API was weaker:** Telugu (the synthetic espeak Telugu note gave an empty transcript — as in the first probe — so the record was held) and Malayalam (not supported by Muse Voice Transcribe; held). In the product both go to the Gemini fallback, which is not measured here yet.
- **Where Muse Spark Open was weaker:** every non-English voice note; cohort on English voice notes. It was slightly faster per record (no SAM call, no separate transcription), and is the only one with a known cost.
- **Holds are the engine working as intended:** nothing usable heard → held for the educator, never an invented record.
- **Not yet measured:** Gemini (no key in this run); real (non-synthetic) voice notes.

## Earlier run

Run 40500600639 (12:05 UTC) measured only Muse Spark Open — the repository's Meta key had no model access at the time — with the same board result (98%) and English voice notes at 80%.

## Per case

<details><summary>Every case, every configuration</summary>

| case | Meta Model API | Muse Spark Open (Baseten) |
|---|---|---|
| b01-fractions | 5/5 · 12.7 s | 5/5 · 12.2 s |
| b02-photosynthesis | 5/5 · 10.4 s | 5/5 · 11.7 s |
| b03-tenses | 5/5 · 13.2 s | 5/5 · 12.0 s |
| b04-newton | 5/5 · 9.5 s | 5/5 · 11.0 s |
| b05-no-hw | 4/5 (missed assignments) · 13.5 s | 4/5 (missed assignments) · 8.8 s |
| b06-algebra-tilted | 5/5 · 9.3 s | 5/5 · 11.9 s |
| b07-history | 5/5 · 11.8 s | 5/5 · 11.5 s |
| b08-chem-low-contrast | 5/5 · 9.6 s | 5/5 · 9.1 s |
| b09-geography-clutter | 5/5 · 9.2 s | 5/5 · 8.5 s |
| b10-geometry | 5/5 · 8.8 s | 5/5 · 11.8 s |
| b11-computer | 5/5 · 9.0 s | 5/5 · 12.2 s |
| b12-economics | 5/5 · 9.2 s | 5/5 · 10.7 s |
| v01-en | 5/5 · 9.6 s | 4/5 (missed cohort) · 9.4 s |
| v02-en | 4/5 (missed cohort) · 11.7 s | 4/5 (missed cohort) · 6.5 s |
| v03-hi | 5/5 · 10.8 s | 0/5 (not heard) · 8.1 s |
| v04-hi | 3/5 (missed cohort, assignments) · 8.8 s | 0/5 (not heard) |
| v05-te | 0/5 (empty transcript → held) · 1.5 s | 0/5 (not heard) |
| v06-ml | 0/5 (not supported → held) | 0/5 (not heard) |
| v07-ml | 0/5 (not supported → held) | 0/5 (not heard) |
| v08-pt | 5/5 · 9.9 s | 0/5 (not heard) |

</details>
