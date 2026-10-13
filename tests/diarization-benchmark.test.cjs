'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');

test('acoustic fixture transforms preserve declared duration and RMS SNR',(t)=>{
  const result=spawnSync('python3',['-c',`
import importlib.util, numpy as np
spec=importlib.util.spec_from_file_location('fixtures','tools/benchmark-diarization-fixtures.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
x=.02*np.sin(np.arange(16000*6)*2*np.pi*220/16000)
assert len(m.crop(x,2))==32000
for snr in [20,10,0]:
 y=m.noisy(x,snr,np.random.default_rng(99))
 assert np.isfinite(y).all() and np.max(np.abs(y))<=1
 measured=20*np.log10(np.sqrt(np.mean(x*x))/np.sqrt(np.mean((y-x)**2)))
 assert abs(measured-snr)<1e-8,(snr,measured)
 assert np.array_equal(y,m.noisy(x,snr,np.random.default_rng(99)))
assert np.array_equal(m.noisy(x,None,np.random.default_rng(99)),x)
try:m.crop(x,20);raise AssertionError('short crop accepted')
except ValueError:pass
`],{cwd:root,encoding:'utf8'});
  if(result.status!==0&&/No module named '(numpy|scipy)'/.test(result.stderr))return t.skip('Optional benchmark requires Python numpy/scipy');
  assert.equal(result.status,0,result.stderr);
});

test('fixture generator has disjoint enrollment, development and holdout scripts',(t)=>{
  const result=spawnSync('python3',['-c',`
import importlib.util
spec=importlib.util.spec_from_file_location('fixtures','tools/benchmark-diarization-fixtures.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert len(m.VOICES)>=6 and len([v for v in m.VOICES if not v[2]])>=3
for language,scripts in m.TEXTS.items():
 assert len(scripts)==3 and len(set(scripts))==3
 assert all(len(s)>100 for s in scripts)
`],{cwd:root,encoding:'utf8'});
  if(result.status!==0&&/No module named '(numpy|scipy)'/.test(result.stderr))return t.skip('Optional benchmark requires Python numpy/scipy');
  assert.equal(result.status,0,result.stderr);
});

async function fingerprintFixture(){
  const crypto=require('node:crypto');
  const api=await import('../tools/benchmark-diarization.mjs');
  const payload=new Map(),files=[];
  for(const [source,folder] of [['model','speaker-wespeaker'],['segmentation','segmentation-pyannote']]){
    for(const file of ['config.json','preprocessor_config.json','onnx/model_quantized.onnx']){
      const name=`models/${folder}/${file}`,bytes=Buffer.from(name);
      payload.set(name,bytes);files.push({source,path:name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
    }
  }
  const manifest={runtime:{package:'@huggingface/transformers',version:'3.8.1'},model:{revision:'first'},segmentation:{revision:'first'},files};
  const options={manifest,runtimeMetadata:{name:'@huggingface/transformers',version:'3.8.1'},runtimeSource:Buffer.from('native-runtime-source'),readAsset:name=>payload.get(name),inferenceCodeDigest:'one',nativeRuntimeMetadata:{name:'onnxruntime-node',version:'1'}};
  return {api,payload,options,crypto};
}

test('inference cache fingerprint changes with verified preprocessing, runtime and evaluator code',async()=>{
  const {api,payload,options,crypto}=await fingerprintFixture();
  const baseline=api.createInferenceFingerprint(options);
  assert.equal(api.createInferenceFingerprint(options),baseline);
  assert.notEqual(api.createInferenceFingerprint({...options,runtimeSource:Buffer.from('new native runtime')}),baseline);
  assert.notEqual(api.createInferenceFingerprint({...options,inferenceCodeDigest:'two'}),baseline);
  assert.notEqual(api.createInferenceFingerprint({...options,nativeRuntimeMetadata:{name:'onnxruntime-node',version:'2'}}),baseline);
  const entry=options.manifest.files.find(e=>e.path.endsWith('preprocessor_config.json'));
  const changed=Buffer.from('changed valid pinned preprocessing');payload.set(entry.path,changed);
  assert.throws(()=>api.createInferenceFingerprint(options),/integrity mismatch/);
  entry.bytes=changed.length;entry.sha256=crypto.createHash('sha256').update(changed).digest('hex');
  assert.notEqual(api.createInferenceFingerprint(options),baseline);
});

test('benchmark rejects unpinned runtime, modified weights and unsafe/incomplete asset inventory',async()=>{
  const {api,payload,options}=await fingerprintFixture();
  assert.throws(()=>api.createInferenceFingerprint({...options,runtimeMetadata:{name:'@huggingface/transformers',version:'4.0.0'}}),/version mismatch/);
  assert.throws(()=>api.createInferenceFingerprint({...options,manifest:{...options.manifest,files:options.manifest.files.slice(1)}}),/Incomplete/);
  const first=options.manifest.files[0];
  assert.throws(()=>api.createInferenceFingerprint({...options,manifest:{...options.manifest,files:[{...first,path:'../../secret'},...options.manifest.files.slice(1)]}}),/Invalid pinned/);
  const weight=options.manifest.files.find(e=>e.path.endsWith('.onnx'));payload.set(weight.path,Buffer.from('tampered'));
  assert.throws(()=>api.createInferenceFingerprint(options),/integrity mismatch/);
});

test('experimental RMS override works with old/current helper and refuses ambiguous source',async()=>{
  const {applyExperimentalRms}=await import('../tools/benchmark-diarization.mjs');
  for(const gate of ['.003','.0005','0.0005']){
    const source=`const usable=Math.sqrt(energy/Math.max(1,audio.length))>=${gate}&&clipped/n<.01;`;
    assert.match(applyExperimentalRms(source,.0005),/>=0\.0005&&clipped/);
    assert.throws(()=>applyExperimentalRms(source+source,.0005),/source changed/);
  }
  assert.throws(()=>applyExperimentalRms('not the helper',.0005),/source changed/);
  assert.throws(()=>applyExperimentalRms('',0),/Invalid experimental/);
});

test('native inference cleanup disposes each input/output tensor once, including partial failure',async()=>{
  const {disposeTensors}=await import('../tools/benchmark-diarization.mjs');
  let inputs=0,outputs=0;
  const input={dispose(){inputs++;}},output={dispose(){outputs++;}};
  disposeTensors({input},{same:input,output});
  assert.equal(inputs,1);assert.equal(outputs,1);
  disposeTensors(undefined,{input},{metadata:123});
  assert.equal(inputs,2);
});
