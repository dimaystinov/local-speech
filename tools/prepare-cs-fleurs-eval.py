"""Fetch a frozen local CS-FLEURS diagnostic slice through HF Dataset Viewer.

CC-BY-NC-4.0: no product training or data redistribution. Retain source metadata
and hashes locally. A viewer snapshot is not a pinned upstream Git revision.
Requires numpy, soundfile and scipy (ASR GPU benchmark environment).
"""
import argparse,concurrent.futures,hashlib,io,json,math,urllib.request
from pathlib import Path

def download(url):
 for attempt in range(3):
  try:
   with urllib.request.urlopen(url,timeout=20) as response:return response.read()
  except OSError:
   if attempt==2:raise

def main():
 import numpy as np,soundfile as sf
 from scipy.signal import resample_poly
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);p.add_argument('--metadata',type=Path);p.add_argument('--count',type=int,default=48);a=p.parse_args()
 if not 1<=a.count<=100:raise ValueError('count must be 1..100')
 root=a.output.resolve();root.mkdir(parents=True,exist_ok=True)
 if (root/'corpus.json').exists():raise ValueError('Frozen corpus already exists')
 url='https://datasets-server.huggingface.co/rows?dataset=YapayNet%2Fcs-fleurs-tagged&config=default&split=test&offset=0&length=100'
 raw=a.metadata.read_bytes() if a.metadata else download(url);(root/'rows-snapshot.json').write_bytes(raw)
 rows=[x['row'] for x in json.loads(raw)['rows']][:a.count]
 if len(rows)!=a.count or any(r['language_pair']!='rus-eng' for r in rows):raise ValueError('Unexpected source rows')
 def fetch(r):
  if not __import__('re').fullmatch(r'[A-Za-z0-9_-]+',r['id']):raise ValueError('Invalid source ID')
  path=root/(r['id']+'.wav');audio_bytes=download(r['audio'][0]['src']);audio,rate=sf.read(io.BytesIO(audio_bytes),dtype='float32',always_2d=True);audio=audio.mean(axis=1)
  if rate!=16000:
   divisor=math.gcd(rate,16000);audio=resample_poly(audio,16000//divisor,rate//divisor)
  sf.write(path,audio,16000,subtype='PCM_16')
  return dict(id='cs-fleurs-'+r['id'],file=str(path),sha256=hashlib.sha256(path.read_bytes()).hexdigest(),reference=r['text_plain'],terms=r['embedded_words'],language='mixed',variant='public-read',group='cs-fleurs-rus',split='holdout',durationSeconds=len(audio)/16000)
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:cases=list(pool.map(fetch,rows))
 result=dict(cases=cases,source=url,metadataSHA256=hashlib.sha256(raw).hexdigest(),license='CC-BY-NC-4.0; isolated evaluation; no redistribution or product training',limitation='Viewer snapshot and audio hashes; no verified speaker independence or pretraining exclusion')
 (root/'corpus.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print('cases',len(cases))
if __name__=='__main__':main()
