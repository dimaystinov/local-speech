"""Opt-in OOV routing and phonetic confirmation; no language probabilities.

Unknown Russian word != English. Accept only an independently recognized lowercase
Latin word with similar pronunciation and nearby unchanged text. Keep the draft
when morphology or the optional phonemizer cannot support a decision.
"""
import functools,re,shutil,subprocess

@functools.lru_cache(maxsize=1)
def morphology():
 import pymorphy3
 return pymorphy3.MorphAnalyzer()

@functools.lru_cache(maxsize=8192)
def unknown(word):
 return bool(re.fullmatch('[а-яё]{4,24}',word)) and not morphology().word_is_known(word)

def indices(text):
 return [i for i,w in enumerate(re.findall(r'[^\W_]+',text.lower(),re.UNICODE)) if unknown(w)]

@functools.lru_cache(maxsize=4096)
def phones(text,language):
 if not re.fullmatch(r'[A-Za-zА-Яа-яЁё]{4,24}',text):return ''
 exe=shutil.which('espeak-ng')
 if not exe:return ''
 try:
  result=subprocess.run([exe,'-q','--ipa','-v',language,'--stdin'],input=text+'\n',text=True,capture_output=True,timeout=.5,check=True)
 except (OSError,subprocess.SubprocessError):return ''
 # Broad phonetic equivalences, not a learned or calibrated similarity model.
 mapping=str.maketrans({'ɹ':'r','ɭ':'l','ɫ':'l','ɚ':'a','æ':'a','ʌ':'a','ə':'a','ɐ':'a','ɒ':'o','ɪ':'i','ʊ':'u','ɛ':'e','ɜ':'e','ɨ':'i'})
 return ''.join(x for x in re.sub(r'\([a-z-]+\)','',result.stdout).translate(mapping) if x.isalpha() and x not in 'ʲːˈˌ')

def similarity(a,b):
 if not a or not b:return 0.
 prior=list(range(len(b)+1))
 for i,x in enumerate(a,1):
  current=[i]
  for j,y in enumerate(b,1):current.append(min(current[-1]+1,prior[j]+1,prior[j-1]+(x!=y)))
  prior=current
 return 1-prior[-1]/max(len(a),len(b))

def confirmed_edits(original,candidate,threshold=.65):
 aa=list(re.finditer(r'[^\W_]+',original,re.UNICODE));bb=list(re.finditer(r'[^\W_]+',candidate,re.UNICODE))
 at=[m.group().lower().replace('ё','е') for m in aa];bt=[m.group().lower().replace('ё','е') for m in bb];edits=[]
 for i in indices(original):
  # Repeated source spellings and proper-name looking candidate tokens abstain.
  if at.count(at[i])!=1:continue
  candidates=[]
  for j in range(max(0,i-3),min(len(bb),i+4)):
   word=bb[j].group()
   if not re.fullmatch('[a-z]{4,24}',word) or bt.count(bt[j])!=1:continue
   left=set(at[max(0,i-3):i])&set(bt[max(0,j-3):j]);right=set(at[i+1:i+4])&set(bt[j+1:j+4])
   if not (left or right):continue
   score=similarity(phones(aa[i].group(),'ru'),phones(word,'en-us'))
   if score>=threshold:candidates.append((score,j,word))
  candidates.sort(reverse=True)
  if not candidates or (len(candidates)>1 and candidates[0][0]-candidates[1][0]<.15):continue
  _,j,word=candidates[0];edits.append((aa[i].start(),aa[i].end(),word))
 # A single acoustic token cannot confirm two separate source words.
 return [e for e in edits if sum(x[2]==e[2] for x in edits)==1]
