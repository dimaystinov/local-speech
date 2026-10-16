"""Download pinned MLX ASR artifacts, checking Hub sizes/LFS hashes; no remote code."""
import argparse,hashlib,json,shutil,time,urllib.request
from pathlib import Path
MODELS={'qwen06':('mlx-community/Qwen3-ASR-0.6B-8bit','89e96d92ba34aca20b3e29fb10cc284097d1219f'),'qwen17':('mlx-community/Qwen3-ASR-1.7B-8bit','a8379a2e2f9e313c9292cdf1af4055ab56d50d55'),'parakeet':('mlx-community/parakeet-tdt-0.6b-v3','ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15')}
MODELS['voxtral'] = ('mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit', 'fdebf7b2af834a1db4b8a3c99ab7480b333adf9e')
MODELS['gigaam'] = ('ai-sage/GigaAM-Multilingual', '2f8a57144e6ec3adfd32fe0484d9ea9913305bc8')
def open_url(url):
 for attempt in range(6):
  try:return urllib.request.urlopen(url,timeout=120)
  except OSError:
   if attempt==5:raise
   time.sleep(2)
def main():
 p=argparse.ArgumentParser();p.add_argument('output',type=Path);p.add_argument('--only',choices=MODELS);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
 for key,(repo,revision) in MODELS.items():
  if a.only and key!=a.only:continue
  metadata=json.load(open_url(f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true'));destination=a.output/repo.split('/')[-1];destination.mkdir(exist_ok=True);files=[]
  for f in metadata['siblings']:
   name=f['rfilename']
   if name=='.gitattributes':continue
   target=destination/name
   if not target.resolve().is_relative_to(destination.resolve()):raise ValueError('Unsafe filename')
   target.parent.mkdir(parents=True,exist_ok=True)
   if not target.exists():
    print('Download',repo,name,flush=True)
    for attempt in range(6):
     try:
      with open_url(f'https://huggingface.co/{repo}/resolve/{revision}/{name}') as response,target.with_suffix('.part').open('wb') as out:shutil.copyfileobj(response,out)
      target.with_suffix('.part').replace(target);break
     except OSError:
      if attempt==5:raise
      time.sleep(2)
   with target.open('rb') as inp:digest=hashlib.file_digest(inp,'sha256').hexdigest()
   expected=f.get('lfs',{}).get('sha256')
   if f.get('size') is not None and target.stat().st_size!=f['size']:raise ValueError('Size mismatch: '+name)
   if expected and expected!=digest:raise ValueError('SHA256 mismatch: '+name)
   files.append(dict(file=name,bytes=target.stat().st_size,sha256=digest,hubLFSVerified=bool(expected)))
  (a.output/(destination.name+'-manifest.json')).write_text(json.dumps(dict(repo=repo,revision=revision,files=files),indent=2)+'\n');print('Verified',key,flush=True)
if __name__=='__main__':main()
