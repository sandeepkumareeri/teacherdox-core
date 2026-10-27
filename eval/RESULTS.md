# Evaluation results

Run: https://github.com/sandeepkumareeri/teacherdox-core/actions/runs/40500600639 · commit `66172ef` · 2026-10-27 12:05 UTC

**12 synthetic boards** (rendered from text: chalk, whiteboard, tilted, faded, cluttered) and **8 synthetic voice notes** (espeak-ng, OGG/Opus like WhatsApp) — no real classroom data. Ground truth in `eval/cases.json`; scoring rules in `eval/score.js` (pinned by `test/eval.test.js`). Synthetic voices are robotic, so voice numbers understate what real recordings would give, and differently per language. Small sample: treat differences of one or two cases as noise.

- **Gemini: not run** — `GEMINI_API_KEY` secret / `GEMINI_MODEL` variable not set on this repository.
- **Meta Model API: not comparable** — 17 of 20 cases failed on the API, not on the model: `HTTP 404 model_not_found` for `muse-spark-1.3` and `sam-3.1`, and `GET /v1/models` with the repository's key returns an empty list. The same models worked at 10:39 UTC (photo pipeline run 40489280886: SAM 3.1 box within 0.3% of the drawn board, all fields read correctly, 12.4 s). Its numbers are left out until the key has model access again.

| | Muse Spark Open (Baseten) |
|---|---|
| Records produced | 20 / 20 |
| **Field accuracy (all cases)** | **67%** |
| — cohort | 65% |
| — subject | 65% |
| — unit | 70% |
| — homework | 65% |
| — topics | 70% |
| **Boards (field accuracy)** | **98%** (59 of 60 fields) |
| Voice notes: en | 80% |
| Voice notes: hi | 0% |
| Voice notes: te | 0% |
| Voice notes: ml | 0% |
| Voice notes: pt | 0% |
| Latency per record, model time p50 / p95 | 11.6 s / 13.1 s |
| Tokens per record (in / out, incl. reasoning) | 3005 / 987 |
| Cost per record (Baseten's published price) | $0.0106 (15 priced) |
| Routing: auto-lock / confirm / hold | 9 / 5 / 6 |

## What this says

- **Boards: strong.** Muse Spark Open read every board correctly except one field (b05, where it recorded "Revise the order of planets" as homework — arguably homework, but the ground truth says none). That includes the tilted, low-contrast and cluttered boards, without SAM 3.1 cropping (Baseten has no segmentation model, so the whole photo was read).
- **Voice notes: weak and inconsistent.** Audio input heard the English notes in this run, but in three earlier probe runs the same model said "no audio was provided" for most notes, English included (`docs/meta-model-api-notes.md`). Hindi, Telugu, Malayalam and Portuguese synthetic notes were not usable in any run. **The engine therefore leaves Muse Spark Open transcription off by default and does not route Malayalam to it.**
- **Holds are working as intended**: the 6 holds are voice notes where nothing usable was heard — the engine held them instead of inventing a record.
- **Not yet measured:** the Meta Model API (key problem above) and Gemini (no key). The comparison the hackathon asks for needs both; re-run *Eval* once they are available.

## Per case

<details><summary>Every case</summary>

| case | Muse Spark Open (Baseten) |
|---|---|
| b01-fractions | 5/5 · 14.6 s |
| b02-photosynthesis | 5/5 · 13.1 s |
| b03-tenses | 5/5 · 12.2 s |
| b04-newton | 5/5 · 10.8 s |
| b05-no-hw | 4/5 (missed assignments) · 11.8 s |
| b06-algebra-tilted | 5/5 · 11.6 s |
| b07-history | 5/5 · 11.6 s |
| b08-chem-low-contrast | 5/5 · 11.7 s |
| b09-geography-clutter | 5/5 · 11.6 s |
| b10-geometry | 5/5 · 13.0 s |
| b11-computer | 5/5 · 12.3 s |
| b12-economics | 5/5 · 11.6 s |
| v01-en | 5/5 · 9.4 s |
| v02-en | 3/5 (missed cohort, subject) · 7.7 s |
| v03-hi | 0/5 · 8.3 s |
| v04-hi | 0/5 (not heard) |
| v05-te | 0/5 (not heard) |
| v06-ml | 0/5 (not heard) |
| v07-ml | 0/5 (not heard) |
| v08-pt | 0/5 (not heard) |

</details>
