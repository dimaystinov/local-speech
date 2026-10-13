'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../sdk/speaker-diarization.js');
const interval=(startMs,endMs,speakers,confidence=.95)=>({startMs,endMs,speakers,confidence});
const audio=seconds=>new Float32Array(seconds*8000).fill(.15);
function fixture(intervals,durationMs=8000){const embedded=[];return {embedded,engine:{segment:async()=>({durationMs,intervals,processingMs:20}),embed:async a=>{embedded.push(a);return new Float32Array([a[0]<.2?1:2]);}},matcher:{classify:v=>({kind:'known',label:'Person '+v[0],speakerId:'p'+v[0]})}};}
test('segmentation separates speakers and excludes overlap from embeddings',async()=>{
 const f=fixture([interval(0,3000,[0]),interval(3000,4000,[0,1]),interval(4000,8000,[1])]);f.matcher.classify=v=>({kind:'known',label:'Person '+f.embedded.length,speakerId:'p'+f.embedded.length});
 const result=await D.analyze(audio(8),8000,f);
 assert.equal(result.kind,'overlap');assert.equal(result.canEnroll,false);assert.equal(f.embedded.length,2);
 assert.equal(f.embedded[0].length,23040);assert.equal(f.embedded[1].length,31040);
 assert.equal(result.intervals[0].label,'Person 1');assert.equal(result.intervals[2].label,'Person 2');
});
test('brief interruption stays unknown instead of borrowing adjacent identity',async()=>{
 const f=fixture([interval(0,3000,[0]),interval(3000,3500,[1]),interval(3500,8000,[0])]);
 const result=await D.analyze(audio(8),8000,f);
 assert.equal(f.embedded.length,2);assert.equal(result.intervals[1].kind,'uncertain');assert.equal(result.intervals[1].speakerId,null);assert.equal(result.kind,'uncertain');
});
test('silence noise confidence and clipped input never get an enrolled name',async()=>{
 for(const [samples,segments] of [[new Float32Array(64000),[interval(0,8000,[])]],[audio(8),[interval(0,8000,[0],.4)]],[new Float32Array(64000).fill(1),[interval(0,8000,[0])]]]){
  const f=fixture(segments);const result=await D.analyze(samples,8000,f);assert.equal(f.embedded.length,0);assert.equal(result.kind,'uncertain');assert.equal(result.speakerId,undefined===result.speakerId?undefined:null);
 }
});
test('one clean speaker uses pooled speech once and allows enrollment',async()=>{
 const f=fixture([interval(0,3000,[0]),interval(3000,4000,[]),interval(4000,8000,[0])]);const result=await D.analyze(audio(8),8000,f);
 assert.equal(f.embedded.length,2);assert.equal(result.kind,'known');assert.equal(result.canEnroll,true);assert.ok(f.embedded[0].length<8000*7);
});
test('all-overlap and mixed enrollment are rejected',()=>{
 for(const intervals of [[interval(0,8000,[0,1])],[interval(0,4000,[0]),interval(4000,8000,[1])]])assert.throws(()=>D.enrollmentAudio(audio(8),8000,{durationMs:8000,intervals}));
});
test('malformed intervals cannot corrupt transcript timing',()=>{
 for(const intervals of [[interval(-1,8000,[0])],[interval(0,9000,[0])],[interval(0,4000,[0]),interval(3000,8000,[1])],[interval(0,8000,[3])],[interval(0,8000,[0,0])],[interval(0,8000,[0],NaN)]])assert.throws(()=>D.validateIntervals({durationMs:8000,intervals},8000));
});
test('cancellation between segmentation and embedding does not classify',async()=>{
 let cancelled=false;const f=fixture([interval(0,8000,[0])]);f.engine.segment=async()=>{cancelled=true;return {durationMs:8000,intervals:[interval(0,8000,[0])]};};
 await assert.rejects(D.analyze(audio(8),8000,{...f,cancelled:()=>cancelled}),/cancelled/);assert.equal(f.embedded.length,0);
});

test('merged segmentation slot with inconsistent voices never receives a pooled name',async()=>{
 const f=fixture([interval(0,8000,[0])]);let calls=0;f.engine.embed=async()=>new Float32Array(++calls===1?[1,0]:[0,1]);
 const result=await D.analyze(audio(8),8000,f);assert.equal(calls,2);assert.equal(result.kind,'uncertain');assert.equal(result.speakerId,null);
});
test('short uncertain onset does not prevent enrollment of long clean speech',()=>{
 const result={durationMs:8000,intervals:[interval(0,500,[1],.5),interval(500,8000,[0])]};
 assert.ok(D.enrollmentAudio(audio(8),8000,result).length>8000*7);
});
test('overlap threshold does not admit uncertain single-speaker frames into embeddings',async()=>{
 const f=fixture([interval(0,4000,[0],.55),interval(4000,8000,[0,1],.55)]);
 const result=await D.analyze(audio(8),8000,f);assert.equal(f.embedded.length,0);
 assert.equal(result.intervals[0].kind,'uncertain');assert.equal(result.intervals[1].kind,'overlap');assert.equal(result.canEnroll,false);
});
test('a late turn in a 15-second slot is included in temporal consistency evidence',async()=>{
 const samples=audio(15);samples.fill(.4,12*8000);
 const f=fixture([interval(0,15000,[0])],15000);let calls=0;
 f.engine.embed=async a=>{calls++;return new Float32Array(a.some(x=>x>.3)?[0,1]:[1,0]);};
 const result=await D.analyze(samples,8000,f);assert.equal(calls,2);assert.equal(result.kind,'uncertain');assert.equal(result.canEnroll,false);
});
