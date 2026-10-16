const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function harness({hints={hardwareConcurrency:8,deviceMemory:8},systemAvailable=false,loadHook=null}={}){
 const engines=[],events=[],captures=[];
 class Engine{constructor(model,emit,error,options){Object.assign(this,{model,emit,error,options,packets:[]});engines.push(this);}async load(progress,options){this.optionsLoaded=options;if(loadHook)await loadHook(this);return {downloadedBytes:0};}begin(options){this.session=options;}async audio(pcm,rate,id,hints){if(this.closed)throw Error('closed');this.packets.push({pcm,rate,id,hints});if(this.failAudio){this.failAudio=false;throw Object.assign(Error('overload'),{code:'overload'});}}async end(){this.emit({type:'final',sessionId:this.session.sessionId,segmentId:this.session.segmentBase+1,text:'не удаляй Docker',startMs:this.session.offsetMs,endMs:this.session.offsetMs+100});}close(){this.closed=true;}}
 class Native{constructor(API,emit,state){this.emit=emit;this.state=state;}async check(){return {status:systemAvailable?'available':'unsupported'};}start(lang,id){this.sessionId=id;}endPhrase(){}stop(){this.state('stopped');}dispose(){this.closed=true;}}
 class Capture{constructor(onSamples,onEnded,options){Object.assign(this,{onSamples,onEnded,options});captures.push(this);}async start(){}async stop(){if(this.tail)await this.onSamples(this.tail,16000);this.stopped=true;}}
 const ctx={queueMicrotask,URL,Float32Array,AbortController,console,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto,navigator:hints,location:{href:'https://host/app/',origin:'https://host'},LocalEngine:Engine,SystemRecognizer:Native,MicrophoneCapture:Capture};vm.createContext(ctx);
 for(const file of ['device-policy.js','resilience.js','recognition-policy.js','sdk/local-speech.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx,{filename:file});
 const client=ctx.LocalSpeech.create({assetBaseURL:'https://host/assets/speech/',language:'mixed'});client.on('*',e=>events.push(e));return {ctx,client,engines,events,captures};
}
test('native host resource budget is explicit, copied and still conservatively normalized',async()=>{
 const h=harness({hints:{}}),deviceHints={cores:5,memoryGB:8,mobile:false,saveData:false};
 const client=h.ctx.LocalSpeech.create({assetBaseURL:'https://host/assets/',language:'mixed',deviceHints});
 deviceHints.memoryGB=1;await client.start({input:'pcm'});assert.equal(client.diagnostics().backend,'whisper');await client.dispose();
 const unknown=h.ctx.LocalSpeech.create({assetBaseURL:'https://host/assets/',language:'mixed',deviceHints:{cores:NaN,memoryGB:Infinity}});
 await unknown.start({input:'pcm'});assert.equal(unknown.diagnostics().backend,'whisper_tiny');await unknown.dispose();
});
test('segment window validates options and reaches initial and fallback engines',async()=>{
 const h=harness();
 for(const maxSegmentSeconds of [2.99,20.01,NaN,Infinity,'6',null])assert.throws(()=>h.ctx.LocalSpeech.create({assetBaseURL:'https://host/assets/',maxSegmentSeconds}),/maxSegmentSeconds/);
 await h.client.start({input:'pcm'});assert.equal(h.engines[0].session.maxSegmentSeconds,12);await h.client.dispose();
 const custom=h.ctx.LocalSpeech.create({assetBaseURL:'https://host/assets/',language:'mixed',maxSegmentSeconds:6});
 await custom.start({input:'pcm'});assert.equal(h.engines[1].session.maxSegmentSeconds,6);h.engines[1].failAudio=true;
 await custom.write(new Float32Array(1600),16000);assert.equal(h.engines[2].session.maxSegmentSeconds,6);await custom.dispose();
 for(const maxSegmentSeconds of [3,20]){const client=h.ctx.LocalSpeech.create({assetBaseURL:'https://host/assets/',maxSegmentSeconds});await client.dispose();}
});
test('embedding resolves base and mixed never probes system or RU-only engines',async()=>{const h=harness();await h.client.start({input:'pcm'});assert.equal(h.client.diagnostics().backend,'whisper');assert.equal(h.engines[0].options.assetBaseURL,'https://host/assets/speech/');assert.equal(h.engines[0].optionsLoaded.language,'auto');const pcm=new Float32Array(1600).fill(.1);await h.client.write(pcm,16000);assert.equal(pcm.length,1600);await h.client.stop();const final=h.events.find(x=>x.type==='final');assert.equal(final.rawText,'не удаляй Docker');assert.equal(final.turnComplete,false);assert.equal(final.quality.accuracy,null);assert.equal(h.client.state,'idle');});
test('overload downgrades base to tiny and replays original PCM',async()=>{const h=harness();await h.client.start({input:'pcm'});h.engines[0].failAudio=true;await h.client.write(new Float32Array(1600).fill(.25),16000);assert.equal(h.engines[1].model,'whisper_tiny');assert.equal(h.engines[1].packets.length,1);assert.equal(h.engines[1].packets[0].pcm[0],.25);assert.equal(h.client.state,'listening');assert.ok(h.engines[0].closed);await h.client.stop();});
test('stale old worker final cannot duplicate a recovered result',async()=>{const h=harness();await h.client.start({input:'pcm'});const old=h.engines[0];old.failAudio=true;await h.client.write(new Float32Array(1600),16000);old.emit({type:'final',sessionId:h.client.sessionId,segmentId:99,text:'stale'});await h.client.stop();assert.equal(h.events.filter(x=>x.type==='final').length,1);});
test('PCM validation rejects invalid data and changed sample rate without losing input',async()=>{const h=harness();await h.client.start({input:'pcm'});for(const pcm of [new Float32Array([NaN]),new Float32Array([2]),new Float32Array(0)])await assert.rejects(h.client.write(pcm,16000));await h.client.write(new Float32Array(1600),16000);await assert.rejects(h.client.write(new Float32Array(4800),48000),/rate/);await h.client.stop();});
test('observer exceptions cannot prevent stop or disposal',async()=>{const h=harness();h.client.on('*',()=>{throw Error('host');});await h.client.start({input:'pcm'});await h.client.write(new Float32Array(1600),16000);await h.client.dispose();assert.equal(h.client.state,'disposed');assert.ok(h.engines[0].closed);assert.throws(()=>h.client.start(),/disposed/);});
test('stop during model preparation cancels old start',async()=>{let release;const h=harness({loadHook:()=>new Promise(r=>{release=r;})});const start=h.client.start({input:'pcm'});const rejected=assert.rejects(start,/cancelled/i);await h.client.stop();release();await rejected;assert.equal(h.client.state,'idle');assert.ok(h.engines[0].closed);});
test('old cancelled preparation cannot close a newly started engine',async()=>{let release,loads=0;const h=harness({loadHook:()=>++loads===1?new Promise(r=>{release=r;}):Promise.resolve()});const old=h.client.start({input:'pcm'});const rejected=assert.rejects(old);await h.client.stop();await h.client.start({input:'pcm'});release();await rejected;assert.notEqual(h.engines[1].closed,true);await h.client.stop();});
test('save-data mode forbids new model downloads',async()=>{const h=harness({hints:{hardwareConcurrency:8,deviceMemory:8,connection:{saveData:true}}});await h.client.start({input:'pcm'});assert.equal(h.engines[0].optionsLoaded.cacheOnly,true);await h.client.stop();});
test('real microphone stop forwards flush tail before finalization',async()=>{const h=harness();await h.client.start();h.captures[0].tail=new Float32Array(1600).fill(.1);await h.client.stop();assert.equal(h.engines[0].packets.length,1);assert.equal(h.events.filter(x=>x.type==='final').length,1);});
test('unsupported language is rejected before constructing any engine',()=>{const h=harness();assert.throws(()=>h.ctx.LocalSpeech.create({assetBaseURL:'https://host/assets/',language:'fr'}));assert.equal(h.engines.length,0);});
test('late rejected replay cannot close new session backend',async()=>{const h=harness();await h.client.start({input:'pcm'});let rejectReplay,entered;const ready=new Promise(r=>entered=r);const original=h.client.nextBackend.bind(h.client);h.client.nextBackend=async(...args)=>{await original(...args);if(h.engines.length===2)h.engines[1].audio=()=>new Promise((_,reject)=>{rejectReplay=reject;entered();});};h.engines[0].failAudio=true;const oldWrite=h.client.write(new Float32Array(1600),16000);await ready;await h.client.stop();await h.client.start({input:'pcm'});rejectReplay(Error('old replay'));await oldWrite;assert.notEqual(h.engines[2].closed,true);assert.equal(h.client.state,'listening');await h.client.stop();});
test('dispose is terminal even when idle listener tries restarting',async()=>{const h=harness();await h.client.start({input:'pcm'});let rejected=false;h.client.on('state',e=>{if(e.state==='idle'){try{h.client.start({input:'pcm'});}catch{rejected=true;}}});await h.client.dispose();await new Promise(r=>setImmediate(r));assert.equal(h.client.state,'disposed');assert.equal(rejected,true);});

test('reentrant stop shares one operation and waits for asynchronous capture flush',async()=>{const h=harness();await h.client.start();let flush;h.captures[0].stop=()=>new Promise(resolve=>{flush=async()=>{await h.captures[0].onSamples(new Float32Array(1600),16000);resolve();};});let nested;h.client.on('state',e=>{if(e.state==='stopping')nested=h.client.stop();});let stopped=false;const outer=h.client.stop();outer.then(()=>stopped=true);await new Promise(r=>setImmediate(r));assert.equal(stopped,false);assert.equal(nested,outer);await flush();await outer;assert.equal(h.engines[0].packets.length,1);assert.equal(h.client.state,'idle');});
test('old multi-packet write cannot feed a restarted session',async()=>{const h=harness();await h.client.start({input:'pcm'});let release;h.engines[0].audio=()=>new Promise(r=>release=r);const old=h.client.write(new Float32Array(3200),16000);const rejected=assert.rejects(old,/interrupted/);await h.client.stop();await h.client.start({input:'pcm'});release();await rejected;assert.equal(h.engines[1].packets.length,0);await h.client.stop();});
test('late rejected direct audio does not recover a newer session',async()=>{const h=harness();await h.client.start({input:'pcm'});let reject;h.engines[0].audio=()=>new Promise((_,r)=>reject=r);const old=h.client.write(new Float32Array(1600),16000);const rejected=assert.rejects(old,/interrupted/);await h.client.stop();await h.client.start({input:'pcm'});reject(Error('late'));await rejected;assert.notEqual(h.engines[1].closed,true);assert.equal(h.client.state,'listening');await h.client.dispose();});
test('concurrent dispose calls share completion until microphone released',async()=>{const h=harness();await h.client.start();let release;h.captures[0].stop=()=>new Promise(r=>release=r);const a=h.client.dispose(),b=h.client.dispose();assert.equal(a,b);let done=false;b.then(()=>done=true);await new Promise(r=>setImmediate(r));assert.equal(done,false);release();await a;assert.equal(h.client.state,'disposed');assert.ok(h.engines[0].closed);});
test('repeated single-candidate sessions reset previous candidate exclusion',async()=>{const h=harness({hints:{hardwareConcurrency:2,deviceMemory:4}});for(let i=0;i<3;i++){await h.client.start({input:'pcm'});assert.equal(h.client.diagnostics().backend,'whisper_tiny');await h.client.write(new Float32Array(1600),16000);await h.client.stop();}assert.equal(h.engines.length,3);});
test('exhausted fallback preserves the original decode failure and bounded diagnostics',async()=>{
 const h=harness({hints:{hardwareConcurrency:2,deviceMemory:4}});await h.client.start({input:'pcm'});
 const failure=Object.assign(Error('decode exceeded 8 seconds'),{code:'timeout',processing:{stage:'final',packetId:9},pendingAudio:{queueDepth:1,oldestAgeMs:8100}});
 h.engines[0].audio=async()=>{throw failure;};await h.client.write(new Float32Array(1600),16000);
 const event=h.events.find(x=>x.type==='error');assert.equal(event.code,'timeout');assert.match(event.message,/decode exceeded 8 seconds/);assert.match(event.message,/whisper_tiny/);
 assert.equal(event.processing.stage,'final');assert.equal(event.pendingAudio.oldestAgeMs,8100);assert.equal(h.engines.length,1);assert.equal(h.client.state,'error');await h.client.dispose();
});
test('all failed loads report the last concrete cause instead of only resource policy',async()=>{
 const h=harness({loadHook:async engine=>{throw Error('missing weights for '+engine.model);}});
 await assert.rejects(h.client.start({input:'pcm'}),/missing weights for whisper_tiny/);assert.equal(h.engines.length,2);await h.client.dispose();
});
test('failure while replaying the fallback reports the replay cause',async()=>{
 const h=harness();await h.client.start({input:'pcm'});const next=h.client.nextBackend.bind(h.client);
 h.client.nextBackend=async(...args)=>{await next(...args);h.engines.at(-1).audio=async()=>{throw Object.assign(Error('replay decode failed'),{code:'wasm-failure'});};};
 h.engines[0].failAudio=true;await h.client.write(new Float32Array(1600),16000);
 const event=h.events.find(x=>x.type==='error');assert.equal(event.code,'wasm-failure');assert.match(event.message,/replay decode failed/);assert.equal(h.engines.length,2);await h.client.dispose();
});


test('optional upstream queue hint survives SDK packetization and rejects invalid counts before buffering',async()=>{
 const h=harness();await h.client.start({input:'pcm'});
 for(const hints of [null,1,[],{pendingPackets:-1},{pendingPackets:151},{pendingPackets:1.5},{pendingPackets:NaN},{pendingPackets:Infinity},{pendingPackets:'5'}]){
  await assert.rejects(h.client.write(new Float32Array(1600),16000,hints),/hints|pendingPackets/);
 }
 assert.equal(h.client.diagnostics().bufferedMs,0);assert.equal(h.engines[0].packets.length,0);
 await h.client.write(new Float32Array(3200),16000,{pendingPackets:15});
 assert.deepEqual(h.engines[0].packets.map(p=>p.hints.pendingPackets),[15,15]);
 await h.client.write(new Float32Array(1600),16000);assert.equal(h.engines[0].packets.at(-1).hints.pendingPackets,0);
 await h.client.dispose();
});

test('fallback replay advertises its buffered backlog rather than one in-flight packet',async()=>{
 const h=harness();await h.client.start({input:'pcm'});
 for(let i=0;i<12;i++)await h.client.write(new Float32Array(1600),16000);
 h.engines[0].failAudio=true;await h.client.write(new Float32Array(1600),16000);
 assert.deepEqual(h.engines[1].packets.map(p=>p.hints.pendingPackets),Array.from({length:13},(_,i)=>13-i));
 await h.client.dispose();
});


test('actual bridge timeout interrupts SDK fallback preparation and stops without awaiting its blocked write',async()=>{
 let expire,loads=0;
 const h=harness({loadHook:engine=>{
  if(++loads!==2)return;
  return new Promise((_,reject)=>{const close=engine.close.bind(engine);engine.close=()=>{close();reject(Error('Fallback cancelled'));};});
 }});
 const messages=[];Object.assign(h.ctx,{atob,Uint8Array,DataView,
  setTimeout(fn,ms){assert.equal(ms,8000);expire=fn;return 1;},clearTimeout(){},
  webkit:{messageHandlers:{speech:{postMessage:message=>messages.push(message)}}},
 });
 vm.runInContext(fs.readFileSync(path.join(root,'apps/mac/Web/bridge.js'),'utf8'),h.ctx);
 const options={channels:['call'],language:'mixed',terms:[],cacheOnly:false};
 assert.equal(await h.ctx.CallBridge.prepare(options),true);
 h.engines[0].failAudio=true;
 const write=h.ctx.CallBridge.audio('call',Buffer.alloc(6400).toString('base64'),16000,1);
 await new Promise(r=>setImmediate(r));assert.equal(h.engines.length,2);
 const stopping=h.ctx.CallBridge.stop();await new Promise(r=>setImmediate(r));expire();
 await stopping;assert.equal(await write,false);assert.ok(h.engines.every(e=>e.closed));
 assert.equal(messages.filter(m=>m.type==='failure').length,1);
 assert.match(messages.find(m=>m.type==='failure').message,/tail.*cancelled/i);
 assert.equal(messages.filter(m=>m.type==='stopped').length,1);assert.equal(messages.some(m=>m.type==='ack'),false);
 assert.equal(await h.ctx.CallBridge.prepare(options),true);await h.ctx.CallBridge.stop();
});
test('word confidence preserves unknowns and does not invent language probabilities',()=>{
 const h=harness();const assess=h.ctx.LocalSpeech.assessWords;
 assert.equal(typeof assess,'function');
 const a=assess('Привет Docker',[{word:'Привет',probability:.91},{word:'Docker',probability:.42}]);
 assert.equal(a[0].probability,.91);assert.equal(a[1].probability,.42);assert.equal(a[1].languageProbability,null);
 assert.equal(assess('Привет Docker',[{word:'другое',probability:.99}])[0].probability,null);
 assert.equal(assess('Привет',[{word:'Привет',probability:NaN}])[0].probability,null);
});
