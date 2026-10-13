'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const profiles=require('../sdk/speaker-profiles.js');
const source=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const axis=(i=0)=>{const result=new Float32Array(256);result[i]=1;return result;};
const profile=(id='person-a',name='Алексей',embedding=axis())=>({id,name,modelId:profiles.MODEL_ID,embedding:Array.from(embedding)});
const pcm=(seconds=1,value=.2,rate=8000)=>new Float32Array(seconds*rate).fill(value);
const encode=samples=>Buffer.from(samples.buffer,samples.byteOffset,samples.byteLength).toString('base64');
const event=(id=1,startMs=0,endMs=3000)=>({type:'final',sessionId:'session-a',segmentId:id,startMs,endMs,rawText:'Проверим Docker и Kubernetes',text:'Проверим Docker и Kubernetes'});
const options=extra=>({language:'mixed',terms:[],cacheOnly:true,channels:['call'],speakerEnabled:true,voiceProfiles:[],...extra});
function fixture(hooks={}){
 const messages=[],embeddings=[],clients=[],engines=[];
 const context={URL,atob,Float32Array,Uint8Array,DataView,setTimeout,clearTimeout,location:{href:'http://127.0.0.1:8766/bridge.html'},
  webkit:{messageHandlers:{speech:{postMessage:m=>messages.push(m)}}},
  LocalSpeechVoiceProfiles:profiles,
  LocalSpeechSpeakers:{modelId:profiles.MODEL_ID,create(){
   const engine={closed:false,async prepare(){await hooks.prepare?.();},async embed(samples,rate){embeddings.push({samples,rate});return await hooks.embed?.(samples,rate,embeddings.length)??axis();},async dispose(){this.closed=true;await hooks.dispose?.();}};
   engines.push(engine);return engine;
  }},
  LocalSpeech:{create(){const c={writes:0,on(_,callback){this.callback=callback;return ()=>{};},async prepare(){},async start(){},async write(samples,rate){this.writes++;await hooks.write?.(this,samples,rate);},async stop(){await hooks.stop?.(this);},async dispose(){}};clients.push(c);return c;}}
 };
 vm.createContext(context);vm.runInContext(source('apps/mac/Web/speakers.js'),context);vm.runInContext(source('apps/mac/Web/bridge.js'),context);
 return {speakers:context.CallSpeakers,bridge:context.CallBridge,messages,embeddings,engines,clients};
}
function feed(f,s,seconds=3,value=.2,channel='call'){
 for(let i=0;i<seconds;i++)f.speakers.feed(s,channel,pcm(1,value),8000);
}
const annotations=f=>f.messages.filter(m=>m.type==='speaker');

test('optional feature disabled creates no model and retains no PCM',async()=>{
 const f=fixture(),s=f.speakers.start();feed(f,s);f.speakers.final(s,'call',event());await f.speakers.finish(s);
 assert.equal(f.engines.length,0);assert.equal(s.samples.size,0);assert.equal(annotations(f).length,0);
});
test('speaker preparation and inference never block ASR ACK or overwrite raw transcription',async()=>{
 const preparation=gate(),inference=gate(),f=fixture({prepare:()=>preparation.promise,embed:()=>inference.promise});
 assert.equal(await f.bridge.prepare(options({voiceProfiles:[profile()]})),true);
 for(let i=0;i<3;i++)assert.equal(await f.bridge.audio('call',encode(pcm()),8000,i),true);
 const original=event();const before=JSON.stringify(original);f.clients[0].callback(original);await tick();
 assert.equal(await f.bridge.audio('call',encode(pcm()),8000,3),true);assert.equal(f.messages.filter(m=>m.type==='ack').length,4);
 assert.equal(JSON.stringify(original),before);assert.equal(f.messages.find(m=>m.type==='event').event,original);
 assert.equal(annotations(f).at(-1).kind,'pending');preparation.resolve();inference.resolve(axis());await f.bridge.stop();
 const result=annotations(f).at(-1);assert.equal(result.label,'Алексей');assert.equal(result.kind,'known');assert.equal(result.sessionId,'session-a');assert.equal(result.segmentId,1);
 assert.equal('rawText' in result,false);assert.equal('text' in result,false);
});
test('sample windows follow event times independently for microphone and call',async()=>{
 const f=fixture(),s=f.speakers.start({enabled:true});feed(f,s,2,.25);feed(f,s,3,.5);feed(f,s,3,-.5,'microphone');
 f.speakers.final(s,'call',event(1,2000,5000));f.speakers.final(s,'microphone',event(2));await f.speakers.finish(s);
 assert.equal(f.embeddings.length,2);assert.equal(f.embeddings[0].samples.length,24000);assert.equal(f.embeddings[0].samples[0],.5);assert.equal(f.embeddings[1].samples[0],-.5);
});
test('short or expired windows are uncertain without guessing an enrolled name',async()=>{
 const f=fixture(),s=f.speakers.start({enabled:true,profiles:[profile()]});feed(f,s,41);
 f.speakers.final(s,'call',event(1,0,3000));f.speakers.final(s,'call',event(2,40000,41000));await f.speakers.finish(s);
 assert.equal(f.embeddings.length,0);assert.ok(annotations(f).every(a=>a.kind==='uncertain'&&!a.speakerId&&!a.canEnroll));
});
test('different known speakers in a segment are mixed without assigning a single name',async()=>{
 const f=fixture({embed:(_,__,i)=>axis(i-1)}),s=f.speakers.start({enabled:true,profiles:[profile(),profile('person-b','Мария',axis(1))]});feed(f,s,8);
 f.speakers.final(s,'call',event(1,0,8000));await f.speakers.finish(s);const result=annotations(f).at(-1);
 assert.equal(result.kind,'mixed');assert.equal(result.label,'Несколько голосов');assert.equal(result.speakerId,undefined);assert.equal(result.intervals.length,2);
 assert.equal(result.intervals[0].label,'Алексей');assert.equal(result.intervals[1].label,'Мария');
});
test('ambiguous saved profiles stay uncertain and unknown voice stays anonymous',async()=>{
 const f=fixture(),s=f.speakers.start({enabled:true,profiles:[profile(),profile('person-b','Мария')]});feed(f,s);
 f.speakers.final(s,'call',event());await f.speakers.finish(s);assert.equal(annotations(f).at(-1).kind,'uncertain');assert.equal(annotations(f).at(-1).speakerId,undefined);
 const unknown=fixture({embed:()=>axis(2)}),u=unknown.speakers.start({enabled:true,profiles:[profile()]});feed(unknown,u);unknown.speakers.final(u,'call',event());await unknown.speakers.finish(u);
 assert.equal(annotations(unknown).at(-1).kind,'anonymous');assert.equal(annotations(unknown).at(-1).label,'Голос 1');
});
test('analysis queue and cached enrollment samples stay bounded under overload',async()=>{
 const pending=gate(),f=fixture({embed:()=>pending.promise}),s=f.speakers.start({enabled:true});feed(f,s,3);
 for(let i=0;i<12;i++)f.speakers.final(s,'call',event(i));await tick();
 assert.equal(s.pending,4);assert.equal(f.embeddings.length,1);assert.equal(s.samples.size,8);
 assert.equal(annotations(f).filter(a=>a.kind==='uncertain').length,8);
 pending.resolve(axis());await f.speakers.finish(s);assert.equal(s.pending,0);assert.equal(f.embeddings.length,4);
});
test('enrollment from a clean file emits validated embedding but never raw audio',async()=>{
 const f=fixture();await f.speakers.enroll({name:'Алексей',id:'person-a',encoded:encode(pcm(4)),rate:8000});
 const message=f.messages.find(m=>m.type==='voice-profile');assert.ok(message);assert.equal(message.requestId,'person-a');assert.equal(message.profile.name,'Алексей');assert.equal(message.profile.modelId,profiles.MODEL_ID);
 assert.equal(message.profile.embedding.length,256);assert.equal(f.embeddings.length,3);assert.deepEqual(f.embeddings.map(e=>e.samples.length),[16000,16000,32000]);
 assert.deepEqual(Object.keys(message.profile).sort(),['embedding','id','modelId','name']);
});
test('enrollment uses recent final sample only after stopped',async()=>{
 const f=fixture(),s=f.speakers.start({enabled:true});feed(f,s,3,.25);f.speakers.final(s,'call',event());
 await f.speakers.enroll({name:'Алексей',id:'person-a',segmentKey:'call:session-a:1'});assert.equal(f.messages.at(-1).type,'voice-error');
 await f.speakers.finish(s);assert.equal(s.rings.size,0);await f.speakers.enroll({name:'Алексей',id:'person-a',segmentKey:'call:session-a:1'});
 assert.equal(f.messages.at(-1).type,'voice-profile');assert.equal(f.embeddings.at(-1).samples[0],.25);
});
test('mixed enrollment, stale excerpts and invalid names never save profiles',async()=>{
 const f=fixture({embed:(_,__,i)=>axis(i-1)});await f.speakers.enroll({name:'Алексей',id:'person-a',encoded:encode(pcm(4)),rate:8000});
 assert.equal(f.messages.at(-1).type,'voice-error');assert.equal(f.messages.at(-1).requestId,'person-a');assert.equal(f.embeddings.length,2);
 await f.speakers.enroll({name:'Алексей',id:'person-a',segmentKey:'missing'});assert.equal(f.messages.at(-1).type,'voice-error');
 for(const name of ['', 'a\nadmin', 'a\u202e'])await f.speakers.enroll({name,id:'person-a',encoded:encode(pcm(4)),rate:8000});
 assert.equal(f.messages.filter(m=>m.type==='voice-profile').length,0);
});
test('malformed and too-short file PCM cannot enroll',async()=>{
 const f=fixture();for(const config of [{encoded:'!',rate:8000},{encoded:encode(pcm(2)),rate:8000},{encoded:encode(pcm(4)),rate:7999},{encoded:encode(pcm(16)),rate:8000}]){
  await f.speakers.enroll({name:'Алексей',id:'person-a',...config});assert.equal(f.messages.at(-1).type,'voice-error');
 }assert.equal(f.embeddings.length,0);
});
test('failed preparation or invalid PCM disables only speaker analysis',async()=>{
 const f=fixture({prepare:()=>Promise.reject(Error('No weights'))});assert.equal(await f.bridge.prepare(options()),true);await tick();
 assert.equal(await f.bridge.audio('call',encode(pcm()),8000,0),true);assert.ok(f.messages.some(m=>m.type==='speaker-status'));assert.equal(f.messages.some(m=>m.type==='failure'),false);await f.bridge.stop();
 const bad=fixture(),s=bad.speakers.start({enabled:true});bad.speakers.feed(s,'call',new Float32Array([NaN]),8000);assert.equal(s.enabled,false);await bad.speakers.finish(s);
});

test('inconsistent anonymous windows do not assert multiple people',async()=>{
 const f=fixture({embed:(_,__,i)=>axis(i-1)}),s=f.speakers.start({enabled:true});feed(f,s,8);
 f.speakers.final(s,'call',event(1,0,8000));await f.speakers.finish(s);
 const result=annotations(f).at(-1);assert.equal(result.kind,'uncertain');assert.equal(result.speakerId,undefined);
});
