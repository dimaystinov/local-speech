"""Optional offline Whisper word confidence and bounded RU/EN term recheck.
Scores are model probabilities, NOT calibrated transcription accuracy or language probabilities.
"""
import base64, difflib, json, math, os, re, sys, time
WORD=re.compile(r"[\w]+(?:[-'][\w]+)*",re.UNICODE)
def norm(s):return s.casefold().replace('ё','е')
def probability(p):
 return float(p) if isinstance(p,(int,float)) and not isinstance(p,bool) and math.isfinite(p) and 0<=p<=1 else None

def flatten(words):
 result=[]
 for w in words:
  pieces=list(WORD.finditer(w['word']))
  for x in pieces:result.append({'word':x.group(),'probability':probability(w.get('probability')) if len(pieces)==1 else None})
 return result

def select(original,baseline,candidate,terms):
 spans=list(WORD.finditer(original)); old=[x.group() for x in spans]; a=flatten(baseline); b=flatten(candidate)
 scores=[None]*len(old)
 # Attach evidence only to identical aligned words; never assign another hypothesis's score.
 for op,i,j,k,l in difflib.SequenceMatcher(None,list(map(norm,old)),[norm(x['word']) for x in a],autojunk=False).get_opcodes():
  if op=='equal':
   for x,y in zip(range(i,j),range(k,l)):scores[x]=a[y]['probability']
 allowed={norm(t) for t in terms if re.fullmatch(r'[A-Za-z][A-Za-z0-9-]{1,79}',t)}
 replacements={}
 if len(a)==len(b)==len(old):
  changed=[i for i in range(len(old)) if norm(old[i])!=norm(b[i]['word'])]
  if 0<len(changed)<=2:
   for i in changed:
    p=scores[i];q=b[i]['probability'];target=b[i]['word']
    if (norm(old[i])==norm(a[i]['word']) and p is not None and p<.5 and q is not None and q>=.85 and q-p>=.35
        and norm(target) in allowed and not any(c.isdigit() for c in old[i]+target)
        and norm(old[i]) not in {'не','нет','нельзя','not','no','never'}):replacements[i]=target
 text=original
 for i,target in sorted(replacements.items(),reverse=True):text=text[:spans[i].start()]+target+text[spans[i].end():]
 return {'text':text,'original':original,'words':[{'word':w,'probability':scores[i],'calibrated':False,'language':None} for i,w in enumerate(old)],'changes':[{'index':i,'from':old[i],'to':v} for i,v in replacements.items()]}

def recognize(model,audio,original,terms,budget=2.5):
 start=time.monotonic()
 def decode(beam,prompt=None):
  segments,info=model.transcribe(audio,language=None,task='transcribe',beam_size=beam,best_of=1,temperature=0,word_timestamps=True,condition_on_previous_text=False,initial_prompt=prompt,vad_filter=False)
  words=[{'word':w.word,'probability':w.probability,'start':w.start,'end':w.end} for s in segments for w in (s.words or [])]
  return words,info.language
 baseline,lang=decode(1); first=time.monotonic()-start
 if original is None:original=''.join(w['word'] for w in baseline).strip()
 result=select(original,baseline,[],terms);result.update(baseline=baseline,detectedLanguage=lang,firstPassSeconds=first,rechecked=False)
 # No second model, no parallel decodes; skip expensive reruns and unsupported languages.
 if terms and lang in ('ru','en') and first<budget and any(w['probability'] is not None and w['probability']<.5 for w in result['words']):
  candidate,_=decode(3,', '.join(terms));result.update(select(original,baseline,candidate,terms));result['candidate']=candidate;result['rechecked']=True
 result['elapsedSeconds']=time.monotonic()-start
 return result

def main():
 os.environ['HF_HUB_OFFLINE']='1';os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
 import numpy as np
 from faster_whisper import WhisperModel
 if len(sys.argv)!=2 or not os.path.isdir(sys.argv[1]):raise ValueError('Existing local model directory required')
 data=json.loads(sys.stdin.buffer.read(8*1024*1024+1));rate=data['rate'];original=data['original'];terms=data.get('terms',[])
 if not isinstance(rate,(int,float)) or not math.isfinite(rate) or not 8000<=rate<=96000 or int(rate)!=rate or not isinstance(original,str) or len(original)>2000 or not isinstance(terms,list) or len(terms)>32 or any(not isinstance(t,str) or len(t)>80 for t in terms):raise ValueError('Invalid request')
 audio=np.frombuffer(base64.b64decode(data['audio'],validate=True),dtype='<f4')
 if not 0<len(audio)<=rate*12 or not np.isfinite(audio).all() or np.max(np.abs(audio))>1:raise ValueError('Invalid PCM')
 if rate!=16000:
  import av
  frame=av.AudioFrame.from_ndarray(audio.reshape(1,-1),format='flt',layout='mono');frame.sample_rate=int(rate)
  resampler=av.AudioResampler(format='flt',layout='mono',rate=16000)
  converted=resampler.resample(frame)+resampler.resample(None)
  audio=np.concatenate([f.to_ndarray().reshape(-1) for f in converted])
 model=WhisperModel(sys.argv[1],device='cpu',compute_type='int8',cpu_threads=2,num_workers=1,local_files_only=True)
 print(json.dumps(recognize(model,audio,original,terms),ensure_ascii=False,allow_nan=False))
if __name__=='__main__':main()
