'use strict';
// TeacherDox Core — Record Engine: evidence → draft .tdx 2.0 capsule, on Meta's models
// with a host-supplied fallback.
//
//   const { createRecordEngine } = require('teacherdox-core/src/engine');
//   const engine = createRecordEngine({ fallback: fromGenerate(gemini.generate) });
//   const { capsule, routing } = await engine.process({ evidence, text, context });

const { createRouter, RouterError, CAPABILITIES } = require('./router');
const { createEngine, PIPELINE_VERSION } = require('./engine');
const { createMetaProvider, parseSamBoxes } = require('./providers/meta');
const { fromGenerate, toGeminiSchema } = require('./providers/gemini');
const { createBasetenProvider } = require('./providers/baseten');
const score = require('./score');
const media = require('./media');

/**
 * Convenience: the Meta Model API first, then Muse Spark Open (Meta's open weights) on Baseten when
 * a Baseten key is configured, then the host's fallback provider(s).
 * options: meta / baseten (provider options, or false to leave out), fallback (provider or [providers]),
 *   timeoutMs, dailyLimit ({ meta: 500, baseten: 500 }), policy, log
 */
function createRecordEngine({ meta = {}, baseten = {}, fallback = [], timeoutMs, dailyLimit, policy, log, boardQueries } = {}) {
  const providers = [];
  if (meta !== false) providers.push(createMetaProvider(meta));
  if (baseten !== false && (baseten.apiKey || process.env.BASETEN_API_KEY)) providers.push(createBasetenProvider(baseten));
  providers.push(...[].concat(fallback).filter(Boolean));
  const router = createRouter({ providers, timeoutMs, dailyLimit, log });
  return { ...createEngine({ router, policy, boardQueries }), router };
}

module.exports = {
  createRecordEngine, createEngine, createRouter, RouterError, CAPABILITIES, PIPELINE_VERSION,
  createMetaProvider, parseSamBoxes, createBasetenProvider, fromGenerate, toGeminiSchema, score, media,
};
