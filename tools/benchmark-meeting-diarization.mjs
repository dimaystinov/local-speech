#!/usr/bin/env node
/* Reproducible real meeting evaluation. Audio and results stay in ignored validation/. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'validation/diarization-human-ami');
const args=process.argv.slice(2),runtimeArg=args.find(x=>x.startsWith('--transformers-dir='));
const variant=args.find(x=>x.startsWith('--variant='))?.slice(10)||'current';
const noInference=args.includes('--no-inference'),migrateCache=args.includes('--migrate-cache');
const outputArg=args.find(x=>x.startsWith('--output='))?.slice(9);
if(!['current','baseline','rms','rms-confidence05','rms-window10','rms-gain','rms-halfmean','contextual10'].includes(variant))throw Error('Invalid benchmark variant');
const outputFile=outputArg?path.resolve(outputArg):path.join(dir,'report-'+variant+'.json');
if(!outputFile.startsWith(path.join(root,'validation')+path.sep))throw Error('Keep benchmark outputs in ignored validation');
if(args.some(x=>!['--prepare-only','--no-inference','--migrate-cache'].includes(x)&&!['--transformers-dir=','--variant=','--output='].some(prefix=>x.startsWith(prefix))))throw Error('Usage: node tools/benchmark-meeting-diarization.mjs [--prepare-only] [--transformers-dir=PATH] [--variant=current|contextual10|baseline|rms|rms-confidence05|rms-window10|rms-gain|rms-halfmean] [--output=validation/FILE.json]');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const SOURCES = {
  "clips": [
    {
      "file": "IS1009a.Mix-Headset.wav",
      "url": "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/IS1009a/audio/IS1009a.Mix-Headset.wav",
      "seconds": 120,
      "prefixBytes": 3840044,
      "prefixSha256": "4679808f356575bff6486d403d834571801dc227f48ac67310ca0f2eda6eb5e3",
      "sha256": "03f9cefb7018a4529c0bf94ab2a4d6a4ba16128fd03b6c0764425ec2677d9954"
    },
    {
      "file": "IS1009b.Mix-Headset.wav",
      "url": "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/IS1009b/audio/IS1009b.Mix-Headset.wav",
      "seconds": 300,
      "prefixBytes": 9600044,
      "prefixSha256": "2900d26776da3cc25daaeb39da23ca26b773c4ed5181e4f3cca781b052679004",
      "sha256": "4d2c6337aa7f016d8501f5ff28a7bce6bbf57c27a6dec537bb38e8de1c9bc707"
    },
    {
      "file": "IS1009b.Array1-01.wav",
      "url": "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/IS1009b/audio/IS1009b.Array1-01.wav",
      "seconds": 300,
      "prefixBytes": 9600044,
      "prefixSha256": "65482dcd62aa6bc2c5b4c91a65f29a5f97b867469f716555a5945f4481699573",
      "sha256": "3fb29f40c7bc01bcd8e3b45a045a04389e2aefe25c48a10ecffd73bf3aec8000"
    }
  ],
  "annotations": [
    {
      "file": "IS1009a.rttm",
      "url": "https://raw.githubusercontent.com/pyannote/AMI-diarization-setup/67c2d539286e89f68952d5dcf83912bd9f01dfae/only_words/rttms/test/IS1009a.rttm",
      "sha256": "ba38d35ca567f3f1e061d90fdc33579ce60d2060fc8664eaeb77d2e0fcd88b01"
    },
    {
      "file": "IS1009b.rttm",
      "url": "https://raw.githubusercontent.com/pyannote/AMI-diarization-setup/67c2d539286e89f68952d5dcf83912bd9f01dfae/only_words/rttms/test/IS1009b.rttm",
      "sha256": "5cb6ae3948c09ce8356991cc79bb593abc1f0d23f1dbadeeb88e17e055283e67"
    }
  ]
};
async function download(source){
 const target=path.join(dir,source.file);
 if(fs.existsSync(target)&&sha(fs.readFileSync(target))===source.sha256)return;
 const response=await fetch(source.url,{headers:source.prefixBytes?{Range:`bytes=0-${source.prefixBytes-1}`}:{}});
 if(!response.ok||source.prefixBytes&&response.status!==206)throw Error('Cannot download pinned source: '+source.file);
 const max=source.prefixBytes||1024*1024;let length=0;const chunks=[];
 for await(const chunk of response.body){length+=chunk.length;if(length>max)throw Error('Oversize download');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);
 if(source.prefixBytes){
  if(bytes.length!==source.prefixBytes||sha(bytes)!==source.prefixSha256)throw Error('Audio prefix hash mismatch');
  if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',36,40)!=='data'||bytes.readUInt16LE(20)!==1||bytes.readUInt16LE(22)!==1||bytes.readUInt32LE(24)!==16000||bytes.readUInt16LE(34)!==16)throw Error('Unsupported source WAV');
  bytes.writeUInt32LE(bytes.length-8,4);bytes.writeUInt32LE(bytes.length-44,40);
 }
 if(sha(bytes)!==source.sha256)throw Error('Source integrity mismatch: '+source.file);
 fs.writeFileSync(target,bytes);
}
fs.mkdirSync(dir,{recursive:true});
for(const source of [...SOURCES.clips,...SOURCES.annotations])await download(source);
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(SOURCES,null,2)+'\n');
if(args.includes('--prepare-only')){console.log('Verified AMI source prefixes and reference annotations in '+dir);process.exit(0);}
const runtime=runtimeArg?path.resolve(runtimeArg.slice('--transformers-dir='.length)):path.join(root,'node_modules/@huggingface/transformers');
const metadata=JSON.parse(fs.readFileSync(path.join(runtime,'package.json')));
if(metadata.version!=='3.8.1')throw Error('Requires pinned Transformers.js 3.8.1');
const {env,AutoModel,AutoFeatureExtractor,AutoModelForAudioFrameClassification,Tensor}=noInference?{}:await import(pathToFileURL(path.join(runtime,'dist/transformers.node.mjs')).href);
if(env){env.allowRemoteModels=false;env.localModelPath=path.join(root,'models')+path.sep;}
const opts={local_files_only:true,device:'cpu',dtype:'q8',session_options:{intraOpNumThreads:1,interOpNumThreads:1}};
const modelManifest=JSON.parse(fs.readFileSync(path.join(root,'sdk/speaker-assets-manifest.json')));
for(const item of modelManifest.files.filter(x=>['model','segmentation'].includes(x.source))){if(sha(fs.readFileSync(path.join(root,item.path)))!==item.sha256)throw Error('Model hash mismatch');}
const model=noInference?null:await AutoModel.from_pretrained('speaker-wespeaker',opts),extractor=noInference?null:await AutoFeatureExtractor.from_pretrained('speaker-wespeaker',{local_files_only:true}),segmentation=noInference?null:await AutoModelForAudioFrameClassification.from_pretrained('segmentation-pyannote',opts);
const P=require(path.join(root,'sdk/speaker-profiles.js')),{decodeSegmentation}=require(path.join(root,'speaker-worker.js'));
const baselinePath=path.join(dir,'helper-baseline.js');
if(!['current','contextual10'].includes(variant)&&!fs.existsSync(baselinePath))throw Error('Exploratory variants require preserved helper-baseline.js');
let helperSource=fs.readFileSync(['current','contextual10'].includes(variant)?path.join(root,'sdk/speaker-diarization.js'):baselinePath,'utf8');
const replaceOnce=(source,old,value)=>{if(source.split(old).length!==2)throw Error('Variant no longer matches helper source');return source.replace(old,value);};
if(variant.startsWith('rms'))helperSource=replaceOnce(helperSource,'>=.003&&clipped','>=.0005&&clipped');
if(variant==='rms-confidence05')helperSource=replaceOnce(helperSource,'MIN_CONFIDENCE=.6','MIN_CONFIDENCE=.5');
if(variant==='rms-halfmean'){
 helperSource=replaceOnce(helperSource,'if(clean.durationMs>=4000){','let halfMean; if(clean.durationMs>=4000){');
 helperSource=replaceOnce(helperSource,'if(cosine(a,b)<.55)', 'halfMean=Float32Array.from(a,(x,i)=>(x+b[i])/2); if(cosine(a,b)<.55)');
 helperSource=replaceOnce(helperSource,'const embedding=await engine.embed(clean.audio,rate);','const embedding=halfMean||await engine.embed(clean.audio,rate);');
}
const helperModule={exports:{}};new Function('module','exports',helperSource)(helperModule,helperModule.exports);const D=helperModule.exports;
const windowSeconds=variant==='rms-window10'?10:6;
const cachePath=path.join(dir,'inference-cache.json'),cached=fs.existsSync(cachePath)?JSON.parse(fs.readFileSync(cachePath)):{};
const decoderPath=path.join(root,'speaker-worker.js');
const cacheProvenance={model:modelManifest.model,segmentation:modelManifest.segmentation,assets:modelManifest.files.filter(x=>['model','segmentation','transformers'].includes(x.source)),runtime:modelManifest.runtime,runtimeBundleSha256:sha(fs.readFileSync(path.join(runtime,'dist/transformers.node.mjs'))),nativeRuntimePackageSha256:sha(fs.readFileSync(path.resolve(runtime,'../../onnxruntime-node/package.json'))),decoderSourceSha256:sha(fs.readFileSync(decoderPath))};
const cacheFingerprint=sha(JSON.stringify(cacheProvenance));
if(migrateCache&&!cached.fingerprint){
 if(!noInference)throw Error('Legacy cache migration must be explicitly offline with --no-inference');
 const oldReport=JSON.parse(fs.readFileSync(path.join(dir,'report.json'))),oldTime=Date.parse(oldReport.at);
 if(JSON.stringify(oldReport.model)!==JSON.stringify(modelManifest.model)||JSON.stringify(oldReport.segmentation)!==JSON.stringify(modelManifest.segmentation)||!oldReport.runtime.includes('3.8.1'))throw Error('Legacy cache model/runtime provenance mismatch');
 for(const file of [decoderPath,path.join(runtime,'dist/transformers.node.mjs'),...modelManifest.files.filter(x=>['model','segmentation'].includes(x.source)).map(x=>path.join(root,x.path))])if(fs.statSync(file).mtimeMs>oldTime)throw Error('Legacy cache source changed after initial report');
 const entries={...cached};for(const [key,value] of Object.entries(entries)){if(!/^[es][a-f0-9]{64}$/.test(key)||key[0]==='e'&&(!Array.isArray(value)||value.length!==256||value.some(x=>!Number.isFinite(x)))||key[0]==='s'&&(!Array.isArray(value.intervals)||!Number.isFinite(value.durationMs)))throw Error('Malformed legacy inference cache');}
 for(const key of Object.keys(cached))delete cached[key];Object.assign(cached,{fingerprint:cacheFingerprint,entries,migration:{at:new Date().toISOString(),from:'Legacy cache created during this same benchmark session',validation:'Old report model revisions/runtime match; pinned assets verified; decoder/runtime/model files predate original report. No inference performed.',provenance:cacheProvenance}});
 fs.writeFileSync(cachePath,JSON.stringify(cached));
}
const timing=[],cache=new Map(Object.entries(cached.fingerprint===cacheFingerprint?cached.entries:{}).map(([key,value])=>[key,key.startsWith('e')?Float32Array.from(value):value]));
function pcm(file){const b=fs.readFileSync(path.join(dir,file));if(sha(b)!==SOURCES.clips.find(x=>x.file===file).sha256)throw Error('Fixture changed');return Float32Array.from({length:(b.length-44)/2},(_,i)=>b.readInt16LE(44+i*2)/32768);}
function rttm(file){return fs.readFileSync(path.join(dir,file),'utf8').trim().split('\n').map(line=>{const x=line.split(/\s+/);return {start:+x[3],end:+x[3]+ +x[4],speaker:x[7]};});}
const hashPCM=a=>sha(Buffer.from(a.buffer,a.byteOffset,a.byteLength));
const engine={
 async segment(audio){const key='s'+hashPCM(audio);if(cache.has(key))return cache.get(key);if(noInference)throw Error('Uncached segmentation requested in no-inference mode');const input=new Tensor('float32',audio,[1,1,audio.length]),start=performance.now();let out;try{out=await segmentation({input_values:input});const durationMs=audio.length/16,result={durationMs,processingMs:performance.now()-start,intervals:decodeSegmentation(out.logits,durationMs)};cache.set(key,result);timing.push({operation:'segment',ms:result.processingMs,seconds:durationMs/1000});return result;}finally{out?.logits?.dispose();input.dispose();}},
 async embed(audio){const key='e'+hashPCM(audio);if(cache.has(key))return cache.get(key);if(noInference)throw Error('Uncached embedding requested in no-inference mode');const start=performance.now(),inputs=await extractor(audio);let out;try{out=await model(inputs);const tensor=Object.values(out).find(x=>x?.data?.length===256);if(!tensor)throw Error('Embedding contract');const vector=P.normalize(tensor.data);cache.set(key,vector);timing.push({operation:'embed',ms:performance.now()-start,seconds:audio.length/16000});return vector;}finally{for(const x of Object.values({...inputs,...out}))x?.dispose?.();}}
};
function active(rows,time){return [...new Set(rows.filter(r=>r.start<=time&&r.end>time).map(r=>r.speaker))];}
function cleanRuns(rows,end){const edges=[...new Set([0,end,...rows.flatMap(r=>[r.start,r.end]).filter(x=>x>0&&x<end)])].sort((a,b)=>a-b),runs=[];for(let i=0;i<edges.length-1;i++){const start=edges[i],stop=edges[i+1],ids=active(rows,(start+stop)/2);if(ids.length!==1)continue;const last=runs.at(-1);if(last&&last.speaker===ids[0]&&Math.abs(last.end-start)<1e-6)last.end=stop;else runs.push({start,end:stop,speaker:ids[0]});}return runs;}
const enrollmentPCM=pcm('IS1009a.Mix-Headset.wav'),enrollmentRows=rttm('IS1009a.rttm'),profiles=[],enrollment=[];
for(const run of cleanRuns(enrollmentRows,120)){
 if(profiles.some(x=>x.id===run.speaker)||run.end-run.start<3.5)continue;
 const start=run.start+.05,end=Math.min(run.end-.05,start+8),audio=enrollmentPCM.slice(Math.ceil(start*16000),Math.floor(end*16000));
 try{
  const clean=D.enrollmentAudio(audio,16000,await engine.segment(audio)),mid=Math.floor(clean.length/2),left=await engine.embed(clean.slice(0,mid)),right=await engine.embed(clean.slice(mid)),similarity=P.cosine(left,right);
  if(similarity<.6)throw Error('Enrollment halves cosine below existing .6 gate');
  const vector=await engine.embed(clean);profiles.push({id:run.speaker,name:run.speaker,modelId:P.MODEL_ID,embedding:Array.from(vector)});enrollment.push({speaker:run.speaker,start,end,accepted:true,cleanSeconds:clean.length/16000,halvesCosine:similarity});
 }catch(error){enrollment.push({speaker:run.speaker,start,end,accepted:false,reason:error.message});}
}
const ref=rttm('IS1009b.rttm'),evaluation=[];
function score(intervals,withheld){
 const counts={singleSpeech:0,knownSingleSpeech:0,unknownSingleSpeech:0,correctKnownSingle:0,wrongNamedSingle:0,namedUnknownSingle:0,overlap:0,detectedOverlap:0,falseOverlap:0,namedDuringOverlap:0,silence:0,namedSilence:0};
 const details=Object.fromEntries([...new Set(ref.map(r=>r.speaker))].map(id=>[id,{singleSpeech:0,namedCorrect:0,namedWrong:0}]));let n=0;
 for(let frame=0;frame<30000;frame++){
  const t=(frame+.5)/100,ids=active(ref,t);while(n<intervals.length-1&&intervals[n].endMs<=t*1000)n++;const pred=intervals[n],present=pred&&pred.startMs<=t*1000&&pred.endMs>t*1000,known=present&&pred.kind==='known',overlap=present&&pred.kind==='overlap';
  if(ids.length===0){counts.silence++;if(known)counts.namedSilence++;}
  else if(ids.length===1){const id=ids[0];counts.singleSpeech++;details[id].singleSpeech++;if(profiles.some(p=>p.id===id)&&id!==withheld)counts.knownSingleSpeech++;else counts.unknownSingleSpeech++;if(known){if(pred.speakerId===id){counts.correctKnownSingle++;details[id].namedCorrect++;}else{counts.wrongNamedSingle++;details[id].namedWrong++;}if(id===withheld||!profiles.some(p=>p.id===id))counts.namedUnknownSingle++;}}
  else {counts.overlap++;if(overlap)counts.detectedOverlap++;if(known)counts.namedDuringOverlap++;}
  if(overlap&&ids.length<2)counts.falseOverlap++;
 }
 const seconds=Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,v/100]));
 return {seconds,correctKnownCoverage:counts.knownSingleSpeech?counts.correctKnownSingle/counts.knownSingleSpeech:null,wrongNamedSingleRate:counts.singleSpeech?counts.wrongNamedSingle/counts.singleSpeech:null,overlapRecall:counts.overlap?counts.detectedOverlap/counts.overlap:null,overlapPrecision:counts.detectedOverlap+counts.falseOverlap?counts.detectedOverlap/(counts.detectedOverlap+counts.falseOverlap):null,perSpeaker:Object.fromEntries(Object.entries(details).map(([id,v])=>[id,Object.fromEntries(Object.entries(v).map(([k,n])=>[k,n/100]))]))};
}
const heldoutSpeaker=profiles.map(p=>p.id).sort().at(-1);
for(const condition of [{file:'IS1009b.Mix-Headset.wav',withheld:null},{file:'IS1009b.Array1-01.wav',withheld:null},{file:'IS1009b.Array1-01.wav',withheld:heldoutSpeaker}]){
 const audio=pcm(condition.file),session=new P.Session(profiles.filter(p=>p.id!==condition.withheld)),intervals=[],chunks=[];const started=performance.now();
 for(let start=0;start<300;start+=windowSeconds){const t=performance.now();const contextStart=variant==='contextual10'?Math.max(0,start+windowSeconds-10):start;let chunk=audio.slice(contextStart*16000,(start+windowSeconds)*16000);if(variant==='rms-gain'){const rms=Math.sqrt(chunk.reduce((n,x)=>n+x*x,0)/chunk.length),peak=chunk.reduce((n,x)=>Math.max(n,Math.abs(x)),0),gain=Math.min(6,.03/Math.max(.00001,rms),.95/Math.max(.00001,peak));chunk=Float32Array.from(chunk,x=>x*gain);}const result=await D.analyze(chunk,16000,{engine,matcher:session});intervals.push(...result.intervals.map(x=>({...x,startMs:Math.max(start*1000,x.startMs+contextStart*1000),endMs:Math.min((start+windowSeconds)*1000,x.endMs+contextStart*1000)})).filter(x=>x.endMs>x.startMs));chunks.push({start,kind:result.kind,processingMs:performance.now()-t});}
 const row={...condition,processingMs:performance.now()-started,metrics:score(intervals,condition.withheld),chunks,intervals};evaluation.push(row);console.log(JSON.stringify({condition,metrics:row.metrics}));
}
const report={variant,windowSeconds,noInference,cacheProvenance,cacheFingerprint,cacheHitsAllowed:true,contextPolicy:variant==='contextual10'?'Causal: previous4s plus current6s; nofutureaudio; clip every output to current6s interval':'Current window only',exploratory:variant!=='current',at:new Date().toISOString(),runtime:'Transformers.js3.8.1 native ONNX CPU, one thread. Not browser or ASR contention timing.',provenance:{dataset:'AMI Meeting Corpus, standard diarization test split',license:'CC-BY4.0 audio; Apache2.0 annotation setup',audioLicenseURL:'https://groups.inf.ed.ac.uk/ami/corpus/',referenceRevision:'67c2d539286e89f68952d5dcf83912bd9f01dfae',sources:SOURCES},model:modelManifest.model,segmentation:modelManifest.segmentation,helperSha256:sha(helperSource),methodology:{enrollment:'First eligible single-speaker3.5–8s region per identity from IS1009a first120s, oracle RTTM selects candidate only; actual production enrollment gate and halves cosine .6 applied. Failures kept.',evaluation:'Separate meeting IS1009b first300s, Declared windowSeconds and contextPolicy; SDK helper and identity thresholds remain fixed at .75/.08. Headsetmix and farfield same timeline. Farfield repeated with one profile withheld. Non-current variants are exploratory sensitivity, not new heldout validation.',score:'10ms frame midpoint, zero collar, overlap included. Known attribution coverage and wrong naming are separate; uncertain predictions reduce coverage. No standard DER claimed.',limits:['One English meeting group with4people does not establish production accuracy or Russian quality.','AMI is related to segmentation training data; standard test split is not unseen-domain validation.','MeetingA enrollment and meetingB evaluation share speakers intentionally; no temporal overlap.','Word-only RTTM excludes some breaths, laughter and vocalizations; zero-collar scores penalize boundary differences.','Oracle candidate selection is easier than arbitrary user enrollment audio.','Mixed microphones and farfield are paired acoustic variants, not independent meetings.']},enrollment,enrolled:profiles.map(p=>p.id),withheldSpeaker:heldoutSpeaker,timing,evaluation};
fs.writeFileSync(outputFile,JSON.stringify(report,null,2)+'\n');
fs.writeFileSync(cachePath,JSON.stringify({fingerprint:cacheFingerprint,provenance:cacheProvenance,migration:cached.migration,entries:Object.fromEntries([...cache].map(([key,value])=>[key,key.startsWith('e')?Array.from(value):value]))}));
await model?.dispose();await segmentation?.dispose();console.log('Report: '+outputFile);
