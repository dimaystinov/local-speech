/* Pure selection policy. Capability probes and observed speed belong to the host.
 * A candidate is permission to try, never proof of language accuracy or speed. */
(function (root) {
  'use strict';
  const TERM_LIMIT = 32;
  const TERM_LENGTH_LIMIT = 80;

  function normalizeRecognitionLanguage(value = 'ru') {
    if (typeof value !== 'string') throw new TypeError('language must be a supported language string');
    const tag = value.trim().toLowerCase();
    if (tag === 'ru' || tag === 'ru-ru') return {language: 'ru', workerLanguage: 'ru', systemLocale: 'ru-RU'};
    if (tag === 'en' || tag === 'en-us' || tag === 'en-gb') {
      return {language: 'en', workerLanguage: 'en', systemLocale: tag === 'en-gb' ? 'en-GB' : 'en-US'};
    }
    if (tag === 'mixed' || tag === 'auto') return {language: tag, workerLanguage: 'auto', systemLocale: null};
    throw new RangeError('Unsupported language: use ru, ru-RU, en, en-US, en-GB, mixed or auto');
  }

  function validateRecognitionTerms(terms = []) {
    if (!Array.isArray(terms)) throw new TypeError('terms must be an array');
    if (terms.length > TERM_LIMIT) throw new RangeError(`At most ${TERM_LIMIT} terms are supported`);
    return terms.map(term => {
      if (typeof term !== 'string' || !term.trim()) throw new TypeError('Each term must be a nonempty string');
      if (term.length > TERM_LENGTH_LIMIT) throw new RangeError(`Each term must contain at most ${TERM_LENGTH_LIMIT} characters`);
      if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(term)) throw new TypeError('Terms cannot contain control characters or line separators');
      // Preserve names, scripts, punctuation, numbers and negations verbatim.
      return term;
    });
  }

  function normalizedHints(hints) {
    const source = hints && typeof hints === 'object' ? hints : {};
    const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    return {cores: positive(source.cores), memoryGB: positive(source.memoryGB), mobile: source.mobile === true, saveData: source.saveData === true};
  }

  function contextCapability(engine, model) {
    if (engine === 'system') return {
      supported: 'conditional', mechanism: 'phrases',
      note: 'Only when the verified on-device recognizer exposes phrase biasing; otherwise terms remain unapplied.'
    };
    if (model === 'small' || model === 'zipformer') return {
      supported: 'conditional', mechanism: 'zipformer-hotwords',
      note: 'Requires modified beam search and tokenizer-compatible Russian terms. Latin technical names are not automatically transliterated.'
    };
    return {supported: false, mechanism: null, note: 'This adapter does not apply contextual terms to this model. Raw transcription is preserved.'};
  }

  function candidate(engine, model, rank) {
    return {key: engine === 'system' ? 'system' : model, engine, model, resourceRank: rank,
      requiresOnDevice: true, context: contextCapability(engine, model)};
  }

  function selectRecognitionPlan(hints = {}, {language = 'ru', allowLargeModels = true, cacheOnly = false, terms = []} = {}) {
    for (const [name, value] of Object.entries({allowLargeModels, cacheOnly})) {
      if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
    }
    const normalized = normalizeRecognitionLanguage(language);
    const checkedTerms = validateRecognitionTerms(terms);
    const device = normalizedHints(hints);
    const unknown = device.cores === null || device.memoryGB === null;
    const limited = device.mobile || (device.cores !== null && device.cores <= 2) || (device.memoryGB !== null && device.memoryGB <= 4);
    const capable = !device.mobile && !unknown && device.memoryGB >= 8 && device.cores >= 4;
    const tier = limited ? 'light' : unknown ? 'unknown' : capable ? 'capable' : 'balanced';
    const candidates = [];
    const notes = [
      'System recognition must pass an explicit on-device and language availability probe; network recognition is never an implicit fallback.',
      'Device hints only bound initial choices. Runtime load failures and measured processing speed can require degradation.',
      'No model confidence is represented as a percentage of transcription accuracy.'
    ];
    if (normalized.systemLocale) candidates.push(candidate('system', null, null));
    else notes.push('Mixed/auto mode bypasses fixed-locale system recognition. Per-segment language detection does not guarantee accurate code switching.');

    if (normalized.language === 'ru') {
      candidates.push(candidate('local', 'small', 1));
      if (capable && allowLargeModels) {
        candidates.push(candidate('local', 'zipformer', 2), candidate('local', 'giga_ctc', 3));
      }
    } else {
      if (capable && allowLargeModels) candidates.push(candidate('local', 'whisper', 2));
      candidates.push(candidate('local', 'whisper_tiny', 1));
    }
    if (!allowLargeModels) notes.push('Large-model opt-out retains the smallest supported local route: Russian Zipformer INT8 or multilingual Whisper tiny.');
    if (device.saveData) notes.push('Data-saving mode requires cached local assets; missing assets must fail without downloading.');
    if (checkedTerms.length) notes.push('Terms are hints only where the selected engine supports them; no transcription rewriting is authorized.');
    return {...normalized, tier, cacheOnly: cacheOnly || device.saveData, allowLargeModels,
      terms: checkedTerms, candidates, primary: candidates[0] || null, fallbacks: candidates.slice(1),
      maxAttempts: candidates.length, notes};
  }

  function selectRecognitionFallback(plan, {attempted = [], reason = 'failure', current = null} = {}) {
    if (!plan || !Array.isArray(plan.candidates)) throw new TypeError('A recognition plan is required');
    if (!(attempted instanceof Set) && !Array.isArray(attempted)) throw new TypeError('attempted must be a Set or array of candidate keys');
    const used = new Set(attempted);
    const currentKey = typeof current === 'string' ? current : current && current.key;
    const active = plan.candidates.find(item => item.key === currentKey);
    if (currentKey) used.add(currentKey);
    const overloaded = ['overload', 'queue-overflow', 'slow'].includes(reason);
    if (overloaded && (!active || active.engine !== 'local')) return null;
    return plan.candidates.find(item => !used.has(item.key) && (!overloaded || (
      item.engine === 'local' && item.resourceRank < active.resourceRank
    ))) || null;
  }

  const api = {normalizeRecognitionLanguage, validateRecognitionTerms, selectRecognitionPlan, selectRecognitionFallback};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpeechRecognitionPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
