# Evaluation results

**12 synthetic boards** (rendered from text: chalk, whiteboard, tilted, faded, cluttered) and **8 synthetic voice notes** (espeak-ng, OGG/Opus like WhatsApp) — no real classroom data. Ground truth in `eval/cases.json`; scoring rules in `eval/score.js` (pinned by `test/eval.test.js`). Each configuration runs alone — no fallback to another provider — so every number belongs to one provider. Synthetic voices are robotic, so voice numbers understate what real recordings would give, and differently per language. Small sample: treat differences of one or two cases as noise.

**No single run has all three yet.** In the run where Gemini worked, the Meta Model API answered HTTP 404 `model_not_found` on 17 of 20 cases (an account/key problem, not a model result — see below), so the table joins two runs 44 minutes apart, with Muse Spark Open measured in both as the bridge:

- Meta Model API: run [40547430902](https://github.com/sandeepkumareeri/teacherdox-core/actions/runs/40547430902) (27 Oct, 17:07 UTC, commit `fc84a21`)
- Gemini: run [40548212797](https://github.com/sandeepkumareeri/teacherdox-core/actions/runs/40548212797) (27 Oct, 17:11–17:54 UTC, commit `ff4c1a4`) — `gemini-3.8-flash` on Vertex AI (express mode, Google Cloud project billing)
- Muse Spark Open: both runs (69% and 68%; the column shows the Gemini run)

| | Meta Model API | Muse Spark Open (Baseten) | Gemini (`gemini-3.8-flash`, Vertex AI) |
|---|---|---|---|
| Models | SAM 3.1 · Muse Voice Transcribe · Muse Spark 1.3 | `meta-models/muse-spark-open-1026`, whole photo | `gemini-3.8-flash`, whole photo, audio in the same model |
| Records produced | 20 / 20 | 20 / 20 | 18 / 20 (2 boards refused: HTTP 429 resource exhausted) |
| **Field accuracy (all cases)** | **81%** | **69%** | **77%** |
| — cohort | 80% | 65% | 70% |
| — subject | 85% | 75% | 80% |
| — unit | 85% | 70% | 80% |
| — homework | 70% | 65% | 75% |
| — topics | 85% | 70% | 80% |
| **Boards (field accuracy)** | **98%** | **98%** | 82% (98% of the 10 boards it answered) |
| Voice notes: en | 90% | 90% | 100% |
| Voice notes: hi | 80% | 0% | 90% |
| Voice notes: te | 0% (held) | 0% | 0% (held) |
| Voice notes: ml | 0% (not supported → held) | 0% | 40% (1 of 2) |
| Voice notes: pt | 100% | 20% | 100% |
| Latency per record, model time p50 / p95 | 9.3 s / 11.3 s | 11.3 s / 12.4 s | 16.1 s / 188.6 s |
| Tokens per record (in / out, incl. reasoning) | 1986 / 1878 | 3005 / 950 | 2628 / 421 |
| Cost per record | unknown — Muse Spark's price is not published | $0.0104 (Baseten's published price) | unknown — no price recorded by the adapter |
| Routing: auto-lock / confirm / hold | 9 / 8 / 3 | 12 / 3 / 5 | 6 / 10 / 2 |

## What this says

- **Boards: Meta and Muse Spark Open both 98%; Gemini read the boards it answered equally well (49 of 50 fields)** — the same single miss for all three (b05: "Revise the order of planets" recorded as homework; the ground truth says none). Gemini's 82% is two boards refused with HTTP 429 (Vertex quota on a new project), scored as zero.
- **Voice: Gemini was strongest on languages.** English 100%, Hindi 90%, Portuguese 100%, and it is the only one that got a Malayalam note (1 of 2). The Meta Model API was close on en/hi/pt (90/80/100%).
- **Where the Meta Model API was weaker:** Malayalam (not supported by Muse Voice Transcribe → held) and Telugu (empty transcript → held). Gemini also held Telugu, so the synthetic espeak Telugu notes may simply be unintelligible. This is why the engine routes Malayalam to the fallback.
- **Where Gemini was weaker:** speed and reliability on this project today — p50 16.1 s vs 9.3 s, three records over 60 s and two at ~188 s, two refusals (429). Vertex quotas on a fresh Cloud project are low; this says more about the quota than the model.
- **Where Muse Spark Open was weaker:** every non-English voice note (its audio input is inconsistent; the engine leaves its transcription off).
- **Holds are the engine working as intended:** nothing usable heard → held for the educator, never an invented record.
- **Cost:** only Baseten's is known. Muse Spark (Meta Model API) has no published per-token price; Gemini on Vertex has one, but the adapter does not record it yet.

## Other runs

- **Run 40548212797** (above, Gemini): the Meta Model API answered HTTP 404 `model_not_found` on 17 of 20 cases, though `GET /v1/models` listed `muse-spark-1.3` in the same run — as at 15:11 UTC; both times a run minutes earlier had worked. (At 11:49 UTC the key had lost model access altogether: an empty model list.)
- **Run 40547430902** (above, Meta): Gemini not run — Vertex's model list refuses API keys (401) and Vertex does not serve the `gemini-flash-latest` alias (404); fixed by setting `GEMINI_MODEL`.
- **Run 40503572389** (12:28 UTC): Meta Model API 81% vs Muse Spark Open 67%; boards 98% both.
- **Run 40527430616** (27 Oct, ~14:55 UTC) — same two configurations: Meta Model API 82% (boards 98%; voice en 100%, hi 80%, pt 100%; te/ml held; p50 9.9 s), Muse Spark Open 59% (boards 98%; voice 0% in every language this time; p50 10.9 s; $0.0107 per record). Gemini skipped: key present, model not set.
- **Run 40528431277** (27 Oct, 15:14 UTC) — the first run with a Gemini key, model picked from the key's list (`gemini-3.8-flash`). **No comparison possible:** Gemini answered HTTP 402 "prepayment credits are depleted" on 12 of 20 cases, and the Meta Model API answered HTTP 404 `model_not_found` on 17 of 20 (it had worked an hour earlier). Both are account/key problems, not model results, so both columns are left out. Muse Spark Open alone: boards 98% again, English voice 1 of 2, every other voice note not heard.
- Run 40500600639 (12:05 UTC) measured only Muse Spark Open — the repository's Meta key had no model access at the time — with the same board result (98%) and English voice notes at 80%.

## Per case

<details><summary>Every case, every configuration</summary>

Times are whole-record wall time from the run log.

| case | Meta Model API | Muse Spark Open (Baseten) | Gemini (Vertex AI) |
|---|---|---|---|
| b01-fractions | 5/5 · 12.5 s | 5/5 · 11.7 s | 5/5 · 16.1 s |
| b02-photosynthesis | 5/5 · 8.8 s | 5/5 · 11.6 s | 5/5 · 15.8 s |
| b03-tenses | 5/5 · 9.0 s | 5/5 · 12.4 s | 5/5 · 20.8 s |
| b04-newton | 5/5 · 10.2 s | 5/5 · 11.3 s | HTTP 429 (resource exhausted) |
| b05-no-hw | 4/5 (missed assignments) · 10.3 s | 4/5 (missed assignments) · 12.9 s | 4/5 (missed assignments) · 12.6 s |
| b06-algebra-tilted | 5/5 · 9.7 s | 5/5 · 12.0 s | 5/5 · 17.4 s |
| b07-history | 5/5 · 9.5 s | 5/5 · 12.1 s | 5/5 · 186.9 s |
| b08-chem-low-contrast | 5/5 · 10.2 s | 5/5 · 9.6 s | HTTP 429 (resource exhausted) |
| b09-geography-clutter | 5/5 · 9.3 s | 5/5 · 11.6 s | 5/5 · 12.2 s |
| b10-geometry | 5/5 · 9.2 s | 5/5 · 11.4 s | 5/5 · 63.0 s |
| b11-computer | 5/5 · 7.5 s | 5/5 · 12.2 s | 5/5 · 54.4 s |
| b12-economics | 5/5 · 8.6 s | 5/5 · 11.3 s | 5/5 · 36.8 s |
| v01-en | 5/5 · 9.6 s | 5/5 · 7.8 s | 5/5 · 20.4 s |
| v02-en | 4/5 (missed cohort) · 11.2 s | 4/5 (missed cohort) · 8.6 s | 5/5 · 188.6 s |
| v03-hi | 4/5 (missed assignments) · 11.1 s | 0/5 (not heard) | 4/5 (missed cohort) · 25.6 s |
| v04-hi | 4/5 (missed assignments) · 11.3 s | 0/5 (not heard) | 5/5 · 11.4 s |
| v05-te | 0/5 (empty transcript → held) · 1.5 s | 0/5 (not heard) | 0/5 (held) · 28.8 s |
| v06-ml | 0/5 (not supported → held) | 0/5 (not heard) | 4/5 (missed cohort) · 64.2 s |
| v07-ml | 0/5 (not supported → held) | 0/5 (not heard) | 0/5 (held) · 29.4 s |
| v08-pt | 5/5 · 9.1 s | 1/5 (missed cohort, unit, assignments, topics) · 9.6 s | 5/5 · 91.0 s |

</details>
