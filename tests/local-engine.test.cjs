const {test}=require('node:test');const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
function engine(onError=()=>{},timerOverrides={}){
 const context={SPEECH_MODELS:{small:{files:[],label:"Small"}},AbortController,setTimeout,clearTimeout,setInterval,clearInterval,...timerOverrides};vm.createContext(context);
 vm.runInContext(fs.readFileSync(require.resolve('../local-engine.js'),'utf8')+';globalThis.Engine=LocalEngine;',context);
 const e=new context.Engine('small',()=>{},onError);e.worker={postMessage(){},terminate(){this.terminated=true;}};e.begin({sessionId:"s"});return e;
}
test('audio watchdog preserves cause for pending packets and subsequent calls',async()=>{
 const e=engine(),failure=Error('Движок не подтверждает обработку аудио 8 секунд');
 const first=e.audio(new Float32Array(1600),16000,'s'),second=e.audio(new Float32Array(1600),16000,'s');
 e.error(failure);
 await assert.rejects(first,x=>x===failure);await assert.rejects(second,x=>x===failure);
 await assert.rejects(e.audio(new Float32Array(1),16000,'s'),x=>x===failure);
 await assert.rejects(e.end('s',16000),x=>x===failure);assert.throws(()=>e.begin({sessionId:'s'}),x=>x===failure);
 assert.equal(e.pending.size,0);assert.equal(e.worker.terminated,true);
});
test('throwing error observer cannot leave failed worker running',async()=>{
 const e=engine(()=>{throw Error('observer');}),pending=e.audio(new Float32Array(1),16000,'s');
 assert.throws(()=>e.error(Error('original')),/observer/);await assert.rejects(pending,/original/);
 assert.equal(e.closed,true);assert.equal(e.worker.terminated,true);
});
test('end timeout terminates old worker and prevents late results from entering another session',async()=>{
 let expire;const e=engine(()=>{},{setTimeout:fn=>{expire=fn;return 1;},clearTimeout(){}});
 const pending=e.end('s',16000);expire();await assert.rejects(pending,/15 секунд/);
 assert.equal(e.closed,true);assert.equal(e.worker.terminated,true);
 assert.throws(()=>e.begin({sessionId:'new'}),/15 секунд/);
});
test('decode stage diagnoses an ACK timeout without extending the fixed deadline',async()=>{
 let now=0,watchdog,worker;
 class Worker{constructor(){worker=this;}postMessage(message){if(message.action==='load')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}terminate(){this.terminated=true;}}
 const ctx={AbortController,Date:{now:()=>now},setTimeout:()=>1,clearTimeout(){},setInterval:fn=>{watchdog=fn;return 1;},clearInterval(){},queueMicrotask,Worker,SPEECH_MODELS:{whisper:{files:[],label:'Whisper'}},fetch:async()=>({ok:true,json:async()=>[]}),caches:{open:async()=>({})}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../local-engine.js'),'utf8')+';globalThis.Engine=LocalEngine;',ctx);
 const e=new ctx.Engine('whisper',()=>{},()=>{});await e.load(()=>{},{vadMode:'energy'});e.begin({sessionId:'s'});
 const pending=e.audio(new Float32Array(1600),16000,'s');
 now=7000;worker.onmessage({data:{type:'processing',state:'start',stage:'preview',action:'audio',sessionId:'s',packetId:1,audioMs:4000}});
 now=8100;watchdog();
 await assert.rejects(pending,error=>{assert.match(error.message,/8 секунд/);assert.match(error.message,/preview/);assert.equal(error.processing.packetId,1);assert.equal(error.pendingAudio.oldestAgeMs,8100);return true;});assert.equal(e.closed,true);assert.equal(worker.terminated,true);
});

function fixture({postError,fetchError,options,modelFile=false}={}){
 const events=[],requests=[],workers=[];
 class Worker{constructor(url){this.url=url;this.messages=[];workers.push(this);}postMessage(m){if(postError===m.action)throw Error('clone failed');this.messages.push(m);if(m.action==='load')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}terminate(){this.terminated=true;}}
 const digest='a'.repeat(64),cacheKeys=[];
 const ctx={URL,Float32Array,ArrayBuffer,Response,crypto:{subtle:{digest:async()=>new Uint8Array(32).fill(170).buffer}},AbortController,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,Worker,SPEECH_MODELS:{small:{files:modelFile?['test.onnx']:[],label:'Small'}},fetch:async url=>{requests.push(url);if(fetchError)throw Error('network failed');return{ok:true,json:async()=>modelFile?[{model:'small',file:'test.onnx',sha256:digest,bytes:4}]:[],arrayBuffer:async()=>new ArrayBuffer(4)};},caches:{open:async()=>({put:async key=>cacheKeys.push(key)})}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../local-engine.js'),'utf8')+';globalThis.Engine=LocalEngine;',ctx);
 const e=new ctx.Engine('small',event=>events.push(event),()=>{},options);
 return{e,events,requests,workers,cacheKeys,Engine:ctx.Engine,load:()=>e.load(()=>{},{vadMode:'energy'})};
}
test('unknown model fails before starting a download',()=>{const f=fixture();assert.throws(()=>new f.Engine('missing',()=>{},()=>{}),/модель/i);assert.equal(f.requests.length,0);});
test('explicit asset base resolves manifest and worker; defaults remain relative',async()=>{
 for(const [options,manifest,worker] of [[undefined,'evidence/model-manifest.json','worker.js'],[{assetBaseURL:'https://example.test/speech/'},'https://example.test/speech/evidence/model-manifest.json','https://example.test/speech/worker.js']]){
  const f=fixture({options});try{await f.load();assert.equal(f.requests[0],manifest);assert.equal(f.workers[0].url,worker);}finally{f.e.close();}
 }
});
test('stale session events cannot settle current end or update metrics',async()=>{
 const f=fixture();await f.load();const e=f.e,w=f.workers[0];e.begin({sessionId:'new'});
 const pending=e.audio(new Float32Array(1),16000,'new');
 w.onmessage({data:{type:'ack',id:1,sessionId:'old'}});assert.equal(e.pending.size,1);
 for(const type of ['final','partial','preview-policy','ended'])w.onmessage({data:{type,sessionId:'old'}});
 for(const type of ['final','partial','ack','ended'])w.onmessage({data:{type,id:1}});
 assert.equal(f.events.length,0);assert.equal(e.metrics.previewPolicy,undefined);
 w.onmessage({data:{type:'ack',id:1,sessionId:'new'}});await pending;
 const end=e.end('new',16000);assert.equal(e.end('new',16000),end);let settled=false;end.then(()=>settled=true);
 w.onmessage({data:{type:'ended',sessionId:'old'}});await Promise.resolve();assert.equal(settled,false);
 w.onmessage({data:{type:'ended',sessionId:'new'}});await end;assert.equal(e.resolveEnd,null);assert.equal(e.rejectEnd,null);
 const eventCount=f.events.length;w.onmessage({data:{type:'final',sessionId:'new',text:'late'}});assert.equal(f.events.length,eventCount);
 await e.end('new',16000);assert.equal(w.messages.filter(x=>x.action==='end').length,1);e.close();
});
test('rejects session overlap and malformed PCM without posting or queuing',async()=>{
 const f=fixture();await f.load();const e=f.e;e.begin({sessionId:'s'});assert.throws(()=>e.begin({sessionId:'other'}),/сеанс/i);
 const count=f.workers[0].messages.length;
 for(const samples of [new Float32Array(0),new Float32Array([NaN]),new Float32Array([Infinity]),new Uint8Array(1)])await assert.rejects(e.audio(samples,16000,'s'),/PCM/);
 await assert.rejects(e.audio(new Float32Array(1),NaN,'s'),/частот/i);
 await assert.rejects(e.audio(new Float32Array(1),16000,'other'),/сеанс/i);
 assert.equal(e.pending.size,0);assert.equal(f.workers[0].messages.length,count);e.close();
});
test('subarray transfers only requested samples',async()=>{
 const f=fixture();await f.load();f.e.begin({sessionId:'s'});const input=new Float32Array([1,2,3,4]),job=f.e.audio(input.subarray(1,3),16000,'s');
 const w=f.workers[0],m=w.messages.at(-1);assert.deepEqual([...new Float32Array(m.samples)],[2,3]);w.onmessage({data:{type:'ack',id:m.id,sessionId:'s'}});await job;f.e.close();
});
test('synchronous worker post failures close and settle all pending operations',async()=>{
 for(const action of ['load','audio','end','transcribe']){
  const f=fixture({postError:action});if(action==='load')await assert.rejects(f.load(),/clone failed/);
  else {await f.load();if(action!=='transcribe')f.e.begin({sessionId:'s'});const job=action==='audio'?f.e.audio(new Float32Array(1),16000,'s'):action==='end'?f.e.end('s',16000):f.e.transcribe(new Float32Array(1),16000,'id');await assert.rejects(job,/clone failed/);}
  assert.equal(f.e.closed,true);assert.equal(f.workers[0].terminated,true);assert.equal(f.e.pending.size,0);assert.equal(f.e.transcription,null);assert.equal(f.e.resolveLoad,null);assert.equal(f.e.resolveEnd,null);
 }
});
test('failed fetch closes load and forbids retries on the same instance',async()=>{
 const f=fixture({fetchError:true});await assert.rejects(f.load(),/network failed/);assert.equal(f.e.closed,true);await assert.rejects(f.load(),/network failed|закрыт/);assert.equal(f.requests.length,1);
});

test('explicit asset base is used for model download and verified cache key',async()=>{
 const f=fixture({modelFile:true,options:{assetBaseURL:'https://example.test/speech/'}});await f.load();
 assert.deepEqual(f.requests,['https://example.test/speech/evidence/model-manifest.json','https://example.test/speech/models/small/test.onnx']);
 assert.ok(f.cacheKeys.includes('https://example.test/speech/models/small/test.onnx?sha256='+'a'.repeat(64)));f.e.close();
});
test('load cannot be repeated or overlapped',async()=>{
 const f=fixture(),job=f.load();await assert.rejects(f.load(),/уже/);await job;await assert.rejects(f.load(),/уже/);assert.equal(f.workers.length,1);f.e.close();
});
test('cancelling immediately after ready cannot start a leaked watchdog',async()=>{
 const f=fixture(),job=f.load();
 while(!f.workers.length)await Promise.resolve();
 f.workers[0].onmessage({data:{type:'ready'}});f.e.close();
 await assert.rejects(job,/закрыт/);assert.equal(f.e.watchdog,undefined);
});
test('end blocks further audio; completed engine supports another session',async()=>{
 const f=fixture();await f.load();const e=f.e,w=f.workers[0];await assert.rejects(e.end(undefined,16000),/сеанс/);e.begin({sessionId:'first'});const job=e.end('first',16000);
 await assert.rejects(e.audio(new Float32Array(1),16000,'first'),/сеанс/);w.onmessage({data:{type:'ended',sessionId:'first'}});await job;
 e.begin({sessionId:'second'});const second=e.end('second',16000);w.onmessage({data:{type:'ended',sessionId:'second'}});await second;e.close();
});

test('standalone first load persists URL-scoped metadata for a zero-fetch cache-only reload',async()=>{
 const stored=new Map(),network=[],base='https://example.test/embed/',manifestURL=base+'evidence/model-manifest.json';
 const manifest=[{model:'small',file:'test.onnx',bytes:4,sha256:'a'.repeat(64)}];let currentManifest=manifest,legacyCalls=0;
 class Worker{postMessage(m){if(m.action==='load')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}terminate(){}}
 const ctx={URL,Response,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,Worker,
 crypto:{subtle:{digest:async()=>new Uint8Array(32).fill(170).buffer}},
 SPEECH_MODELS:{small:{files:['test.onnx'],label:'Small'}},fetch:async url=>{network.push(url);return new Response(url===manifestURL?JSON.stringify(currentManifest):new ArrayBuffer(4));},
 caches:{open:async()=>({match:async key=>stored.get(key)?.clone(),put:async(key,response)=>stored.set(key,response.clone())}),match:async()=>{legacyCalls++;throw Error('No service worker cache');}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../local-engine.js'),'utf8')+';globalThis.Engine=LocalEngine;',ctx);
 const make=()=>new ctx.Engine('small',()=>{},()=>{},{assetBaseURL:base});
 const first=make();await first.load(()=>{},{vadMode:'energy'});first.close();assert.ok(stored.has(manifestURL));assert.equal(network.length,2);
 const next=make();const result=await next.load(()=>{},{vadMode:'energy',cacheOnly:true});next.close();assert.equal(network.length,2);assert.equal(legacyCalls,0);assert.equal(result.cacheHits,1);assert.equal(result.downloadedBytes,0);
 for(const bad of [null,{},[{...manifest[0],bytes:0}],[{...manifest[0],sha256:'x'}],[{...manifest[0],file:'../test.onnx'}],[{...manifest[0],model:'../small'}],[manifest[0],manifest[0]]]){
  currentManifest=bad;const invalid=make();await assert.rejects(invalid.load(()=>{},{vadMode:'energy'}),/manifest|манифест/i);assert.equal(invalid.closed,true);assert.deepEqual(await stored.get(manifestURL).clone().json(),manifest);
 }
 stored.delete(manifestURL);ctx.caches.match=async key=>{legacyCalls++;assert.equal(key,manifestURL);return new Response(JSON.stringify(manifest));};
 const beforeLegacy=network.length,legacy=make();await legacy.load(()=>{},{vadMode:'energy',cacheOnly:true});legacy.close();assert.equal(legacyCalls,1);assert.equal(network.length,beforeLegacy);
});


test('worker depth includes validated upstream backlog without lowering local pending depth or bypassing bounds',async()=>{
 const f=fixture();await f.load();const e=f.e,w=f.workers[0];e.begin({sessionId:'s'});
 for(const hints of [null,1,[],{pendingPackets:-1},{pendingPackets:151},{pendingPackets:1.5},{pendingPackets:NaN},{pendingPackets:Infinity},{pendingPackets:'5'}]){
  await assert.rejects(e.audio(new Float32Array(1600),16000,'s',hints),/hints|pendingPackets/);
 }
 assert.equal(e.pending.size,0);
 const a=e.audio(new Float32Array(1600),16000,'s',{pendingPackets:12});assert.equal(w.messages.at(-1).queueDepth,12);
 const b=e.audio(new Float32Array(1600),16000,'s',{pendingPackets:0});assert.equal(w.messages.at(-1).queueDepth,2);
 for(const message of w.messages.filter(m=>m.action==='audio'))w.onmessage({data:{type:'ack',id:message.id,sessionId:'s'}});
 await Promise.all([a,b]);e.close();
});
