"""Isolated Metal ASR comparison on frozen human holdout, without reference prompts."""
import argparse, hashlib, importlib.util, json, os, resource, time
from pathlib import Path
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
import numpy as np
import mlx.core as mx
spec=importlib.util.spec_from_file_location('bench',Path(__file__).with_name('benchmark-ruen-gpu.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)

def main():
 p=argparse.ArgumentParser();p.add_argument('--model',type=Path,required=True);p.add_argument('--backend',choices=['qwen','parakeet','whisper','voxtral'],required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--corpus',type=Path,required=True);a=p.parse_args()
 if a.output.exists():raise ValueError('Output exists')
 if not mx.metal.is_available():raise RuntimeError('Metal unavailable')
 mx.set_default_device(mx.gpu);mx.random.seed(0)
 cases=[r for r in json.loads(a.corpus.read_text())['cases'] if r['split']=='holdout']
 start=time.monotonic()
 if a.backend=='whisper':
  import mlx_whisper
  def infer(audio):return mlx_whisper.transcribe(audio,path_or_hf_repo=str(a.model.resolve()),language=None,task='transcribe',temperature=0.0,fp16=True,condition_on_previous_text=False,without_timestamps=True,verbose=None)['text'].strip()
 else:
  from mlx_audio.stt import load
  model=load(str(a.model.resolve()))
  def infer(audio):
   kw=dict(max_tokens=2048,temperature=0.0,language=None) if a.backend=='qwen' else {}
   if a.backend=='voxtral':kw=dict(max_tokens=2048,temperature=0.0,transcription_delay_ms=480)
   return model.generate(mx.array(audio),**kw).text.strip()
 infer(np.zeros(16000,dtype=np.float32));mx.synchronize()
 report=dict(complete=False,backend=a.backend,model=str(a.model.resolve()),device=str(mx.default_device()),loadWarmupSeconds=time.monotonic()-start,corpusSHA256=hashlib.sha256(a.corpus.read_bytes()).hexdigest(),modelBytes=sum(f.stat().st_size for f in a.model.rglob('*') if f.is_file()),rows=[],prefixProbes=[],method='Sequential whole-file warm inference, audio preloaded; not live microphone latency. Prefix probes are fresh decodes, not incremental cache.')
 if a.backend=='voxtral':report['transcriptionDelayMs']=480
 def save():
  report['mlxPeakMemoryBytes']=mx.get_peak_memory();report['processPeakRSSBytes']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
  b.pilot.write_json(a.output,report)
 for r in cases:
  audio=b.audio_file(r);mx.synchronize();t=time.monotonic();text=infer(audio);mx.synchronize();elapsed=time.monotonic()-t
  e,n=b.pilot.errors(r['reference'],text);tokens=b.pilot.normalized(text);terms=r.get('terms',[])
  matched=sum(any(tokens[i:i+len(b.pilot.normalized(term))]==b.pilot.normalized(term) for i in range(len(tokens))) for term in terms)
  report['rows'].append(dict(id=r['id'],language=r['language'],group=r['group'],reference=r['reference'],hypothesis=text,errors=e,words=n,terms=len(terms),matchedTerms=matched,audioSeconds=len(audio)/16000,chunkSeconds=[elapsed]))
  save();print(len(report['rows']),r['id'],e,n,round(elapsed,3),flush=True)
 # Fixed first three mixed cases; no selection using predictions.
 for r in [r for r in cases if r['language']=='mixed'][:3]:
  audio=b.audio_file(r)
  for seconds in (2,4,8):
   chunk=audio[:seconds*16000];mx.synchronize();t=time.monotonic();text=infer(chunk);mx.synchronize()
   report['prefixProbes'].append(dict(id=r['id'],audioSeconds=len(chunk)/16000,computeSeconds=time.monotonic()-t,hypothesis=text));save()
 report['complete']=True;save()
if __name__=='__main__':main()
