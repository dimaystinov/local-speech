"""GigaAM Multilingual CTC: CPU spectral frontend, MPS encoder/head, CPU greedy CTC.

Uses pinned, locally reviewed modeling_gigaam.py. No remote code/network at runtime.
Memory counters are sampled every 20ms (not exact allocator peaks).
"""
import argparse,hashlib,importlib.util,json,os,resource,sys,threading,time
from pathlib import Path
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
import numpy as np
import torch
spec=importlib.util.spec_from_file_location('bench',Path(__file__).with_name('benchmark-ruen-gpu.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
def collapse_ctc(labels,blank):
 out=[];last=None
 for x in labels:
  if x!=last and x!=blank:out.append(x)
  last=x
 return out

def main():
 p=argparse.ArgumentParser();p.add_argument('--model',type=Path,required=True);p.add_argument('--corpus',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--manual-attention',action='store_true');p.add_argument('--use-sdpa',dest='manual_attention',action='store_false');p.set_defaults(manual_attention=True);a=p.parse_args()
 if a.output.exists():raise ValueError('Output exists')
 if not torch.backends.mps.is_available():raise RuntimeError('MPS unavailable')
 torch.set_num_threads(4);torch.manual_seed(0)
 start=time.monotonic();sys.path.insert(0,str(a.model.resolve()))
 from modeling_gigaam import GigaAMModel
 model=GigaAMModel.from_pretrained(str(a.model.resolve()),local_files_only=True,weights_only=True).eval()
 core=model.model
 if a.manual_attention:
  for layer in core.encoder.layers:layer.self_attn.torch_sdpa_attn=False
 core.encoder.to('mps');core.head.to('mps')
 memory={'mpsSampledAllocatedMaxBytes':0,'mpsSampledDriverMaxBytes':0};stop=threading.Event()
 def sample():
  while not stop.is_set():
   memory['mpsSampledAllocatedMaxBytes']=max(memory['mpsSampledAllocatedMaxBytes'],torch.mps.current_allocated_memory())
   memory['mpsSampledDriverMaxBytes']=max(memory['mpsSampledDriverMaxBytes'],torch.mps.driver_allocated_memory());stop.wait(.02)
 thread=threading.Thread(target=sample,daemon=True);thread.start()
 @torch.inference_mode()
 def infer(audio):
  wav=torch.from_numpy(audio).unsqueeze(0);length=torch.tensor([len(audio)])
  features,lens=core.preprocessor(wav,length)
  encoded,lens=core.encoder(features.to('mps'),lens.to('mps'))
  logits=core.head(encoder_output=encoded)
  labels=logits.argmax(-1)[0,:int(lens[0])].cpu().tolist()
  return core.decoding.tokenizer.decode(collapse_ctc(labels,core.decoding.blank_id))
 try:
  infer(np.zeros(16000,dtype=np.float32));torch.mps.synchronize()
  report=dict(manualAttention=a.manual_attention,complete=False,backend='gigaam-mps',device='mps encoder/head; cpu frontend and CTC collapse',model=str(a.model.resolve()),loadWarmupSeconds=time.monotonic()-start,corpusSHA256=hashlib.sha256(a.corpus.read_bytes()).hexdigest(),modelBytes=sum(f.stat().st_size for f in a.model.rglob('*') if f.is_file()),rows=[],prefixProbes=[],mlxPeakMemoryBytes=None,method='Whole recordings using low-level encoder; no 25s API restriction; float32 MPS. CPU frontend included. Memory sampled 20ms, not exact peak.')
  def save():
   report.update(memory);report['processPeakRSSBytes']=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss;b.pilot.write_json(a.output,report)
  cases=[r for r in json.loads(a.corpus.read_text())['cases'] if r['split']=='holdout']
  for r in cases:
   audio=b.audio_file(r);torch.mps.synchronize();t=time.monotonic();text=infer(audio);torch.mps.synchronize();elapsed=time.monotonic()-t
   e,n=b.pilot.errors(r['reference'],text);tokens=b.pilot.normalized(text);terms=r.get('terms',[]);matched=sum(any(tokens[i:i+len(b.pilot.normalized(term))]==b.pilot.normalized(term) for i in range(len(tokens))) for term in terms)
   report['rows'].append(dict(id=r['id'],language=r['language'],group=r['group'],reference=r['reference'],hypothesis=text,errors=e,words=n,terms=len(terms),matchedTerms=matched,audioSeconds=len(audio)/16000,chunkSeconds=[elapsed]));save();print(len(report['rows']),r['id'],e,n,round(elapsed,3),flush=True)
  for r in [r for r in cases if r['language']=='mixed'][:3]:
   audio=b.audio_file(r)
   for seconds in (2,4,8):
    chunk=audio[:seconds*16000];torch.mps.synchronize();t=time.monotonic();text=infer(chunk);torch.mps.synchronize();report['prefixProbes'].append(dict(id=r['id'],audioSeconds=len(chunk)/16000,computeSeconds=time.monotonic()-t,hypothesis=text));save()
  report['complete']=True;save()
 finally:stop.set();thread.join()
if __name__=='__main__':main()
