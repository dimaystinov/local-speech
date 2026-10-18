/** Local-only system synthesis, or an explicitly supplied host provider. */
export function createVoice({provider, language = 'ru-RU', voiceURI, rate = 1, pitch = 1, timeoutMs = 120000} = {}) {
  if (![rate,pitch,timeoutMs].every(Number.isFinite) || rate < .1 || rate > 10 || pitch < 0 || pitch > 2 || timeoutMs < 100 || timeoutMs > 300000) throw new TypeError('Invalid voice options');
  if (provider && (typeof provider.speak !== 'function' || typeof provider.cancel !== 'function')) throw new TypeError('Provider needs speak and cancel');
  let active = null, disposed = false;
  const synth = globalThis.speechSynthesis;
  const voices = () => (synth?.getVoices() || []).filter(v => v.localService === true).map(v => ({name:v.name, lang:v.lang, voiceURI:v.voiceURI}));
  function cancel() {
    if (!active) return;
    const current = active;
    current.controller.abort();
    current.finish(new DOMException('Speech cancelled', 'AbortError'));
    if (provider) { try { Promise.resolve(provider.cancel()).catch(() => {}); } catch {} }
    else synth?.cancel();
  }
  function speak(text) {
    if (disposed) return Promise.reject(new Error('Voice disposed'));
    if (active) return Promise.reject(new Error('Voice busy; await speak or cancel first'));
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return Promise.reject(new TypeError('Text must contain 1–4000 characters'));
    return new Promise((resolve,reject) => {
      const controller = new AbortController();
      let timer;
      const current = {controller, finish(error) {
        if (active !== current) return;
        active = null; clearTimeout(timer); error ? reject(error) : resolve();
      }};
      active = current;
      timer = setTimeout(() => { cancel(); }, timeoutMs);
      try {
        if (provider) {
          Promise.resolve(provider.speak(text,{language,voiceURI,rate,pitch,signal:controller.signal})).then(() => current.finish(), e => current.finish(e));
          return;
        }
        const voice = synth?.getVoices().find(v => v.localService === true && (voiceURI ? v.voiceURI === voiceURI : v.lang.toLowerCase().split('-')[0] === language.toLowerCase().split('-')[0]));
        if (!voice || !globalThis.SpeechSynthesisUtterance) throw new Error('No installed local voice. Install a system voice or supply a local TTS provider.');
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = voice; utterance.lang = language; utterance.rate = rate; utterance.pitch = pitch;
        utterance.onend = () => current.finish();
        utterance.onerror = event => current.finish(new Error(event.error || 'Synthesis failed'));
        synth.speak(utterance);
      } catch (error) { current.finish(error); }
    });
  }
  return {voices, speak, cancel, dispose(){ disposed=true; cancel(); }, get speaking(){return active !== null;}};
}

/** Host owns the Tauri commands, local model and playback. No HTTP/cloud fallback. */
export function createTauriVoiceProvider(invoke, {speakCommand='local_speech_speak', cancelCommand='local_speech_cancel'} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('Tauri invoke function required');
  return {
    speak(text, {language,voiceURI,rate,pitch}) { return invoke(speakCommand,{text,language,voiceUri:voiceURI ?? null,rate,pitch}); },
    cancel() { return invoke(cancelCommand); }
  };
}
