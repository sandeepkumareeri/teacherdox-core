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
const score = require('./score');
const media = require('./media');

/**
 * Convenience: Meta first (when META_API_KEY is set), then the fallback provider(s).
 * options: meta (provider options or false), fallback (provider or [providers]),
 *   timeoutMs, dailyLimit ({ meta: 500 }), policy, log
 */
function createRecordEngine({ meta = {}, fallback = [], timeoutMs, dailyLimit, policy, log, boardQueries } = {}) {
  const providers = [];
  if (meta !== false) providers.push(createMetaProvider(meta));
  providers.push(...[].concat(fallback).filter(Boolean));
  const router = createRouter({ providers, timeoutMs, dailyLimit, log });
  return { ...createEngine({ router, policy, boardQueries }), router };
}

module.exports = {
  createRecordEngine, createEngine, createRouter, RouterError, CAPABILITIES, PIPELINE_VERSION,
  createMetaProvider, parseSamBoxes, fromGenerate, toGeminiSchema, score, media,
};
