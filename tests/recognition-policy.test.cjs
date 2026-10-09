const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {normalizeRecognitionLanguage, validateRecognitionTerms, selectRecognitionPlan, selectRecognitionFallback} = require('../recognition-policy.js');
const capable = {cores: 4, memoryGB: 8, mobile: false};
const keys = plan => plan.candidates.map(candidate => candidate.key);

test('explicit languages preserve British locale and multilingual intent', () => {
  for (const input of ['ru', 'ru-RU', ' RU-ru ']) assert.deepEqual(normalizeRecognitionLanguage(input), {language:'ru', workerLanguage:'ru', systemLocale:'ru-RU'});
  for (const input of ['en', 'en-US']) assert.deepEqual(normalizeRecognitionLanguage(input), {language:'en', workerLanguage:'en', systemLocale:'en-US'});
  assert.equal(normalizeRecognitionLanguage('en-GB').systemLocale, 'en-GB');
  for (const language of ['mixed', 'auto']) assert.deepEqual(normalizeRecognitionLanguage(language), {language, workerLanguage:'auto', systemLocale:null});
  assert.equal(normalizeRecognitionLanguage().language, 'ru');
  for (const value of ['', 'fr', 'de-DE', 'ru-UA', 'en-AU', null, 42]) assert.throws(() => normalizeRecognitionLanguage(value));
});

test('system is a verified-local probe and never a mixed/auto shortcut', () => {
  for (const language of ['ru', 'en', 'en-GB']) {
    const plan = selectRecognitionPlan(capable, {language});
    assert.equal(plan.primary.engine, 'system');
    assert.equal(plan.primary.requiresOnDevice, true);
    assert.equal(plan.primary.context.supported, 'conditional');
  }
  for (const language of ['mixed', 'auto']) {
    const plan = selectRecognitionPlan(capable, {language});
    assert.deepEqual(keys(plan), ['whisper', 'whisper_tiny']);
    assert.equal(plan.systemLocale, null);
    assert.equal(plan.workerLanguage, 'auto');
  }
});

test('resource thresholds bound RU alternatives and select capable English base', () => {
  assert.deepEqual(keys(selectRecognitionPlan(capable)), ['system', 'small', 'zipformer', 'giga_ctc']);
  assert.deepEqual(keys(selectRecognitionPlan(capable, {language:'en'})), ['system', 'whisper', 'whisper_tiny']);
  for (const hints of [{}, {cores:4}, {memoryGB:8}, {...capable,mobile:true}, {cores:2,memoryGB:32}, {cores:4,memoryGB:4}, {cores:3,memoryGB:8}, {cores:4,memoryGB:7.9}, {cores:'8',memoryGB:'8'}, {cores:Infinity,memoryGB:8}, null]) {
    assert.deepEqual(keys(selectRecognitionPlan(hints)), ['system', 'small']);
    assert.deepEqual(keys(selectRecognitionPlan(hints, {language:'en'})), ['system', 'whisper_tiny']);
    assert.deepEqual(keys(selectRecognitionPlan(hints, {language:'mixed'})), ['whisper_tiny']);
  }
});

test('budget retains smallest supported model, data saver enforces cache-only', () => {
  assert.deepEqual(keys(selectRecognitionPlan(capable, {allowLargeModels:false})), ['system', 'small']);
  assert.deepEqual(keys(selectRecognitionPlan(capable, {language:'mixed',allowLargeModels:false})), ['whisper_tiny']);
  assert.equal(selectRecognitionPlan({...capable,saveData:true}, {cacheOnly:false}).cacheOnly, true);
  assert.equal(selectRecognitionPlan({}, {cacheOnly:true}).cacheOnly, true);
  assert.equal(selectRecognitionPlan().cacheOnly, false);
  for (const options of [{allowLargeModels:'false'}, {cacheOnly:1}]) assert.throws(() => selectRecognitionPlan({}, options), TypeError);
});

test('context remains raw and unsupported routes explicitly say so', () => {
  const terms = ['PostgreSQL', 'не удалять', 'API v2', 'C++', '  My Product  '];
  const plan = selectRecognitionPlan(capable, {terms});
  assert.deepEqual(plan.terms, terms);
  assert.notEqual(plan.terms, terms);
  assert.equal(plan.candidates.find(item=>item.model==='small').context.mechanism, 'zipformer-hotwords');
  assert.equal(plan.candidates.find(item=>item.model==='giga_ctc').context.supported, false);
  assert.equal(selectRecognitionPlan(capable,{language:'mixed',terms}).primary.context.supported, false);
  assert.equal(validateRecognitionTerms(Array(32).fill('a'.repeat(80))).length, 32);
  for (const invalid of [null, 'Docker', [''], ['   '], [null], ['a\nb'], ['a\u0000b'], ['a\u2028b'], ['a'.repeat(81)], Array(33).fill('a')]) assert.throws(() => validateRecognitionTerms(invalid));
});

test('fallback visits each candidate once and never crosses language families', () => {
  for (const language of ['ru', 'en', 'mixed', 'auto']) {
    const plan = selectRecognitionPlan(capable,{language});
    const attempted = new Set();
    let candidate;
    while ((candidate=selectRecognitionFallback(plan,{attempted}))) {
      assert.ok(!attempted.has(candidate.key));
      attempted.add(candidate.key);
      assert.ok(attempted.size<=plan.maxAttempts);
      if (language!=='ru') assert.ok(!['small','zipformer','giga_ctc'].includes(candidate.key));
    }
    assert.equal(attempted.size,plan.maxAttempts);
  }
});

test('overload only degrades to a smaller unattempted local candidate', () => {
  const en=selectRecognitionPlan(capable,{language:'en'});
  for (const reason of ['overload','queue-overflow','slow']) {
    assert.equal(selectRecognitionFallback(en,{current:'whisper',reason}).key,'whisper_tiny');
    assert.equal(selectRecognitionFallback(en,{current:'whisper_tiny',reason}),null);
    assert.equal(selectRecognitionFallback(en,{current:'system',reason}),null);
    assert.equal(selectRecognitionFallback(en,{current:'whisper',reason,attempted:['whisper_tiny']}),null);
  }
  const ru=selectRecognitionPlan(capable);
  assert.equal(selectRecognitionFallback(ru,{current:'small',reason:'overload'}),null);
  assert.equal(selectRecognitionFallback(ru,{current:'giga_ctc',reason:'overload',attempted:['small']}).key,'zipformer');
  assert.equal(selectRecognitionFallback(ru,{current:ru.primary,attempted:['system']}).key,'small');
  assert.equal(selectRecognitionFallback(ru,{current:'unrecognized',reason:'overload'}),null);
});

test('catalog IDs and browser classic global match CommonJS; plans have no accuracy claims', () => {
  const catalog=vm.runInNewContext(fs.readFileSync(require.resolve('../model-catalog.js'),'utf8')+';SPEECH_MODELS');
  for (const language of ['ru','en','mixed','auto']) {
    const plan=selectRecognitionPlan(capable,{language});
    for(const candidate of plan.candidates) {
      if(candidate.engine==='local') assert.ok(catalog[candidate.model]);
      assert.equal(candidate.accuracy,undefined);
      assert.equal(candidate.confidence,undefined);
    }
  }
  const context={};
  vm.runInNewContext(fs.readFileSync(require.resolve('../recognition-policy.js'),'utf8'),context);
  assert.equal(typeof context.SpeechRecognitionPolicy.selectRecognitionPlan,'function');
  assert.equal(context.SpeechRecognitionPolicy.selectRecognitionPlan().language,'ru');
});
