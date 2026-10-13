const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function worker({online=false}={}){
 const events=[],decodes=[];let now=0,cost=500,packet=0;
 class Recognizer{constructor(){this.handle=1;}createStream(){return {seconds:0,acceptWaveform(rate,samples){this.seconds+=samples.length/rate;},inputFinished(){},free(){}};}isReady(){return false;}decode(stream){decodes.push({seconds:stream.seconds,packet});now+=cost;}getResult(){return {text:'fixture text'};}}
 const ctx={importScripts(){},SPEECH_MODELS:{whisper:{online,preview:!online,rate:16000,whisper:'base'}},OfflineRecognizer:Recognizer,OnlineRecognizer:Recognizer,performance:{now:()=>now},Float32Array,self:{postMessage:d=>events.push(d)},SherpaOnnx:async()=>({FS:{writeFile(){},unlink(){}},HEAPU8:new Uint8Array(1)})};vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../worker.js'),'utf8'),ctx);
 const send=data=>ctx.self.onmessage({data});await send({action:'load',model:'whisper',language:'auto',files:[]});
 return {events,decodes,setCost:value=>{cost=value;},begin:(options={})=>send({action:'begin',sessionId:'s',...options}),end:()=>send({action:'end',sessionId:'s',sampleRate:16000}),async feed(seconds,depth=1){for(let i=0;i<seconds*4;i++){packet++;await send({action:'audio',sessionId:'s',id:packet,sampleRate:16000,queueDepth:typeof depth==='function'?depth(i):depth,samples:new Float32Array(4000).fill(.1).buffer});}}};
}
test('configured offline windows finalize continuous speech without losing the tail or repeating finals',async()=>{
 const w=await worker();await w.begin({maxSegmentSeconds:6});await w.feed(13,6);await w.end();
 assert.deepEqual(w.decodes.map(d=>d.seconds),[6,6,1]);
 assert.deepEqual(w.events.filter(e=>e.type==='final').map(e=>[e.segmentId,e.startMs,e.endMs,e.reason]),[[1,0,6000,'window-limit'],[2,6000,12000,'window-limit'],[3,12000,13000,'stop']]);
});
test('begin resets custom window to the default for the next offline session',async()=>{
 const w=await worker();await w.begin({maxSegmentSeconds:3});await w.feed(3);await w.end();w.decodes.length=0;
 await w.begin();await w.feed(6,6);assert.equal(w.decodes.length,0);await w.feed(6,6);assert.equal(w.decodes[0].seconds,12);
});
test('offline window configuration does not alter online segmentation or partials',async()=>{
 const w=await worker({online:true});await w.begin({maxSegmentSeconds:3});await w.feed(6);
 assert.equal(w.events.filter(e=>e.type==='final').length,0);assert.ok(w.events.some(e=>e.type==='partial'));
 await w.feed(6);const finals=w.events.filter(e=>e.type==='final');assert.equal(finals.length,1);assert.equal(finals[0].endMs,12000);
});
test('worker rejects invalid window settings before beginning a session',async()=>{
 for(const value of [2.99,20.01,NaN,Infinity,'6',null]){const w=await worker();await w.begin({maxSegmentSeconds:value});assert.ok(w.events.some(e=>e.type==='error'&&/maxSegmentSeconds/.test(e.message)));assert.equal(w.events.some(e=>e.type==='begun'),false);}
});
test('unknown decoder speed permits finals but no speculative base preview',async()=>{
 const w=await worker();await w.begin();await w.feed(8.25);assert.equal(w.decodes.length,0);await w.end();assert.equal(w.decodes.length,1);assert.equal(w.decodes[0].seconds,8.25);
});
test('window final takes priority over an otherwise eligible preview on the same packet',async()=>{
 const w=await worker();w.setCost(250);await w.begin();await w.feed(4);await w.end();w.decodes.length=0;w.events.length=0;
 await w.begin();await w.feed(12,i=>i===47?1:6);
 assert.equal(w.decodes.length,1);assert.equal(w.decodes[0].seconds,12);assert.equal(w.events.filter(e=>e.type==='final').length,1);
 assert.equal(w.events.filter(e=>e.type==='processing'&&e.state==='start'&&e.stage==='preview').length,0);
});
test('preview needs measured cost within one second and runs at most once per segment',async()=>{
 const w=await worker();w.setCost(1500);await w.begin();await w.feed(4);await w.end();w.decodes.length=0;
 await w.begin();await w.feed(8.5);assert.equal(w.decodes.length,0);w.setCost(500);await w.end();w.decodes.length=0;w.events.length=0;
 await w.begin();await w.feed(8.5);assert.equal(w.decodes.length,1);await w.end();assert.equal(w.decodes.length,2);assert.equal(w.decodes.at(-1).seconds,8.5);
 const start=w.events.find(e=>e.type==='processing'&&e.state==='start'&&e.stage==='preview');assert.ok(Number.isInteger(start.packetId));
 const startAt=w.events.indexOf(start),ackAt=w.events.findIndex(e=>e.type==='ack'&&e.id===start.packetId);assert.ok(ackAt>startAt);assert.ok(w.events.slice(startAt,ackAt).some(e=>e.type==='processing'&&e.state==='end'));
});
test('a preview exceeding its measured budget disables further previews without dropping PCM',async()=>{
 const w=await worker();await w.begin();await w.feed(4);await w.end();w.events.length=0;
 w.setCost(1200);await w.begin();await w.feed(4);assert.ok(w.events.some(e=>e.type==='preview-policy'&&e.enabled===false&&e.reason==='decode-budget-exceeded'));
 w.setCost(500);await w.end();w.decodes.length=0;await w.begin();await w.feed(8.5);assert.equal(w.decodes.length,0);await w.end();assert.equal(w.decodes[0].seconds,8.5);
});
