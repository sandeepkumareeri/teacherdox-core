# Meta Model API — observed behaviour (27 Oct 2026)

Verified with real calls by the `Meta probe` workflow in the private TeacherDox repo
(synthetic test data only). Use these facts; do not guess others — check dev.meta.ai docs.

## Basics
- Base URL `https://api.meta.ai/v1`, header `Authorization: Bearer <META_API_KEY>`.
- OpenAI-compatible shapes: `POST /chat/completions`, `POST /responses`.
- Models used: `muse-spark-1.3` (text + vision + structured output), `sam-3.1` (segmentation),
  `muse-voice-transcribe-1.0` (speech to text). Also listed: `muse-wonder-1.0`, `muse-image-1.0`,
  `muse-spark-1.3-contributor` (cheaper; Meta may train on prompts — never use for real educator data).

## Muse Spark (`/chat/completions`)
- It is a reasoning model: reasoning tokens count against `max_completion_tokens`. With a small
  budget `content` comes back `null`. Use `reasoning_effort: "low"` and a budget of several thousand.
- Images: `content: [{type:"text",...},{type:"image_url",image_url:{url:"data:image/jpeg;base64,..."}}]`
  (data URLs work; up to 50 images / 50 MB each).
- Structured output: `response_format: {type:"json_schema", json_schema:{name, schema, strict:true}}`.
  With strict mode every object needs `additionalProperties:false` and all properties `required`.
  Result is a JSON string in `choices[0].message.content`.
- Probe result on a synthetic chalkboard (1280×960): cohort "8B", assignments "HW: Ex 3.2 Q1-5",
  title + 3 topics, confidence 0.97, ~4.3 s, ~1.6k prompt tokens. It returned the chapter
  ("Fractions") as subject → the prompt must separate subject from unit/chapter.

## SAM 3.1 (`/responses`)
- Request: `{model:"sam-3.1", input:[{type:"message", role:"user", content:[{type:"input_text", text:"chalkboard"}, {type:"input_image", image_url:"data:image/jpeg;base64,..."}]}]}`.
- Output text (in `output[0].content[0].text`) is special-token text, one box + mask per match, e.g.
  `<0f>0<|box;x1=143;y1=124;x2=1137;y2=756;w=1280;h=960|><|mask;x=0;y=0;data=…|>`.
  Box is in pixels of the input image (`w`,`h` given). The mask is a long encoded string (~120 KB
  for one board) — parse the box, ignore/store the mask.
- Probe: the drawn board was 140–1140 × 120–760; SAM returned 143–1137 × 124–756. ~1.8 s.

## Muse Voice Transcribe (`POST /asr/transcribe`)
- `multipart/form-data`: part `request` = JSON `{model:"muse-voice-transcribe-1.0", audioEncoding:"WAV", languageBias:["Hindi"]}`,
  part `audio` = file. **`audioEncoding` is required; `"WAV"` works.**
- Audio must be RIFF/WAVE, mono, 16-bit PCM, 16 or 24 kHz. WhatsApp voice notes (OGG/Opus) must be
  converted: `ffmpeg -i in.ogg -ac 1 -ar 16000 -c:a pcm_s16le out.wav`.
- Response: `{sessionId, transcript, audioDurationMs, turns:[]}`. No confidence scores, no word timestamps.
- Languages (25): includes English, Hindi, Telugu, Tamil, Kannada, Marathi, Bengali, Portuguese,
  Indonesian, Malay, French, Spanish, Arabic… **Malayalam is not supported** → route `ml` to the
  fallback provider.
- Probe (espeak synthetic voices): English perfect; Portuguese very good; Hindi understandable;
  Telugu empty (synthetic voice too poor — re-test with real recordings); Malayalam garbage (unsupported).
- Price: $0.18 per hour of audio.

## Account notes
- The account runs on hackathon free credits; Meta's billing page says content sent while using free
  credits may be used for product improvement → only demo/test data or consenting educators.

## Record Engine, first live run (27 Oct 2026, 10:39 UTC)

`Photo pipeline live` run [40489280886](https://github.com/sandeepkumareeri/teacherdox-core/actions/runs/40489280886)
(attempt 2), synthetic board `test/fixtures/board-synthetic.jpg`, Meta only, no fallback. The request and
response shapes in this file worked unchanged in the engine (`/responses` for SAM, `/chat/completions` with a
strict JSON schema and `reasoning_effort: "low"` for Muse Spark, instructions in the user turn).

| Step | Model | ms | Tokens in / out | Result |
|---|---|---|---|---|
| locate | sam-3.1 | 3181 | — | box [0.1117, 0.1292, 0.8883, 0.7875] (drawn board ≈ [0.109, 0.125, 0.891, 0.792]); crop 43,718 bytes |
| read | muse-spark-1.3 | 4241 | 1274 / 1267 | cohort 8B · subject Mathematics · unit Fractions · "Adding fractions with unlike denominators" · HW "Ex 3.2 Q1-5" |
| check | muse-spark-1.3 | 4954 | 1233 / 1171 | `session.subject` **unsupported**: "Board shows fractions but no subject word." |

Total 12.4 s. Subject and unit came back separated (the probe's "Fractions as subject" problem is fixed by the
prompt). The check step capped `session.subject` at 0.5 because the board never names the subject — it was
inferred — so the record was routed to **confirm** ("Recorded. Please check: subject.") instead of being
auto-locked. That is the intended behaviour: an inferred critical field goes to the educator. In the product the
subject usually comes from the educator's timetable (`context.session.subject` / `usual`), which the engine then
treats as known. Completion tokens include reasoning; cost stays `null` until Muse Spark's price is published.

## Muse Spark Open on Baseten (27 Oct 2026)

Meta's open-weight model, served by Baseten. Read from Baseten's docs (Model APIs overview, reasoning, vision,
audio, structured outputs, pricing, LLM OpenAPI spec — fetched by the `Baseten docs` workflow, because the
development sandbox cannot reach baseten.co) and observed live by the `Baseten probe` workflow (synthetic data).

**From the docs**
- `POST https://inference.baseten.co/v1/chat/completions`, `Authorization: Bearer <BASETEN_API_KEY>`, OpenAI-compatible.
  Hackathon model id **`meta-models/muse-spark-open-1026`** (the docs list `meta-models/muse-spark-open`).
- Always reasons. `reasoning_effort`: `low | medium | high | xhigh` (default `xhigh`; `none`/`minimal` run at `low`).
  `max_tokens` defaults to 4096 and reasoning counts against it.
- Images: `{type:"image_url", image_url:{url}}` (HTTPS or `data:`), JPEG/PNG/WebP/GIF/BMP/TIFF, ≤ 8 per request, ≤ 10 MB each.
- Audio: **`{type:"audio_url", audio_url:{url}}`** (HTTPS or `data:`); WAV, MP3, FLAC, OGG (Vorbis/Opus), M4A/AAC;
  8–48 kHz; ≤ 4 files, 25 MB and 5 minutes each. Audio is billed as input tokens.
- Structured outputs: Muse Spark Open "accepts `json_schema` but doesn't enforce the schema"; no JSON mode.
  `n > 1` → HTTP 400; `logprobs` ignored; `seed` / `temperature: 0` not reproducible.
- Price (baseten.co/pricing): **$1.25 input, $0.15 cached input, $4.25 output per 1M tokens**.

**Observed**
- Response: `choices[0].message.{content, role, reasoning_content}`; usage has
  `completion_tokens_details.reasoning_tokens` and `prompt_tokens_details.cached_tokens`. System role works.
- Text: "Reply with exactly: TeacherDox OK" → `TeacherDox OK`, 0.8–1.7 s. `reasoning_effort: "low"`: 17 × 23 → `391`, 0.7–0.9 s.
- Board image + schema → cohort 8B · Mathematics · Fractions · HW "Ex 3.2 Q1-5" in 6.4–6.9 s (~1,700 prompt tokens),
  but the JSON was loose: values wrapped in `**…**`, confidence `99` instead of 0–1, once fenced. Hence: schema
  stated in the prompt, every reply parsed and validated, a mismatch is an error (→ fallback).
- Text-only extraction with a schema once returned `assignments: []` and `confidence: 0` although the homework was in the text.
- Audio (first probe, plain prompt asking for `TRANSCRIPT / ENGLISH / LANGUAGE` lines): synthetic **English** WAV was
  understood (English rendering correct, though the "transcript" came back labelled German, or in Cyrillic, 9–13 s);
  `input_audio` with OGG → HTTP 400 (`audio_url` is the documented part). Synthetic **Malayalam** WAV: "I don't see an
  audio file attached" — not heard.
- Audio with `response_format: json_schema` (second probe): **every** voice note — en/hi/te/ml, OGG and WAV — came back
  "no speech". So the engine asks for labelled lines without a schema for transcription.
