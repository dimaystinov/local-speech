"""Calibrate OOV policy on explicitly supplied development reports only.

Previously inspected evaluation recordings can be development material, but the
next evaluation must be disjoint. No reference terms are used for routing.
"""
import argparse,importlib.util,json,time
from pathlib import Path
s=importlib.util.spec_from_file_location('s',Path(__file__).with_name('score-gigaam-qwen.py'));sc=importlib.util.module_from_spec(s);s.loader.exec_module(sc);c=sc.g

def fit(development,reviewed_public,full_public,base):
 if not all(r.get('complete') for r in [development,reviewed_public,full_public]):raise ValueError('Complete reports required')
 if development.get('split')!='development':raise ValueError('Expected original development partition')
 if reviewed_public['corpusSHA256']!=full_public['corpusSHA256']:raise ValueError('Unpaired acoustic baselines')
 full={r['id']:r for r in full_public['rows']}
 if len(full)!=len(full_public['rows']) or set(full)!={p['case']['id'] for p in reviewed_public['pairs']}:raise ValueError('Unpaired IDs')
 pairs=list(development['pairs'])
 for p in reviewed_public['pairs']:
  r=full[p['case']['id']]
  if r['reference']!=p['case']['reference']:raise ValueError('Reference mismatch')
  pairs.append(dict(p,qwen=dict(hypothesis=r['hypothesis'],seconds=sum(r['chunkSeconds']))))
 previous=[c.score(p['case'],p['draft'],p['qwen'],base,0) for p in pairs];baseline=c.metrics(previous);choices=[]
 for threshold in [.55,.65,.75]:
  for limit in [2,4,8]:
   policy=dict(base,foreignReview=True,phoneticThreshold=threshold,maxForeignWords=limit);start=time.monotonic();rows=[c.score(p['case'],p['draft'],p['qwen'],policy,0) for p in pairs];m=c.metrics(rows)
   m.update(regressedVsPrevious=sum(a['errors']>b['errors'] for a,b in zip(rows,previous)),matchedWordsLost=sum(len(sc.matched_reference_indices(b['reference'],b['hypothesis'])-sc.matched_reference_indices(a['reference'],a['hypothesis'])) for a,b in zip(rows,previous)),evaluationSeconds=time.monotonic()-start)
   choices.append(dict(policy=policy,metrics=m))
 eligible=[x for x in choices if x['metrics']['regressedVsPrevious']==0 and x['metrics']['matchedWordsLost']==0 and x['metrics']['routedFraction']<=.65 and x['metrics']['werPercent']<baseline['werPercent']]
 best=min(eligible,key=lambda x:(x['metrics']['werPercent'],x['metrics']['routedFraction'])) if eligible else dict(policy=base,metrics=baseline)
 return dict(candidates=choices,baseline=baseline,selected=best,method='Replay only; zero timing placeholders are not latency measurements; all supplied recordings are development.')

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__)
 for arg in ['development','reviewed-public','full-public','base-policy','output']:p.add_argument('--'+arg,type=Path,required=True)
 a=p.parse_args()
 if a.output.exists():raise ValueError('Refusing to replace frozen calibration')
 read=lambda x:json.loads(x.read_text());result=fit(read(a.development),read(a.reviewed_public),read(a.full_public),read(a.base_policy));c.pilot.write_json(a.output,result)
 print(json.dumps(result['selected']['metrics'],indent=2))
