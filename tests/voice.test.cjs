const {test}=require('node:test');const assert=require('node:assert/strict');
const load=()=>import('../sdk/voice.mjs');
test('voice provider completion, busy rejection, cancellation and terminal dispose',async()=>{
 const {createVoice}=await load();let finish,signal,cancelled=0;
 const voice=createVoice({provider:{speak:(_,o)=>{signal=o.signal;return new Promise(r=>{finish=r;});},cancel(){cancelled++;}}});
 const first=voice.speak('Привет');await assert.rejects(voice.speak('ещё'),/busy/);finish();await first;assert.equal(voice.speaking,false);
 const second=voice.speak('отмена');voice.cancel();await assert.rejects(second,{name:'AbortError'});assert.equal(signal.aborted,true);assert.equal(cancelled,1);
 finish();voice.dispose();await assert.rejects(voice.speak('позже'),/disposed/);
});
test('remote-only browser voice is rejected; no automatic cloud synthesis',async()=>{
 const {createVoice}=await load();let calls=0;
 global.speechSynthesis={getVoices:()=>[{lang:'ru-RU',localService:false}],speak(){calls++;}};
 try {await assert.rejects(createVoice().speak('Привет'),/No installed local voice/);assert.equal(calls,0);}finally{delete global.speechSynthesis;}
});
test('system synthesis resolves only on playback end and selects local locale',async()=>{
 const {createVoice}=await load();let utterance;
 global.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};
 global.speechSynthesis={getVoices:()=>[{lang:'ru-RU',localService:true,voiceURI:'local'}],speak(u){utterance=u;}};
 try {const voice=createVoice();const done=voice.speak('Привет');assert.equal(voice.speaking,true);assert.equal(utterance.voice.voiceURI,'local');utterance.onend();await done;assert.equal(voice.speaking,false);}finally{delete global.speechSynthesis;delete global.SpeechSynthesisUtterance;}
});
test('timeout aborts provider; failed synthesis can retry',async()=>{
 const {createVoice}=await load();let cancels=0;
 const voice=createVoice({timeoutMs:100,provider:{speak:()=>new Promise(()=>{}),cancel(){cancels++;}}});
 await assert.rejects(voice.speak('тест'),{name:'AbortError'});assert.equal(cancels,1);voice.dispose();
 const failed=createVoice({provider:{speak(){throw Error('offline');},cancel(){}}});await assert.rejects(failed.speak('тест'),/offline/);assert.equal(failed.speaking,false);
});
test('Tauri adapter passes literal text, no shell command, and invokes cancellation',async()=>{
 const {createTauriVoiceProvider,createVoice}=await load();const calls=[];
 const p=createTauriVoiceProvider(async(...args)=>{calls.push(args);});
 await createVoice({provider:p}).speak('$(not a command)');await p.cancel();assert.equal(calls[0][0],'local_speech_speak');assert.equal(calls[0][1].text,'$(not a command)');assert.equal(calls[1][0],'local_speech_cancel');
});
