"""Compare the glossary extension against unchanged confidence-only policy.

Input is an actual complete cascade run. Old-policy output is replayed from the
same Qwen hypotheses; old-policy wall time is not measured by this scorer.
"""
import argparse,hashlib,importlib.util,json,math
from pathlib import Path
s=importlib.util.spec_from_file_location('score',Path(__file__).with_name('score-gigaam-qwen.py'));score=importlib.util.module_from_spec(s);s.loader.exec_module(score);c=score.g

def summarize(report,without='glossary'):
 if not report.get('complete') or not report['rows'] or len(report['rows'])!=len(report['pairs']):raise ValueError('Complete paired run required')
 policy=report['policy'];excluded={'glossary'} if without=='glossary' else {'foreignReview','maxForeignWords','phoneticThreshold'};previous={k:v for k,v in policy.items() if k not in excluded};old=[];new=[];groups={};extra=0;changed_confident=0
 ids=[r['id'] for r in report['rows']]
 if len(ids)!=len(set(ids)):raise ValueError('Duplicate IDs')
 for actual,p in zip(report['rows'],report['pairs']):
  if actual['id']!=p['case']['id']:raise ValueError('Pairing mismatch')
  old_route=c.route(p['draft'],previous);new_route=c.route(p['draft'],policy)
  if old_route and not new_route:raise ValueError('Missing baseline acoustic inference')
  row=c.score(p['case'],p['draft'],p['qwen'],policy,p['seconds']);baseline=c.score(p['case'],p['draft'],p['qwen'],previous,p['seconds'])
  if row!=actual:raise ValueError('Code replay differs from actual inference output')
  old.append(baseline);new.append(row)
  if new_route and not old_route:extra+=p['qwen']['seconds']
  if row['hypothesis']!=baseline['hypothesis'] and not old_route:changed_confident+=1
  groups.setdefault(p['case']['variant'],[]).append((baseline,row))
 def comparison(pairs):
  words=sum(y['words'] for x,y in pairs);be=sum(x['errors'] for x,y in pairs);ne=sum(y['errors'] for x,y in pairs)
  return dict(files=len(pairs),words=words,oldErrors=be,newErrors=ne,oldWER=100*be/words,newWER=100*ne/words,improved=sum(y['errors']<x['errors'] for x,y in pairs),regressed=sum(y['errors']>x['errors'] for x,y in pairs),previouslyMatchedWordsLost=sum(len(score.matched_reference_indices(x['reference'],x['hypothesis'])-score.matched_reference_indices(y['reference'],y['hypothesis'])) for x,y in pairs))
 times=sorted(r['totalSeconds'] for r in new)
 return dict(comparison=comparison(list(zip(old,new))),groups={k:comparison(v) for k,v in groups.items()},gigaamWER=c.metrics(new)['baseWERPercent'],actualTotalSeconds=sum(times),actualFinalMedianSeconds=times[len(times)//2],actualFinalP95Seconds=times[math.ceil(len(times)*.95)-1],draftSeconds=sum(r['draftSeconds'] for r in new),audioSeconds=sum(r['audioSeconds'] for r in new),extraQwenComputeSeconds=extra,confidentOnlyChangedFiles=changed_confident,routedAudioFraction=c.metrics(new)['routedFraction'],productionReady=False,limitation='No production promotion: synthetic term evidence and public general code-switching do not establish real technical-call accuracy or streaming latency.')

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--without',choices=['glossary','foreign'],default='glossary');p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 result=summarize(json.loads(a.input.read_text()),a.without);result['inputSHA256']=hashlib.sha256(a.input.read_bytes()).hexdigest();c.pilot.write_json(a.output,result);print(json.dumps(result,indent=2))
