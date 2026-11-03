/**
 * fallback.js — Host-provided fallback adapter for TeacherDox Core
 *
 * This wraps the host's `generate()` function (e.g., Google Gemini) into the
 * standard provider interface expected by the Record Engine router.
 *
 * The host MUST provide a function with signature:
 *   async generate({ capability, input, options }) => { output, model, usage?, cost_usd? }
 */

const { CAPABILITIES } = require('../router');

/**
 * Wrap a host `generate` function as a Record Engine provider.
 *
 * @param {Function} hostGenerate - Host's generate function
 * @returns {Object} Provider object with standard interface
 */
function fromGenerate(hostGenerate) {
  if (typeof hostGenerate !== 'function') {
    throw new Error('fromGenerate: hostGenerate must be a function');
  }

  // Capability mapping: engine capability -> host capability
  const CAPABILITY_MAP = {
    segment: 'segment',
    transcribe: 'transcribe',
    structure: 'structure',
    check: 'check',
  };

  return {
    name: 'host',
    models: { generate: 'host-provided' },
    capabilities: CAPABILITIES,

    supports(capability, input) {
      // Host generate is the ultimate fallback - always say yes if we have the function
      return true;
    },

    async segment(input, { signal } = {}) {
      return hostGenerate({
        capability: CAPABILITY_MAP.segment,
        input,
        options: { signal },
      });
    },

    async transcribe(input, { signal } = {}) {
      return hostGenerate({
        capability: CAPABILITY_MAP.transcribe,
        input,
        options: { signal },
      });
    },

    async structure(input, { signal } = {}) {
      return hostGenerate({
        capability: CAPABILITY_MAP.structure,
        input,
        options: { signal },
      });
    },

    async check(input, { signal } = {}) {
      return hostGenerate({
        capability: CAPABILITY_MAP.check,
        input,
        options: { signal },
      });
    },
  };
}

/**
 * Create a mock fallback provider for testing without a host
 */
function createMockFallbackProvider() {
  return {
    name: 'mock',
    models: { mock: 'mock-fallback' },
    capabilities: CAPABILITIES,

    supports() {
      return true;
    },

    async segment() {
      return {
        output: { boxes: [] },
        model: 'mock',
        cost_usd: 0,
      };
    },

    async transcribe({ language }) {
      return {
        output: {
          text: '[mock transcription]',
          language: language || 'en',
          duration_ms: 5000,
        },
        model: 'mock',
        cost_usd: 0,
      };
    },

    async structure({ schema }) {
      // Return a minimal valid object matching the schema
      const mockOutput = {};
      if (schema?.properties) {
        for (const [key, prop] of Object.entries(schema.properties)) {
          if (prop.type === 'string') mockOutput[key] = `[mock ${key}]`;
          else if (prop.type === 'number') mockOutput[key] = 0;
          else if (prop.type === 'boolean') mockOutput[key] = false;
          else if (prop.type === 'array') mockOutput[key] = [];
          else mockOutput[key] = null;
        }
      }
      return {
        output: mockOutput,
        model: 'mock',
        cost_usd: 0,
      };
    },

    async check(input) {
      return {
        output: { ...input, verified: true, issues: [] },
        model: 'mock',
        cost_usd: 0,
      };
    },
  };
}

module.exports = { fromGenerate, createMockFallbackProvider };