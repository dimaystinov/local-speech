"""Validate paired completeness and summarize independently run ASR candidates."""
import argparse,importlib.util,json,statistics
from pathlib import Path
spec=importlib.util.spec_from_file_location('scorer',Path(__file__).with_name('score-public-cascade.py'))
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
def summarize(reports):
 if not reports or any(not r.get('complete') for r in reports.values()):raise ValueError('Incomplete run')
 first=next(iter(reports.values()));ids=[r['id'] for r in first['rows']]
 if len(ids)!=len(set(ids)):raise ValueError('Duplicate cases')
 result={}
 for name,r in reports.items():
  if r['corpusSHA256']!=first['corpusSHA256'] or [x['id'] for x in r['rows']]!=ids:raise ValueError('Unpaired corpus')
  for x,y in zip(first['rows'],r['rows']):
   if (x['reference'],x['words'],x['audioSeconds'])!=(y['reference'],y['words'],y['audioSeconds']):raise ValueError('Unpaired scoring')
  result[name]=dict(s.metrics(r['rows']),modelBytes=r['modelBytes'],mlxPeakMemoryBytes=r['mlxPeakMemoryBytes'],processPeakRSSBytes=r['processPeakRSSBytes'],loadWarmupSeconds=r['loadWarmupSeconds'],prefixProbeMedianSeconds=statistics.median(x['computeSeconds'] for x in r['prefixProbes']),prefixProbes=r['prefixProbes'])
 return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('directory',type=Path);a=p.parse_args()
 reports={name:json.loads((a.directory/(name+'.json')).read_text()) for name in ['codeswitch','qwen06','qwen17','parakeet']}
 result=summarize(reports)
 for name,original in reports.items():
  repeat_path=a.directory/(name+'-repeat.json')
  if repeat_path.exists():
   repeated=json.loads(repeat_path.read_text());summary=summarize({'original':original,'repeat':repeated})['repeat']
   result[name]['repeat']=dict(werPercent=summary['werPercent'],computeSeconds=summary['computeSeconds'],medianSeconds=summary['medianSeconds'],p95Seconds=summary['p95Seconds'],mlxPeakMemoryBytes=summary['mlxPeakMemoryBytes'],processPeakRSSBytes=summary['processPeakRSSBytes'],loadWarmupSeconds=summary['loadWarmupSeconds'],sameHypotheses=sum(x['hypothesis']==y['hypothesis'] for x,y in zip(original['rows'],repeated['rows'])))
 (a.directory/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 for k,v in result.items():print(k,json.dumps({x:y for x,y in v.items() if x!='prefixProbes'},ensure_ascii=False))
