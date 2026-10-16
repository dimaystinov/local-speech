"""Paired scoring for extra models; historical baselines keep their original timing context."""
import argparse,importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('score',Path(__file__).with_name('score-asr-alternatives.py'));score=importlib.util.module_from_spec(spec);spec.loader.exec_module(score)
def main():
 p=argparse.ArgumentParser();p.add_argument('directory',type=Path);p.add_argument('--baseline',type=Path,required=True);a=p.parse_args()
 paths={name:a.baseline/(name+'.json') for name in ['codeswitch','qwen06','qwen17','parakeet']}
 paths.update(gigaam=a.directory/'gigaam-manual.json')
 reports={name:json.loads(path.read_text()) for name,path in paths.items()};result=score.summarize(reports)
 for name,path in paths.items():
  repeat_path=path.with_name(path.stem+'-repeat.json');r=reports[name]
  if not repeat_path.exists():
   result[name]['repeat']=None;result[name]['sameHypotheses']=None;continue
  repeat=json.loads(repeat_path.read_text())
  comparison=score.summarize({'first':r,'repeat':repeat})
  result[name]['repeat']={k:v for k,v in comparison['repeat'].items() if k!='prefixProbes'}
  result[name]['sameHypotheses']=sum(x['hypothesis']==y['hypothesis'] for x,y in zip(r['rows'],repeat['rows']))
  for key in ['mpsSampledAllocatedMaxBytes','mpsSampledDriverMaxBytes']:
   if key in r:result[name][key]=max(r[key],repeat[key])
 screen=json.loads((a.directory/'voxtral.json').read_text())
 n=10
 if len(screen['rows'])<n:raise ValueError('Incomplete ten-file screening')
 selected=screen['rows'][:n];base=reports['codeswitch']['rows'][:n]
 if screen['corpusSHA256']!=reports['codeswitch']['corpusSHA256']:raise ValueError('Screen corpus mismatch')
 for x,y in zip(base,selected):
  if (x['id'],x['reference'],x['words'],x['audioSeconds'])!=(y['id'],y['reference'],y['words'],y['audioSeconds']):raise ValueError('Screen pairing mismatch')
 screening={name:score.s.metrics(r['rows'][:n]) for name,r in reports.items()}
 screening['voxtral']=score.s.metrics(selected)
 result['voxtralScreening']=dict(scope='First ten files only; full run interrupted after runtime screening, not a complete corpus result',models=screening,modelBytes=screen['modelBytes'],mlxPeakMemoryBytes=screen['mlxPeakMemoryBytes'],processPeakRSSBytes=screen['processPeakRSSBytes'],transcriptionDelayMs=screen['transcriptionDelayMs'])
 result['limitations']=['Baseline timings come from preceding experiment, not interleaved runs.','GigaAM SDPA path failed reproducibility; reported result uses explicit attention.','Memory counter semantics differ between MPS sampled and MLX allocated peaks.','No real-time microphone or overlapping-call validation.']
 (a.directory/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 for name,r in result.items():
  if isinstance(r,dict) and 'werPercent' in r:print(name,r['werPercent'],r['groups']['mixed']['werPercent'],r['computeSeconds'],r['repeat']['computeSeconds'] if r['repeat'] else None,r['sameHypotheses'])
if __name__=='__main__':main()
