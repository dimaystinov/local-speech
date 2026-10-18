/* Reproducible self-host package. No remote fetch or model execution. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const PACKAGE_ID='local-speech-sdk',VERSION=require('../package.json').version;
const SCRIPTS=['model-catalog.js','system-recognizer.js','capture.js','resilience.js','device-policy.js','recognition-policy.js','local-engine.js','sdk/local-speech.js'];
const FILES=['sdk/voice.mjs','sdk/voice.d.ts','worker.js','pcm-worklet.js','model-catalog.js','signal.js','context.js','vendor/sherpa-onnx-wasm-web.js','vendor/sherpa-onnx-wasm-web.wasm','vendor/sherpa-onnx-asr.js','vendor/sherpa-onnx-vad.js','vendor/LICENSE-sherpa-onnx','sdk/README.md','sdk/local-speech.mjs','sdk/local-speech.d.ts','sdk/THIRD_PARTY_NOTICES.md','sdk/licenses/whisper.txt','sdk/licenses/silero-vad.txt','sdk/licenses/onnxruntime.txt'];
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function readFile(root,relative){const file=path.join(root,relative);if(!fs.statSync(file).isFile())throw Error('Missing regular file: '+relative);return fs.readFileSync(file);}
function validateManifest(manifest){
  const seen=new Set();
  if(!Array.isArray(manifest))throw Error('Invalid model manifest');
  for(const entry of manifest){
    if(!entry||typeof entry.model!=='string'||!/^[a-zA-Z0-9_-]+$/.test(entry.model)||typeof entry.file!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.file)||!Number.isSafeInteger(entry.bytes)||entry.bytes<=0||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid model manifest entry');
    const key=entry.model+'/'+entry.file;if(seen.has(key))throw Error('Duplicate model manifest entry: '+key);seen.add(key);
  }
  return seen;
}
function ownedOutput(out){
  if(!fs.existsSync(out))return false;
  if(fs.lstatSync(out).isSymbolicLink()||!fs.statSync(out).isDirectory())throw Error('Refusing to replace non-directory or symlink output');
  try{
    const manifest=JSON.parse(readFile(out,'package-manifest.json'));
    const bundle=readFile(out,'local-speech.js').subarray(0,120).toString();
    const legacy=manifest.version==='0.1.0'&&Array.isArray(manifest.models)&&Array.isArray(manifest.files)&&manifest.files.some(x=>x.path==='local-speech.js')&&bundle.startsWith('/* LocalSpeech 0.1.0; host locally;');
    if(manifest.package===PACKAGE_ID||legacy)return true;
  }catch{}
  throw Error('Refusing to replace an output directory without a LocalSpeech ownership manifest');
}
function buildSDK({projectRoot=path.resolve(__dirname,'..'),outputRoot,models=['small','whisper_tiny','whisper'],runtimeOnly=false}={}){
  const root=path.resolve(projectRoot),out=path.resolve(outputRoot||path.join(root,'dist/local-speech'));
  const relativeRoot=path.relative(out,root);
  if(relativeRoot===''||(!relativeRoot.startsWith('..'+path.sep)&&relativeRoot!=='..'&&!path.isAbsolute(relativeRoot)))throw Error('Output cannot contain the project root');
  if(!Array.isArray(models)||!models.length||models.some(x=>typeof x!=='string')||new Set(models).size!==models.length)throw Error('Invalid/duplicate model selection');
  const selected=[...models],scope={};vm.createContext(scope);
  vm.runInContext(readFile(root,'model-catalog.js').toString()+';this.catalog=SPEECH_MODELS;',scope,{timeout:1000});
  if(selected.some(x=>!Object.hasOwn(scope.catalog,x)))throw Error('Unknown model selection');
  const manifest=JSON.parse(readFile(root,'evidence/model-manifest.json')),known=validateManifest(manifest);
  const wanted=new Set([...selected,'vad',...(selected.some(x=>['small','zipformer'].includes(x))?['context']:[])]);
  const required=selected.flatMap(model=>{
    const files=scope.catalog[model].files;
    if(!Array.isArray(files)||!files.length||files.some(x=>typeof x!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(x)))throw Error('Invalid catalog files: '+model);
    return files.map(file=>model+'/'+file);
  });
  required.push('vad/silero_vad.onnx');if(wanted.has('context'))required.push('context/ru-bpe.vocab');
  for(const key of required)if(!known.has(key))throw Error('Missing required manifest asset: '+key);
  const entries=manifest.filter(entry=>wanted.has(entry.model)),files=[...FILES],expected=new Map();
  for(const entry of runtimeOnly?[]:entries){
    const rel=`models/${entry.model}/${entry.file}`,bytes=readFile(root,rel);
    if(bytes.length!==entry.bytes||digest(bytes)!==entry.sha256)throw Error('Asset integrity mismatch: '+rel);
    expected.set(rel,entry);files.push(rel);
  }
  for(const model of runtimeOnly?[]:wanted){const rel=`models/${model}/LICENSE`;if(fs.existsSync(path.join(root,rel))&&!files.includes(rel))files.push(rel);}
  for(const file of files)readFile(root,file);
  const bundle='/* LocalSpeech '+VERSION+'; host locally; no telemetry or cloud ASR. */\n(function(module){\n'+SCRIPTS.map(file=>`\n// ${file}\n`+readFile(root,file).toString().replaceAll('__LOCAL_SPEECH_VERSION__',VERSION)).join('\n')+'\n})();\n';new vm.Script(bundle);
  const replacing=ownedOutput(out),parent=path.dirname(out);fs.mkdirSync(parent,{recursive:true});
  const stage=fs.mkdtempSync(path.join(parent,'.local-speech-stage-')),backup=path.join(parent,'.local-speech-backup-'+crypto.randomUUID());
  const inventory=[];let movedOld=false,published=false;
  function write(rel,bytes){const dest=path.join(stage,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);inventory.push({path:rel,bytes:bytes.length,sha256:digest(bytes)});}
  try{
    write('local-speech.js',Buffer.from(bundle));
    for(const file of files){const source=readFile(root,file),bytes=file==='sdk/local-speech.mjs'?Buffer.from(bundle+'\n'+source.toString().replace("import './local-speech.js';\n",'')):source,entry=expected.get(file);if(entry&&(entry.bytes!==bytes.length||entry.sha256!==digest(bytes)))throw Error('Source changed during build: '+file);write(file.startsWith('sdk/')?file.slice(4):file,bytes);}
    write('evidence/model-manifest.json',Buffer.from(JSON.stringify(entries,null,2)+'\n'));
    const contentBytes=inventory.reduce((sum,file)=>sum+file.bytes,0);
    const packageBytes=Buffer.from(JSON.stringify({package:PACKAGE_ID,version:VERSION,models:selected,weightsIncluded:!runtimeOnly,files:inventory,totalBytes:contentBytes,note:'totalBytes and files exclude this package manifest. Uncompressed files; runtime RAM and host app excluded. SDK registers no service worker.'},null,2)+'\n');
    fs.writeFileSync(path.join(stage,'package-manifest.json'),packageBytes);
    if(replacing){ownedOutput(out);fs.renameSync(out,backup);movedOld=true;}
    else if(fs.existsSync(out))throw Error('Output appeared during build; refusing replacement');
    fs.renameSync(stage,out);published=true;
    if(movedOld)fs.rmSync(backup,{recursive:true});
    return {directory:out,models:selected,files:inventory.length+1,contentBytes,totalBytes:contentBytes+packageBytes.length};
  }catch(error){
    if(movedOld&&!published){try{fs.renameSync(backup,out);}catch(restoreError){error.message+='; prior package retained at '+backup+': '+restoreError.message;}}
    throw error;
  }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true});}
}
function parseArgs(args){if(args.length>1||args.some(arg=>!arg.startsWith('--models=')))throw Error('Usage: node tools/build-sdk.cjs --models=small,whisper_tiny,whisper');return args.length?args[0].slice(9).split(','):undefined;}
if(require.main===module){console.log(JSON.stringify(buildSDK(process.argv.slice(2).length===1&&process.argv[2]==='--runtime-only'?{runtimeOnly:true}:{models:parseArgs(process.argv.slice(2))}),null,2));}
module.exports={buildSDK,validateManifest,parseArgs};
