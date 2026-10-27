'use strict';
// Media helpers for the Record Engine, using ffmpeg when it is installed (it is an
// optional, external tool — the engine still works without it, with less: no OGG→WAV
// for Muse Voice Transcribe, so voice notes go to the fallback provider, and no board
// crop, so the whole photo is read with the board region given as a hint).

const { spawn, spawnSync } = require('node:child_process');

const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';
let available = null;

function hasFfmpeg() {
  if (available === null) {
    try { available = spawnSync(FFMPEG(), ['-version'], { stdio: 'ignore' }).status === 0; } catch { available = false; }
  }
  return available;
}

/** Run ffmpeg with bytes on stdin; resolves with stdout bytes. */
function ffmpeg(args, input, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!hasFfmpeg()) return reject(Object.assign(new Error('ffmpeg is not installed'), { code: 'NO_FFMPEG' }));
    const p = spawn(FFMPEG(), ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
    });
    p.stdin.on('error', () => {});   // ffmpeg may close stdin early on bad input; the exit code reports it
    p.stdin.end(input);
  });
}

/** Parse a RIFF/WAVE header → { format, channels, sampleRate, bitsPerSample } or null. */
function wavInfo(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  for (let o = 12; o + 8 <= b.length;) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ' && o + 24 <= b.length) {
      return { format: b.readUInt16LE(o + 8), channels: b.readUInt16LE(o + 10), sampleRate: b.readUInt32LE(o + 12), bitsPerSample: b.readUInt16LE(o + 22) };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

/** True when bytes are already what Muse Voice Transcribe accepts: mono 16-bit PCM WAV at 16 or 24 kHz. */
function isTranscribeReadyWav(bytes) {
  const w = wavInfo(bytes);
  return !!w && w.format === 1 && w.channels === 1 && w.bitsPerSample === 16 && (w.sampleRate === 16000 || w.sampleRate === 24000);
}

/** Any audio ffmpeg can read (WhatsApp OGG/Opus, MP3, M4A…) → mono 16 kHz 16-bit PCM WAV. */
async function toTranscribeWav(bytes) {
  if (isTranscribeReadyWav(bytes)) return Buffer.from(bytes);
  return ffmpeg(['-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], bytes);
}

/** 16 kHz mono 16-bit WAV duration in seconds (for cost accounting when a provider reports none). */
function wavSeconds(bytes) {
  const w = wavInfo(bytes);
  if (!w) return null;
  return Math.max(0, (Buffer.from(bytes).length - 44) / (w.sampleRate * w.channels * (w.bitsPerSample / 8)));
}

/**
 * Crop an image to a pixel box (with a small margin) → JPEG bytes.
 * box: { x1, y1, x2, y2, width, height } in pixels of the original image.
 */
async function cropImage(bytes, box, { margin = 0.02 } = {}) {
  const mx = Math.round(box.width * margin), my = Math.round(box.height * margin);
  const x = Math.max(0, Math.round(box.x1) - mx), y = Math.max(0, Math.round(box.y1) - my);
  const w = Math.min(box.width, Math.round(box.x2) + mx) - x, h = Math.min(box.height, Math.round(box.y2) + my) - y;
  if (w < 16 || h < 16) throw new Error('crop box too small');
  return ffmpeg(['-i', 'pipe:0', '-vf', `crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], bytes);
}

module.exports = { hasFfmpeg, ffmpeg, wavInfo, isTranscribeReadyWav, toTranscribeWav, wavSeconds, cropImage };
