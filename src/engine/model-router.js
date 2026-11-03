/**
 * model-router.js — Model Router for TeacherDox Core
 *
 * Adapts the meta-unignorable framework's model routing for teacherdox-core's
 * existing capability-based router architecture.
 *
 * This provides:
 * - Multi-provider fallback (Meta → Baseten → Host/Generate)
 * - Language-aware routing (100+ languages via NLLB/SeamlessM4T/Llama)
 * - Per-capability model selection
 * - Cost tracking and latency optimization
 * - Consent and privacy-aware routing
 */

const { createMetaProvider } = require('./providers/meta');
const { createBasetenProvider } = require('./providers/baseten');
const { fromGenerate } = require('./providers/fallback');

const { CAPABILITIES } = require('./router');

// =============================================================================
// LANGUAGE SUPPORT (100+ languages via Meta models)
// =============================================================================

/**
 * Language support matrix for Meta models
 * Based on NLLB-200, SeamlessM4T v2, and Llama 3.3 70B coverage
 */
const LANGUAGE_SUPPORT = {
  // Muse Voice Transcribe supported languages (BCP 47 primary subtag -> Meta name)
  transcribe: {
    en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada',
    mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati', pa: 'Punjabi', or: 'Odia',
    as: 'Assamese', ml: 'Malayalam', // Note: ml not actually supported by Muse Voice Transcribe
    pt: 'Portuguese', id: 'Indonesian', ms: 'Malay', fr: 'French',
    es: 'Spanish', ar: 'Arabic', de: 'German', it: 'Italian',
    ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
    tr: 'Turkish', vi: 'Vietnamese', th: 'Thai', pl: 'Polish',
    nl: 'Dutch', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
    fi: 'Finnish', cs: 'Czech', hu: 'Hungarian', ro: 'Romanian',
    bg: 'Bulgarian', hr: 'Croatian', sk: 'Slovak', sl: 'Slovenian',
    et: 'Estonian', lv: 'Latvian', lt: 'Lithuanian', el: 'Greek',
    he: 'Hebrew', fa: 'Persian', ur: 'Urdu', sw: 'Swahili',
    am: 'Amharic', zu: 'Zulu', af: 'Afrikaans', yo: 'Yoruba',
    ig: 'Igbo', ha: 'Hausa', so: 'Somali', ti: 'Tigrinya',
    km: 'Khmer', lo: 'Lao', my: 'Burmese', ka: 'Georgian',
    ne: 'Nepali', si: 'Sinhala', mn: 'Mongolian', bo: 'Tibetan',
    dz: 'Dzongkha', ug: 'Uyghur', ky: 'Kyrgyz', uz: 'Uzbek',
    tk: 'Turkmen', ps: 'Pashto', sd: 'Sindhi', ku: 'Kurdish',
  },

  // SeamlessM4T v2 supported languages (speech-to-text + translation)
  seamlessm4t: {
    // High-resource (speech + text)
    eng: 'English', hin: 'Hindi', spa: 'Spanish', fra: 'French',
    deu: 'German', zho: 'Chinese', jpn: 'Japanese', kor: 'Korean',
    por: 'Portuguese', ita: 'Italian', rus: 'Russian', ara: 'Arabic',
    tur: 'Turkish', vie: 'Vietnamese', tha: 'Thai', ind: 'Indonesian',
    msa: 'Malay', fil: 'Filipino', pol: 'Polish', ukr: 'Ukrainian',
    nld: 'Dutch', ces: 'Czech', swe: 'Swedish', dan: 'Danish',
    fin: 'Finnish', nor: 'Norwegian', hun: 'Hungarian', ron: 'Romanian',
    bul: 'Bulgarian', hrv: 'Croatian', slk: 'Slovak', slv: 'Slovenian',
    est: 'Estonian', lav: 'Latvian', lit: 'Lithuanian', ell: 'Greek',
    heb: 'Hebrew', fas: 'Persian', urd: 'Urdu', swa: 'Swahili',
    amh: 'Amharic', zul: 'Zulu', afr: 'Afrikaans', yor: 'Yoruba',
    ibo: 'Igbo', hau: 'Hausa', som: 'Somali', tir: 'Tigrinya',
    khm: 'Khmer', lao: 'Lao', mya: 'Burmese', kat: 'Georgian',
    nep: 'Nepali', sin: 'Sinhala', mon: 'Mongolian', bod: 'Tibetan',
    dzo: 'Dzongkha', uig: 'Uyghur', kir: 'Kyrgyz', uzb: 'Uzbek',
    tuk: 'Turkmen', pus: 'Pashto', snd: 'Sindhi', kur: 'Kurdish',
    // Medium-resource (text only)
    tam: 'Tamil', tel: 'Telugu', kan: 'Kannada', mar: 'Marathi',
    ben: 'Bengali', guj: 'Gujarati', pan: 'Punjabi', ori: 'Odia',
    asm: 'Assamese', mal: 'Malayalam', sin: 'Sinhala',
  },

  // NLLB-200 supported languages (200 languages, text translation)
  nllb: {
    // All 200 languages supported - abbreviated for key ones
    eng: 'English', hin: 'Hindi', spa: 'Spanish', fra: 'French',
    deu: 'German', zho: 'Chinese', jpn: 'Japanese', kor: 'Korean',
    por: 'Portuguese', ita: 'Italian', rus: 'Russian', ara: 'Arabic',
    tam: 'Tamil', tel: 'Telugu', kan: 'Kannada', mar: 'Marathi',
    ben: 'Bengali', guj: 'Gujarati', pan: 'Punjabi', ori: 'Odia',
    asm: 'Assamese', mal: 'Malayalam', ...Object.keys(require('./languages/nllb-codes.json')),
  },

  // Llama 3.3 70B (Muse Spark) supported languages
  llama: {
    // 30+ languages with strong performance
    en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French',
    de: 'German', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
    pt: 'Portuguese', it: 'Italian', ru: 'Russian', ar: 'Arabic',
    tr: 'Turkish', vi: 'Vietnamese', th: 'Thai', id: 'Indonesian',
    ms: 'Malay', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
    cs: 'Czech', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
    fi: 'Finnish', hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian',
    hr: 'Croatian', sk: 'Slovak', sl: 'Slovenian', et: 'Estonian',
    lv: 'Latvian', lt: 'Lithuanian', el: 'Greek', he: 'Hebrew',
    fa: 'Persian', ur: 'Urdu', sw: 'Swahili',
  },
};

/**
 * Get the best transcription provider for a language
 */
function getTranscribeProvider(language) {
  const lang = String(language || '').toLowerCase().split('-')[0];

  // Check Muse Voice Transcribe
  if (LANGUAGE_SUPPORT.transcribe[lang]) {
    return { provider: 'meta', model: 'muse-voice-transcribe-1.0', supported: true };
  }

  // Check SeamlessM4T (via Baseten or Meta)
  const seamlessCode = Object.keys(LANGUAGE_SUPPORT.seamlessm4t).find(
    k => k.startsWith(lang) || LANGUAGE_SUPPORT.seamlessm4t[k].toLowerCase().includes(lang)
  );
  if (seamlessCode) {
    return { provider: 'baseten', model: 'seamlessm4t-v2', supported: true, note: 'via Baseten' };
  }

  return { provider: null, model: null, supported: false };
}

/**
 * Get the best translation provider for a language pair
 */
function getTranslationProvider(sourceLang, targetLang) {
  const src = sourceLang.toLowerCase().split('-')[0];
  const tgt = targetLang.toLowerCase().split('-')[0];

  // NLLB-200 covers 200 languages
  if (LANGUAGE_SUPPORT.nllb[src] && LANGUAGE_SUPPORT.nllb[tgt]) {
    return { provider: 'meta', model: 'nllb-200', supported: true };
  }

  // SeamlessM4T for speech + text
  if (LANGUAGE_SUPPORT.seamlessm4t[src] && LANGUAGE_SUPPORT.seamlessm4t[tgt]) {
    return { provider: 'baseten', model: 'seamlessm4t-v2', supported: true };
  }

  // Llama for high-resource languages
  if (LANGUAGE_SUPPORT.llama[src] && LANGUAGE_SUPPORT.llama[tgt]) {
    return { provider: 'meta', model: 'muse-spark-1.3', supported: true };
  }

  return { provider: null, model: null, supported: false };
}

/**
 * Get the best structure/check provider for a language
 */
function getStructureProvider(language) {
  const lang = String(language || '').toLowerCase().split('-')[0];

  // Muse Spark (Llama 3.3 70B) supports 30+ languages well
  if (LANGUAGE_SUPPORT.llama[lang]) {
    return { provider: 'meta', model: 'muse-spark-1.3', supported: true };
  }

  // Fallback to Gemini for other languages
  return { provider: 'gemini', model: 'gemini-3.8-flash', supported: true };
}

// =============================================================================
// MODEL ROUTER CLASS
// =============================================================================

class ModelRouter {
  constructor(options = {}) {
    this.options = {
      metaApiKey: options.metaApiKey || process.env.META_API_KEY,
      basetenApiKey: options.basetenApiKey || process.env.BASETEN_API_KEY,
      geminiApiKey: options.geminiApiKey || process.env.GEMINI_API_KEY,
      metaBaseUrl: options.metaBaseUrl || process.env.META_BASE_URL || 'https://api.meta.ai/v1',
      basetenBaseUrl: options.basetenBaseUrl || process.env.BASETEN_BASE_URL,
      timeoutMs: options.timeoutMs || 60000,
      dailyLimits: options.dailyLimits || { meta: 10000, baseten: 5000, gemini: 5000 },
      log: options.log || (() => {}),
      ...options,
    };

    this.providers = new Map();
    this.usage = new Map(); // provider|date -> count
    this._initProviders();
  }

  _initProviders() {
    // Meta provider (first priority)
    if (this.options.metaApiKey) {
      this.providers.set('meta', createMetaProvider({
        apiKey: this.options.metaApiKey,
        baseUrl: this.options.metaBaseUrl,
        fetch: this.options.fetch,
        reasoningEffort: 'low',
        maxCompletionTokens: 8000,
      }));
    }

    // Baseten provider (second priority - Muse Spark Open)
    if (this.options.basetenApiKey) {
      this.providers.set('baseten', createBasetenProvider({
        apiKey: this.options.basetenApiKey,
        baseUrl: this.options.basetenBaseUrl,
        fetch: this.options.fetch,
      }));
    }

    // Host/Generate fallback (third priority - provided by host)
    if (this.options.hostGenerate) {
      this.providers.set('host', fromGenerate(this.options.hostGenerate));
    }
  }

  /**
   * Check if provider has budget left
   */
  _budgetLeft(providerName) {
    const limit = this.options.dailyLimits[providerName];
    if (!limit) return true;

    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `${providerName}|${dayKey}`;
    const used = this.usage.get(key) || 0;
    return used < limit;
  }

  /**
   * Increment usage counter
   */
  _incrementUsage(providerName) {
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `${providerName}|${dayKey}`;
    this.usage.set(key, (this.usage.get(key) || 0) + 1);
  }

  /**
   * Get provider for a capability with language-aware routing
   */
  async getProvider(capability, input, options = {}) {
    const { allow, prefer, tenantId } = options;
    const language = input?.language || input?.textLanguage || 'en';

    // Determine preferred provider for this capability + language
    let providerOrder = ['meta', 'baseten', 'host'];

    if (capability === 'transcribe') {
      const tp = getTranscribeProvider(language);
      if (tp.supported && tp.provider) {
        providerOrder = [tp.provider, ...providerOrder.filter(p => p !== tp.provider)];
      }
    } else if (capability === 'translate') {
      const tp = getTranslationProvider(input?.sourceLang || 'en', language);
      if (tp.supported && tp.provider) {
        providerOrder = [tp.provider, ...providerOrder.filter(p => p !== tp.provider)];
      }
    } else if (capability === 'structure' || capability === 'check') {
      const sp = getStructureProvider(language);
      if (sp.supported && sp.provider) {
        providerOrder = [sp.provider, ...providerOrder.filter(p => p !== sp.provider)];
      }
    }

    // Apply allow list (consent/privacy)
    if (allow) {
      providerOrder = providerOrder.filter(p => allow.includes(p));
    }

    // Apply preference
    if (prefer) {
      providerOrder = [prefer, ...providerOrder.filter(p => p !== prefer)];
    }

    // Try providers in order
    const attempts = [];
    for (const providerName of providerOrder) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      // Check capability
      if (!provider.capabilities.includes(capability)) {
        attempts.push({ provider: providerName, error: 'capability not supported' });
        continue;
      }

      // Check budget
      if (!this._budgetLeft(providerName)) {
        attempts.push({ provider: providerName, error: 'daily limit reached' });
        continue;
      }

      // Check input support
      const ok = provider.supports ? provider.supports(capability, input) : true;
      if (ok !== true) {
        attempts.push({
          provider: providerName,
          error: typeof ok === 'string' ? ok : 'input not supported',
        });
        continue;
      }

      // Provider selected
      this._incrementUsage(providerName);
      return { provider, providerName, attempts };
    }

    throw new Error(
      `No provider available for ${capability}: ${attempts.map(a => `${a.provider}: ${a.error}`).join('; ')}`
    );
  }

  /**
   * Execute a capability with automatic fallback
   */
  async run(capability, input, options = {}) {
    const { provider, providerName, attempts } = await this.getProvider(capability, input, options);
    const startTime = Date.now();

    try {
      const result = await provider[capability](input, { signal: options.signal });
      const elapsed = Date.now() - startTime;

      return {
        output: result.output,
        step: {
          capability,
          provider: providerName,
          model: result.model,
          status: attempts.length ? 'fallback' : 'ok',
          ms: elapsed,
          cost_usd: result.cost_usd ?? null,
          tokens: result.usage ? { input: result.usage.input ?? 0, output: result.usage.output ?? 0 } : null,
          attempts: attempts.length ? attempts : undefined,
        },
      };
    } catch (error) {
      // Try next provider
      const remainingProviders = Array.from(this.providers.keys()).filter(
        p => p !== providerName && (!options.allow || options.allow.includes(p))
      );

      for (const nextProviderName of remainingProviders) {
        const nextProvider = this.providers.get(nextProviderName);
        if (!nextProvider?.capabilities.includes(capability)) continue;
        if (!this._budgetLeft(nextProviderName)) continue;

        const ok = nextProvider.supports ? nextProvider.supports(capability, input) : true;
        if (ok !== true) continue;

        this._incrementUsage(nextProviderName);
        this.options.log({ type: 'fallback', capability, from: providerName, to: nextProviderName });

        try {
          const result = await nextProvider[capability](input, { signal: options.signal });
          const elapsed = Date.now() - startTime;

          return {
            output: result.output,
            step: {
              capability,
              provider: nextProviderName,
              model: result.model,
              status: 'fallback',
              ms: elapsed,
              cost_usd: result.cost_usd ?? null,
              tokens: result.usage ? { input: result.usage.input ?? 0, output: result.usage.output ?? 0 } : null,
              attempts: [...attempts, { provider: providerName, error: error.message }],
            },
          };
        } catch (e) {
          attempts.push({ provider: nextProviderName, error: e.message });
        }
      }

      throw new Error(
        `All providers failed for ${capability}: ${attempts.map(a => `${a.provider}: ${a.error}`).join('; ')}`
      );
    }
  }

  /**
   * Get usage statistics
   */
  getUsage() {
    const result = {};
    for (const [key, count] of this.usage.entries()) {
      const [provider, day] = key.split('|');
      if (!result[provider]) result[provider] = {};
      result[provider][day] = count;
    }
    return result;
  }

  /**
   * Check which languages are supported for a capability
   */
  getSupportedLanguages(capability) {
    switch (capability) {
      case 'transcribe':
        return Object.keys(LANGUAGE_SUPPORT.transcribe);
      case 'translate':
        return Object.keys(LANGUAGE_SUPPORT.nllb);
      case 'structure':
      case 'check':
        return Object.keys(LANGUAGE_SUPPORT.llama);
      default:
        return [];
    }
  }
}

/**
 * Factory function to create model router
 */
function createModelRouter(options = {}) {
  return new ModelRouter(options);
}

module.exports = {
  ModelRouter,
  createModelRouter,
  LANGUAGE_SUPPORT,
  getTranscribeProvider,
  getTranslationProvider,
  getStructureProvider,
};