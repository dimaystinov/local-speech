#!/usr/bin/env node
/** Actual offline acoustic benchmark, not mocked worker tests.
 * node tools/benchmark-diarization.mjs --fixtures=validation/diarization-fixtures
 *   --transformers-dir=node_modules/@huggingface/transformers
 * Use --enrollment=clean for the actual SDK enrollment path; --variants=true enables experimental extra guards.
 * Uses native onnxruntime-node CPU, ONE thread. It does not measure WK/ASR contention.
 * Sources, thresholds, waveform hashes and per-case evidence are included in output.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL, fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// Validate before loading runtime/model code, and invalidate cached inference on all
// model, feature-extractor, runtime-source and benchmark-preprocessing changes.
export function createInferenceFingerprint({manifest,runtimeMetadata,runtimeSource,readAsset,inferenceCodeDigest,nativeRuntimeMetadata}){
  if(nativeRuntimeMetadata?.name!=='onnxruntime-node'||typeof nativeRuntimeMetadata.version!=='string'||!nativeRuntimeMetadata.version)throw Error('Missing native runtime fingerprint');
  if(runtimeMetadata?.name!==manifest?.runtime?.package||runtimeMetadata?.version!==manifest?.runtime?.version)throw Error('Pinned speaker runtime version mismatch');
  if(!Array.isArray(manifest.files)||typeof readAsset!=='function')throw Error('Invalid speaker asset manifest');
  const expected=new Set(['models/speaker-wespeaker/config.json','models/speaker-wespeaker/preprocessor_config.json','models/speaker-wespeaker/onnx/model_quantized.onnx','models/segmentation-pyannote/config.json','models/segmentation-pyannote/preprocessor_config.json','models/segmentation-pyannote/onnx/model_quantized.onnx']);
  const files=manifest.files.filter(entry=>['model','segmentation'].includes(entry.source));
  if(files.length!==expected.size)throw Error('Incomplete pinned speaker assets');
  const verified=[];
  for(const entry of files){
    if(!expected.delete(entry.path)||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid pinned speaker asset');
    const bytes=readAsset(entry.path);
    if(bytes.length!==entry.bytes||sha256(bytes)!==entry.sha256)throw Error('Pinned speaker asset integrity mismatch: '+entry.path);
    verified.push({path:entry.path,bytes:entry.bytes,sha256:entry.sha256});
  }
  verified.sort((a,b)=>a.path.localeCompare(b.path));
  return 'native-cpu-one-thread-v2:'+sha256(JSON.stringify({files:verified,model:manifest.model,segmentation:manifest.segmentation,runtime:manifest.runtime,runtimeSource:sha256(runtimeSource),nativeRuntime:nativeRuntimeMetadata,architecture:process.arch,inferenceCodeDigest}));
}
export function applyExperimentalRms(source,value){
  value=Number(value);
  if(!Number.isFinite(value)||value<.0001||value>.003)throw Error('Invalid experimental RMS gate');
  const pattern=/(Math\.sqrt\(energy\/Math\.max\(1,audio\.length\)\)>=)(?:\d*\.\d+)(?=&&clipped)/g;
  if([...source.matchAll(pattern)].length!==1)throw Error('Helper RMS source changed');
  return source.replace(pattern,(_,prefix)=>prefix+value);
}
export function disposeTensors(...objects){
  const seen=new Set();
  for(const object of objects)for(const value of Object.values(object||{})){
    if(typeof value?.dispose==='function'&&!seen.has(value)){seen.add(value);value.dispose();}
  }
}
async function main(){
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => {const i=a.indexOf('='); if(!a.startsWith('--')||i<0)throw Error('Use --name=value'); return [a.slice(2,i),a.slice(i+1)];}));
const fixtures = path.resolve(args.fixtures || 'validation/diarization-fixtures');
const output = path.resolve(args.output || 'validation/diarization-benchmark.json');
const transformersDir = path.resolve(args['transformers-dir'] || 'node_modules/@huggingface/transformers');
const pinnedManifest=JSON.parse(fs.readFileSync(path.join(root,'sdk/speaker-assets-manifest.json'),'utf8'));
const runtimeMetadata=JSON.parse(fs.readFileSync(path.join(transformersDir,'package.json'),'utf8'));
const nativeRuntimeMetadata=JSON.parse(fs.readFileSync(createRequire(path.join(transformersDir,'package.json')).resolve('onnxruntime-node/package.json'),'utf8'));
const cacheKey=createInferenceFingerprint({nativeRuntimeMetadata,manifest:pinnedManifest,runtimeMetadata,runtimeSource:fs.readFileSync(path.join(transformersDir,'dist/transformers.node.mjs')),readAsset:relative=>fs.readFileSync(path.join(root,relative)),inferenceCodeDigest:sha256(fs.readFileSync(fileURLToPath(import.meta.url)))});
const {env,AutoFeatureExtractor,AutoModel,AutoModelForAudioFrameClassification,Tensor} = await import(pathToFileURL(path.join(transformersDir, 'dist/transformers.node.mjs')).href);
const profilesAPI = require(path.join(root, 'sdk/speaker-profiles.js'));
let helperSource=fs.readFileSync(path.join(root,'sdk/speaker-diarization.js'),'utf8');
if(args['rms-min'])helperSource=applyExperimentalRms(helperSource,args['rms-min']);
const sandbox={module:{exports:{}},Float32Array};vm.runInNewContext(helperSource,sandbox,{filename:'speaker-diarization-benchmark-policy.js'});
const diarizationAPI=sandbox.module.exports;
const helperHash=crypto.createHash('sha256').update(helperSource).digest('hex');
env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = path.join(root,'models') + path.sep;
const options = {dtype:'q8', device:'cpu', local_files_only:true, session_options:{intraOpNumThreads:1,interOpNumThreads:1}};
const start = performance.now();
const extractor = await AutoFeatureExtractor.from_pretrained('speaker-wespeaker',{local_files_only:true});
const model = await AutoModel.from_pretrained('speaker-wespeaker',options);
const segmenter = await AutoModelForAudioFrameClassification.from_pretrained('segmentation-pyannote',options);
const loadMs = performance.now()-start;
try {
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures,'manifest.json'),'utf8'));
const cachePath = path.join(fixtures, 'inference-cache.json');
const modelHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'models/speaker-wespeaker/onnx/model_quantized.onnx'))).digest('hex');
const segmentationHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'models/segmentation-pyannote/onnx/model_quantized.onnx'))).digest('hex');
const runtimeVersion = runtimeMetadata.version;
let cache = fs.existsSync(cachePath)?JSON.parse(fs.readFileSync(cachePath,'utf8')):{key:cacheKey, embeddings:{}, segmentation:{}};
if(cache.key!==cacheKey)cache={key:cacheKey,embeddings:{},segmentation:{}};
const durations=[], segmentDurations=[];
const hashAudio = audio => crypto.createHash('sha256').update(Buffer.from(audio.buffer,audio.byteOffset,audio.byteLength)).digest('hex');
const rms = audio => Math.sqrt(audio.reduce((a,b)=>a+b*b,0)/audio.length);
const read = row => {
  const file=path.resolve(fixtures,row.file);
  if(!file.startsWith(fixtures+path.sep))throw Error('Fixture must stay below fixture directory');
  const bytes=fs.readFileSync(file);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('Fixture hash mismatch: '+row.id);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
};
async function embed(audio){
  if(audio.length<16000||rms(audio)<.0001)return null;
  const hash=hashAudio(audio);
  if(cache.embeddings[hash])return cache.embeddings[hash].vector;
  if(args['cache-only']==='true')throw Error('Embedding missing in --cache-only mode');
  const t=performance.now();let inputs,result;
  try{
  inputs=await extractor(audio);result=await model(inputs);
  const tensor=Object.values(result).find(t=>t?.data?.length===256);
  if(!tensor)throw Error('Missing embedding');
  const vector=Array.from(profilesAPI.normalize(tensor.data)),ms=performance.now()-t;
  durations.push({ms,seconds:audio.length/16000});cache.embeddings[hash]={vector,ms,seconds:audio.length/16000};
  return vector;
  }finally{disposeTensors(inputs,result);}
}
const powerset=[[],[0],[1],[2],[0,1],[0,2],[1,2]];
async function segment(audio){
  const hash=hashAudio(audio); if(cache.segmentation[hash])return cache.segmentation[hash];
  if(args['cache-only']==='true')throw Error('Segmentation missing in --cache-only mode');
  const t=performance.now(),inputs={input_values:new Tensor('float32',audio,[1,1,audio.length])};let result;
  try{
  result=await segmenter(inputs);
  const {data,dims}=result.logits, frames=dims[1], ms=performance.now()-t;
  if(dims[2]!==7)throw Error('Unexpected segmentation classes');
  const intervals=[];
  for(let f=0;f<frames;f++){
    const vals=Array.from(data.slice(f*7,f*7+7)),best=vals.indexOf(Math.max(...vals));
    const confidence=1/vals.reduce((sum,v)=>sum+Math.exp(v-vals[best]),0);
    const item={start:f/frames*audio.length/16000,end:(f+1)/frames*audio.length/16000,speakers:powerset[best],confidence};
    const last=intervals.at(-1);
    if(last&&last.class===best){const n=last.frames;last.end=item.end;last.confidence=(last.confidence*n+confidence)/(n+1);last.frames++;}
    else intervals.push({...item,class:best,frames:1});
  }
  const value={intervals,ms,seconds:audio.length/16000};segmentDurations.push({ms,seconds:value.seconds});cache.segmentation[hash]=value;return value;
  }finally{disposeTensors(inputs,result);}
}
function match(vector,profiles,threshold=.75,margin=.08){
  if(!vector)return {id:null,similarity:null,margin:null};
  const scores=profiles.map(p=>({id:p.id,score:profilesAPI.cosine(vector,p.vector)})).sort((a,b)=>b.score-a.score);
  const best=scores[0];if(!best)return {id:null,similarity:null,margin:null};
  const lead=scores.length>1?best.score-scores[1].score:1;
  return {id:best.score>=threshold&&lead>=margin?best.id:null,similarity:best.score,margin:lead};
}
function unanimous(matches){return matches.length&&matches.every(x=>x.id&&x.id===matches[0].id)?matches[0].id:null;}
const enrolled=[];
for(const row of manifest.enrollments)enrolled.push({...row,id:row.speaker,vector:await embed(read(row))});
let syntheticProfiles=enrolled.filter(e=>e.source==='say');
const rows=[];
const engine={segment:async audio=>{const s=await segment(audio);return {durationMs:s.seconds*1000,processingMs:s.ms,intervals:s.intervals.map(i=>({startMs:i.start*1000,endMs:i.end*1000,speakers:i.speakers,confidence:i.confidence}))};},embed:async audio=>Float32Array.from(await embed(audio))};
const enrollmentChecks=[];
for(const item of manifest.enrollments.filter(e=>e.source==='say')){const audio=read(item);try{const cleaned=diarizationAPI.enrollmentAudio(audio,16000,await engine.segment(audio));const half=Math.floor(cleaned.length/2),a=await embed(cleaned.slice(0,half)),b=await embed(cleaned.slice(half));const consistency=profilesAPI.cosine(a,b);if(consistency<.6)throw Error('Enrollment halves disagree: '+consistency);if(args.enrollment==='clean')enrolled.find(e=>e.id===item.speaker).vector=await embed(cleaned);enrollmentChecks.push({speaker:item.speaker,accepted:true,cleanSeconds:cleaned.length/16000,halfCosine:consistency});}catch(error){enrollmentChecks.push({speaker:item.speaker,accepted:false,error:error.message});}}
if(args.enrollment==='clean')syntheticProfiles=syntheticProfiles.filter(p=>enrollmentChecks.find(c=>c.speaker===p.id)?.accepted);
let index=0;
for(const row of manifest.cases){
  const audio=read(row),profiles=row.profileGroup?enrolled.filter(e=>e.profileGroup===row.profileGroup):row.isolatedProfile?enrolled.filter(e=>e.id===row.speaker):syntheticProfiles;
  const vector=await embed(audio),whole=match(vector,profiles),seg=await segment(audio);
  const matcher=new profilesAPI.Session(profiles.map(p=>({id:p.id,name:p.id,modelId:profilesAPI.MODEL_ID,embedding:p.vector})));
  const productionWork={embeddingCalls:0,segmentationCalls:0,recordedNativeInferenceMs:0};
  const recentEmbeddings=[];
  const measuredEngine={segment:async pcm=>{const result=await engine.segment(pcm);productionWork.segmentationCalls++;productionWork.recordedNativeInferenceMs+=result.processingMs;return result;},embed:async pcm=>{const midpoint=Math.floor(pcm.length/2),a=recentEmbeddings.at(-2),b=recentEmbeddings.at(-1);if(args['average-halves']==='true'&&a&&b&&pcm.length>=4*16000&&a.hash===hashAudio(pcm.slice(0,midpoint))&&b.hash===hashAudio(pcm.slice(midpoint))){return profilesAPI.normalize(Float32Array.from(a.vector,(v,i)=>v+b.vector[i]));}const result=await engine.embed(pcm);recentEmbeddings.push({hash:hashAudio(pcm),vector:result});if(recentEmbeddings.length>2)recentEmbeddings.shift();productionWork.embeddingCalls++;productionWork.recordedNativeInferenceMs+=cache.embeddings[hashAudio(pcm)]?.ms||0;return result;}};
  const production=await diarizationAPI.analyze(audio,16000,{engine:measuredEngine,matcher});
  const temporalVariants={},temporalCosines=[];
  for(const threshold of (args.variants==='true'?[.5,.55,.6]:[])){let consistent=true;const temporalEngine={segment:engine.segment,embed:async pcm=>{consistent=true;if(pcm.length>=4*16000){const mid=Math.floor(pcm.length/2),left=await embed(pcm.slice(0,mid)),right=await embed(pcm.slice(mid));const cosine=profilesAPI.cosine(left,right);if(threshold===.5)temporalCosines.push({seconds:pcm.length/16000,cosine});consistent=cosine>=threshold;}return engine.embed(pcm);}};const session=new profilesAPI.Session(profiles.map(p=>({id:p.id,name:p.id,modelId:profilesAPI.MODEL_ID,embedding:p.vector})));const temporalMatcher={classify:embedding=>consistent?session.classify(embedding):{speakerId:null,kind:'uncertain',label:'Temporal speaker disagreement'}};const result=await diarizationAPI.analyze(audio,16000,{engine:temporalEngine,matcher:temporalMatcher});temporalVariants['sdkTemporal'+Math.round(threshold*100)]=result.kind==='known'?result.speakerId:null;}
  const chunks=[];
  const count=Math.max(1,Math.floor(row.seconds/4));
  for(let i=0;i<count;i++){
    const start=Math.floor(i*audio.length/count),end=Math.floor((i+1)*audio.length/count);
    chunks.push(match(await embed(audio.slice(start,end)),profiles));
  }
  const overlapSeconds=seg.intervals.filter(i=>i.speakers.length>1).reduce((s,i)=>s+i.end-i.start,0);
  const slotRows=[];
  for(let slot=0;slot<3;slot++){
    const clean=seg.intervals.filter(i=>i.speakers.length===1&&i.speakers[0]===slot&&i.confidence>=.6);
    const totalSamples=clean.reduce((s,i)=>s+Math.max(0,Math.floor(i.end*16000)-Math.ceil(i.start*16000)),0);
    if(totalSamples<16000)continue;
    const joined=new Float32Array(Math.min(totalSamples,15*16000));let offset=0;
    for(const interval of clean){const samples=audio.slice(Math.ceil(interval.start*16000),Math.floor(interval.end*16000));const n=Math.min(samples.length,joined.length-offset);joined.set(samples.slice(0,n),offset);offset+=n;if(offset===joined.length)break;}
    const e=await embed(joined);
    const full=match(e,profiles,.75,.08),strict=match(e,profiles,.8,.12);
    const halves=[];
    if(joined.length>=3*16000){const half=Math.floor(joined.length/2);halves.push(match(await embed(joined.slice(0,half)),profiles,.75,.08));halves.push(match(await embed(joined.slice(half)),profiles,.75,.08));}
    slotRows.push({slot,seconds:joined.length/16000,match:full,strict,halves,consistentId:unanimous(halves)});
  }
  const noOverlap=overlapSeconds<.15;
  const segmentNamed=noOverlap?unanimous(slotRows.map(s=>s.match)):null;
  const segmentStrict=noOverlap?unanimous(slotRows.map(s=>s.strict)):null;
  const segmentConsensus=noOverlap?unanimous(slotRows.map(s=>({id:s.consistentId}))):null;
  rows.push({...row,file:undefined,text:undefined,whole,chunks,segmentation:{overlapSeconds,slots:slotRows,intervals:seg.intervals},
    production,productionWork,temporalCosines, predictions:{...temporalVariants,sdk:production.kind==='known'?production.speakerId:null,whole:whole.id,baseline4s:unanimous(chunks),segmentation:segmentNamed,segmentationStrict:segmentStrict,segmentationConsensus:segmentConsensus}});
  if(++index%20===0){if(args['cache-only']!=='true')fs.writeFileSync(cachePath,JSON.stringify(cache));process.stdout.write(`Embedded ${index}/${manifest.cases.length}\n`);}
}
function summarize(selected,policy){
  const positive=selected.filter(r=>r.known),unknown=selected.filter(r=>!r.known&&!['turn','overlap','silence','white-noise','hum'].includes(r.condition));
  const overlap=selected.filter(r=>r.condition==='overlap'),turns=selected.filter(r=>r.condition==='turn');
  const nonspeech=selected.filter(r=>['silence','white-noise','hum'].includes(r.condition));
  return {cases:selected.length,known:positive.length,correctKnown:positive.filter(r=>r.predictions[policy]===r.expected).length,
    wrongKnown:positive.filter(r=>r.predictions[policy]&&r.predictions[policy]!==r.expected).length,
    knownCoverage:positive.length?positive.filter(r=>r.predictions[policy]===r.expected).length/positive.length:null,
    unknown:unknown.length,falseKnownOnUnknown:unknown.filter(r=>r.predictions[policy]).length,
    overlaps:overlap.length,namedDespiteOverlap:overlap.filter(r=>r.predictions[policy]).length,
    turns:turns.length,singleNameDespiteSpeakerChange:turns.filter(r=>r.predictions[policy]).length,
    nonspeech:nonspeech.length,namedNonspeech:nonspeech.filter(r=>r.predictions[policy]).length};
}
const policies=[...(args.variants==='true'?['sdkTemporal50','sdkTemporal55','sdkTemporal60']:[]),'sdk','whole','baseline4s','segmentation','segmentationStrict','segmentationConsensus'];
const summary={};for(const policy of policies){summary[policy]={all:summarize(rows,policy)};for(const split of new Set(rows.map(r=>r.split)))summary[policy][split]=summarize(rows.filter(r=>r.split===split),policy);for(const snr of [null,20,10,0])summary[policy]['snr'+snr]=summarize(rows.filter(r=>r.snrDb===snr),policy);}
const timing = values => {
  const ms=values.map(v=>v.ms).sort((a,b)=>a-b),rtf=values.map(v=>v.ms/(1000*v.seconds)).sort((a,b)=>a-b);
  return {measurements:values.length,medianMs:ms[Math.floor(ms.length*.5)]??null,p95Ms:ms[Math.floor(ms.length*.95)]??null,maxMs:ms.at(-1)??null,p95RealTimeFactor:rtf[Math.floor(rtf.length*.95)]??null};
};
const segmentationSummary={overlapMixtures:rows.filter(r=>r.condition==='overlap').length,detectedOverlapMixtures:rows.filter(r=>r.condition==='overlap'&&r.segmentation.overlapSeconds>=.1).length,singleVoiceCases:rows.filter(r=>['clean','noise','human-halves'].includes(r.condition)).length,falseOverlapOnSingleVoice:rows.filter(r=>['clean','noise','human-halves'].includes(r.condition)&&r.segmentation.overlapSeconds>=.1).length};
const durationOf=(row,predicate)=>row.production.intervals.filter(predicate).reduce((s,i)=>s+(i.endMs-i.startMs)/1000,0);
const intervalSafety={unknownSpeechSeconds:0,namedUnknownSpeechSeconds:0,mixtureSeconds:0,namedMixtureSeconds:0,knownSpeechSeconds:0,wrongKnownSpeechSeconds:0,turnRegionSeconds:0,wrongKnownTurnRegionSeconds:0};
for(const row of rows){if(row.condition==='turn'){for(const region of row.regions){intervalSafety.turnRegionSeconds+=region.end-region.start;for(const interval of row.production.intervals){if(interval.kind==='known'&&interval.speakerId!==region.speaker)intervalSafety.wrongKnownTurnRegionSeconds+=Math.max(0,Math.min(region.end,interval.endMs/1000)-Math.max(region.start,interval.startMs/1000));}}}if(!row.known&&!['turn','overlap','silence','white-noise','hum'].includes(row.condition)){intervalSafety.unknownSpeechSeconds+=row.seconds;intervalSafety.namedUnknownSpeechSeconds+=durationOf(row,i=>i.kind==='known');}if(row.condition==='overlap'){intervalSafety.mixtureSeconds+=row.seconds;intervalSafety.namedMixtureSeconds+=durationOf(row,i=>i.kind==='known');}if(row.known){intervalSafety.knownSpeechSeconds+=row.seconds;intervalSafety.wrongKnownSpeechSeconds+=durationOf(row,i=>i.kind==='known'&&i.speakerId!==row.expected);}}
const report={segmentationSummary,intervalSafety,at:new Date().toISOString(),runtime:`Transformers.js ${runtimeVersion}, native onnxruntime-node CPU, 1 thread; NOT WKWebView or ASR contention test`,
  helperHash,inferenceFingerprint:cacheKey,nativeRuntimeVersion:nativeRuntimeMetadata.version,experimentalPolicy:{rmsMin:args['rms-min']||null,averageHalves:args['average-halves']==='true'},enrollmentMode:args.enrollment==='clean'?'Production clean synthetic enrollment + .6 half-consistency; exploratory FLEURS remains disjoint raw half':'Raw whole enrollment vectors; clean enrollment acceptance reported separately',enrollmentChecks,waveformSourcePlatform:manifest.platform,machine:{platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0]?.model},modelHash,segmentationHash,loadMs,
  methodology:{baseline:'Existing approximately 4-second windows, unanimous .75 cosine/.08 margin. Whole-window comparator included.',
    segmentation:'Powerset argmax, single-speaker frames confidence >= .6, >= 1 sec clean speech per slot, reject a whole-segment name when detected overlap >= .15 sec or slots disagree.',
    segmentationStrict:'Same segmentation; .80 cosine/.12 margin.',segmentationConsensus:'Same segmentation, plus >= 3sec clean speech and matching disjoint halves at .75/.08. Experimental policy, not a calibrated production guarantee.',
    split:'Different texts for enrollment, development, and holdout; all variants from a text remain in its partition. Same synthetic voice IDs span splits. Human exploratory uses same-file disjoint halves, not heldout cross-call recordings.',
    limits:['Synthetic voices do not establish human production accuracy.','FLEURS read speech lacks speaker IDs here; no inter-recording false-match conclusions.','Mixture labels describe construction; full interval has natural within-utterance pauses, so overlap frame recall cannot be inferred from duration alone.','No DER is reported because frame-level human speaker ground truth is unavailable.','Cosine and segmentation confidence are model scores, not calibrated probabilities.','Native CPU timing excludes WK, capture, transfer and concurrent ASR.']},
  provenance:manifest.provenance,summary,timing:{embedding:timing(durations),segmentation:timing(segmentDurations),estimatedPipelineFromCachedNativeMeasurements:timing(rows.map(r=>({ms:r.productionWork.recordedNativeInferenceMs,seconds:r.seconds}))),recordedNativeCacheEmbedding:timing(Object.values(cache.embeddings)),recordedNativeCacheSegmentation:timing(Object.values(cache.segmentation))},rows};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');if(args['cache-only']!=='true')fs.writeFileSync(cachePath,JSON.stringify(cache));
console.log(JSON.stringify({output,summary,timing:report.timing},null,2));
} finally {
  await Promise.allSettled([model.dispose(),segmenter.dispose()]);
}

}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
