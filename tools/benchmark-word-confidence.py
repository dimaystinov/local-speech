"""Reproducible paired ASR experiment; references are used only after inference."""
import argparse,importlib.util,json,hashlib,time,wave
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--corpus',required=True);p.add_argument('--output',required=True);p.add_argument('--budget',type=float,default=2.5);p.add_argument('--limit',type=int,default=32);a=p.parse_args()
spec=importlib.util.spec_from_file_location('confidence',Path(__file__).with_name('word-confidence.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
model=WhisperModel(a.model,device='cpu',compute_type='int8',cpu_threads=2,num_workers=1,local_files_only=True)
cp=Path(a.corpus);cases=json.loads(cp.read_text())['cases'];rows=[]
# Fixed file order independent of recognition results.
for case in cases[:a.limit]:
 audiofile=(cp.parent/case['file']).resolve();sha=hashlib.sha256(audiofile.read_bytes()).hexdigest()
 if case.get('sha256') and case['sha256']!=sha:raise ValueError('Corpus integrity')
 audio=decode_audio(str(audiofile),sampling_rate=16000)
 terms=[t['canonical'] if isinstance(t,dict) else t for t in case.get('terms',[])][:32]
 start=time.monotonic();parts=[]
 for i in range(0,len(audio),6*16000):parts.append(c.recognize(model,audio[i:i+6*16000],None,terms,budget=a.budget))
 baseline=' '.join(p['original'] for p in parts);selected=' '.join(p['text'] for p in parts)
 rows.append({'id':case['id'],'reference':case['reference'],'language':case['language'],'sha256':sha,'baseline':baseline,'text':selected,'parts':parts,'elapsedSeconds':time.monotonic()-start})
 Path(a.output).write_text(json.dumps({'complete':False,'rows':rows},ensure_ascii=False,indent=2));print(case['id'],round(time.monotonic()-start,2),sum(len(p['changes']) for p in parts),flush=True)
Path(a.output).write_text(json.dumps({'complete':True,'rows':rows},ensure_ascii=False,indent=2))
