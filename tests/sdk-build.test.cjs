const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {buildSDK,parseArgs}=require('../tools/build-sdk.cjs');
const digest=data=>crypto.createHash('sha256').update(data).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'speech-sdk-build-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(relative,data)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
  for(const file of ['system-recognizer.js','capture.js','resilience.js','device-policy.js','recognition-policy.js','local-engine.js','sdk/local-speech.js','worker.js','pcm-worklet.js','signal.js','context.js','vendor/sherpa-onnx-wasm-web.js','vendor/sherpa-onnx-asr.js','vendor/sherpa-onnx-vad.js'])write(file,'/* fixture */');
  write('model-catalog.js',"const SPEECH_MODELS={small:{files:['encoder.onnx','tokens.txt']},whisper_tiny:{files:['tiny.onnx','tokens.txt']}};");
  write('vendor/sherpa-onnx-wasm-web.wasm','wasm fixture');write('vendor/LICENSE-sherpa-onnx','runtime notice');write('sdk/README.md','# Fixture SDK');write('sdk/local-speech.mjs','export const LocalSpeech = {};');write('sdk/local-speech.d.ts','export declare const LocalSpeech: object;');write('sdk/THIRD_PARTY_NOTICES.md','all verified notices fixture');for(const name of ['whisper','silero-vad','onnxruntime'])write('sdk/licenses/'+name+'.txt','MIT fixture '+name);
  const entries=[];
  for(const [model,names] of Object.entries({small:['encoder.onnx','tokens.txt'],whisper_tiny:['tiny.onnx','tokens.txt'],vad:['silero_vad.onnx'],context:['ru-bpe.vocab']}))for(const file of names){const bytes=Buffer.from(model+'/'+file);write(`models/${model}/${file}`,bytes);entries.push({model,file,bytes:bytes.length,sha256:digest(bytes)});}
  write('models/small/LICENSE','model notice');
  const saveManifest=(list=entries)=>write('evidence/model-manifest.json',JSON.stringify(list));saveManifest();
  const out=path.join(root,'dist/local-speech');
  const build=(models=['small','whisper_tiny'])=>buildSDK({projectRoot:root,outputRoot:out,models});
  return {root,out,write,entries,saveManifest,build};
}
test('fresh package has verified exact inventory, selected assets and mandatory notices',t=>{
  const f=fixture(t),result=f.build(),manifest=JSON.parse(fs.readFileSync(path.join(f.out,'package-manifest.json')));
  assert.equal(manifest.package,'local-speech-sdk');assert.deepEqual(manifest.models,['small','whisper_tiny']);
  let bytes=0;for(const file of manifest.files){const actual=fs.readFileSync(path.join(f.out,file.path));assert.equal(actual.length,file.bytes);assert.equal(digest(actual),file.sha256);bytes+=actual.length;}
  assert.equal(manifest.totalBytes,bytes);assert.equal(result.contentBytes,bytes);assert.equal(result.totalBytes,bytes+fs.statSync(path.join(f.out,'package-manifest.json')).size);
  for(const name of ['THIRD_PARTY_NOTICES.md','README.md','local-speech.mjs','local-speech.d.ts'])assert.ok(manifest.files.some(file=>file.path===name));
  assert.deepEqual(fs.readdirSync(path.join(f.out,'licenses')).sort(),['onnxruntime.txt','silero-vad.txt','whisper.txt']);
  assert.deepEqual(fs.readdirSync(path.dirname(f.out)),['local-speech']);
});
test('rebuilding a smaller selection removes stale models without touching siblings',t=>{
  const f=fixture(t);f.build();f.write('dist/host-owned.txt','keep');
  f.build(['small']);assert.equal(fs.existsSync(path.join(f.out,'models/whisper_tiny')),false);
  assert.equal(fs.readFileSync(path.join(f.root,'dist/host-owned.txt'),'utf8'),'keep');
  const manifest=JSON.parse(fs.readFileSync(path.join(f.out,'evidence/model-manifest.json')));assert.ok(manifest.every(entry=>['small','vad','context'].includes(entry.model)));
});
test('required model, VAD and context omissions fail before changing prior distribution',t=>{
  const f=fixture(t);f.build();const previous=fs.readFileSync(path.join(f.out,'package-manifest.json'));
  for(const missing of ['small/encoder.onnx','vad/silero_vad.onnx','context/ru-bpe.vocab']){
    f.saveManifest(f.entries.filter(entry=>entry.model+'/'+entry.file!==missing));assert.throws(()=>f.build(),/Missing required manifest asset/);
    assert.deepEqual(fs.readFileSync(path.join(f.out,'package-manifest.json')),previous);
  }
});
test('strict manifest rejects traversal, duplicates and malformed hashes/lengths',t=>{
  const f=fixture(t),first=f.entries[0];
  for(const entries of [null,[...f.entries,first],[{...first,file:'../../outside'}],[{...first,model:'../small'}],[{...first,bytes:0}],[{...first,bytes:1.5}],[{...first,sha256:'bad'}]]){
    f.saveManifest(entries);assert.throws(()=>f.build(),/manifest/i);assert.equal(fs.existsSync(f.out),false);
  }
});
test('corrupted weight or missing mandatory notices leave prior build intact',t=>{
  const f=fixture(t);f.build();const previous=fs.readFileSync(path.join(f.out,'package-manifest.json'));
  fs.unlinkSync(path.join(f.root,'sdk/THIRD_PARTY_NOTICES.md'));assert.throws(()=>f.build(),/THIRD_PARTY_NOTICES/);
  f.write('sdk/THIRD_PARTY_NOTICES.md','notice');f.write('models/small/encoder.onnx','corrupt');assert.throws(()=>f.build(),/integrity mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(f.out,'package-manifest.json')),previous);
});
test('unowned directories, symlinks and ancestor output paths are never replaced',t=>{
  const f=fixture(t);f.write('dist/local-speech/user.txt','keep');assert.throws(()=>f.build(),/ownership manifest/);
  assert.equal(fs.readFileSync(path.join(f.out,'user.txt'),'utf8'),'keep');
  fs.renameSync(f.out,f.out+'-user');fs.symlinkSync(f.out+'-user',f.out);assert.throws(()=>f.build(),/symlink/);
  assert.throws(()=>buildSDK({projectRoot:f.root,outputRoot:f.root,models:['small']}),/project root/);
});
test('failed publish restores the prior owned package and removes only staging output',t=>{
  const f=fixture(t);f.build();const previous=fs.readFileSync(path.join(f.out,'package-manifest.json'));
  const rename=fs.renameSync;fs.renameSync=(source,destination)=>{if(path.basename(source).startsWith('.local-speech-stage-'))throw Error('simulated publish failure');return rename(source,destination);};
  try{assert.throws(()=>f.build(['small']),/simulated publish failure/);}finally{fs.renameSync=rename;}
  assert.deepEqual(fs.readFileSync(path.join(f.out,'package-manifest.json')),previous);
  assert.ok(fs.existsSync(path.join(f.out,'models/whisper_tiny')));
  assert.deepEqual(fs.readdirSync(path.dirname(f.out)),['local-speech']);
});
test('legacy generated package migrates to explicit ownership marker',t=>{
  const f=fixture(t);f.build();const file=path.join(f.out,'package-manifest.json'),manifest=JSON.parse(fs.readFileSync(file));delete manifest.package;manifest.version='0.1.0';fs.writeFileSync(path.join(f.out,'local-speech.js'),'/* LocalSpeech 0.1.0; host locally; */');fs.writeFileSync(file,JSON.stringify(manifest));
  f.build(['small']);assert.equal(JSON.parse(fs.readFileSync(file)).package,'local-speech-sdk');
});
test('CLI rejects duplicate flags and unsupported model selections',t=>{
  const f=fixture(t);assert.equal(parseArgs([]),undefined);assert.deepEqual(parseArgs(['--models=small']),['small']);
  for(const args of [['--models=small','--models=whisper'],['--output=/tmp']])assert.throws(()=>parseArgs(args),/Usage/);
  for(const models of [[],['small','small'],['unknown'],['../small'],null])assert.throws(()=>buildSDK({projectRoot:f.root,outputRoot:f.out,models}));
});

test('runtime-only distribution needs no weights and uses the package version',t=>{
 const f=fixture(t);fs.rmSync(path.join(f.root,'models'),{recursive:true});
 f.write('sdk/local-speech.js',"globalThis.LocalSpeech={version:'__LOCAL_SPEECH_VERSION__'};");
 buildSDK({projectRoot:f.root,outputRoot:f.out,models:['small'],runtimeOnly:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(f.out,'package-manifest.json')));
 assert.equal(manifest.version,require('../package.json').version);assert.equal(manifest.weightsIncluded,false);
 assert.ok(!manifest.files.some(x=>x.path.startsWith('models/')));
 const ctx={};require('node:vm').runInNewContext(fs.readFileSync(path.join(f.out,'local-speech.js'),'utf8'),ctx);
 assert.equal(ctx.LocalSpeech.version,manifest.version);
 assert.ok(JSON.parse(fs.readFileSync(path.join(f.out,'evidence/model-manifest.json'))).length>0);
});
