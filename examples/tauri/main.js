(async () => {
const el = id => document.getElementById(id);
let speech, voice;
const status = text => {el('status').textContent = text;};
try {
  const {version} = await (await fetch('/speech-version.json')).json();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid SDK version');
  const base = new URL(`/speech/${version}/`, location.href).href;
  const sdk = await import(/* @vite-ignore */ base+'local-speech.mjs');
  const tts = await import(/* @vite-ignore */ base+'voice.mjs');
  voice = tts.createVoice(window.__TAURI__?.core?.invoke ? {provider:tts.createTauriVoiceProvider(window.__TAURI__.core.invoke)} : {});
  el('start').disabled = false; el('speak').disabled = false;
  status(`SDK ${sdk.version} готов. Нажмите «Начать».`);
  el('start').onclick = async () => {
    el('start').disabled = true; el('language').disabled = true; el('speak').disabled = true;
    voice.cancel();
    try {
      await speech?.dispose();
      speech = sdk.create({assetBaseURL:base,language:el('language').value,maxSegmentSeconds:6});
      speech.on('partial',e => {el('partial').textContent=e.text || '';});
      speech.on('final',e => {el('text').value += (el('text').value?'\n':'')+e.rawText;el('partial').textContent='';});
      speech.on('error',e => status(e.message));
      speech.on('progress',() => status('Загрузка локальной модели…'));
      await speech.start(); el('stop').disabled=false; status('Слушаю…');
    } catch(e) {status(e.message);el('start').disabled=false;el('language').disabled=false;el('speak').disabled=false;}
  };
  el('stop').onclick = async () => {
    el('stop').disabled=true;
    try {await speech.stop();status('Остановлено.');} catch(e){status(e.message);}
    finally{el('start').disabled=false;el('language').disabled=false;el('speak').disabled=false;}
  };
  el('speak').onclick = async () => {
    el('speak').disabled=true;el('start').disabled=true;el('silence').disabled=false;
    try {await voice.speak(el('text').value);status('Озвучка завершена.');} catch(e){status(e.message);}
    finally{el('speak').disabled=false;el('start').disabled=false;el('silence').disabled=true;}
  };
  el('silence').onclick = () => voice.cancel();
  addEventListener('pagehide',()=>{voice.dispose();void speech?.dispose();});
} catch(e) {status(e.message);}
el('copy').onclick = async () => {
  try {await navigator.clipboard.writeText(el('text').value);status('Скопировано.');}
  catch {el('text').focus();el('text').select();status('Нажмите Cmd+C / Ctrl+C.');}
};

})();
