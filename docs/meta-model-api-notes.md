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
