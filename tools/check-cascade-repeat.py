"""Reject unstable acoustic repeats before comparing quality or timing."""
import argparse,json
from pathlib import Path

def compare(first,second):
 if not first.get('complete') or not second.get('complete'):raise ValueError('Complete runs required')
 for key in ['corpusSHA256','gigaam','qwen','split','policy']:
  if first.get(key)!=second.get(key):raise ValueError('Incompatible '+key)
 def indexed(report):
  pairs=report['pairs'];result={p['case']['id']:p for p in pairs}
  if not pairs or len(result)!=len(pairs):raise ValueError('Missing or duplicate cases')
  return result
 a,b=indexed(first),indexed(second)
 if a.keys()!=b.keys():raise ValueError('Unpaired IDs')
 draft=[];qwen=[];output=[]
 ar={r['id']:r for r in first['rows']};br={r['id']:r for r in second['rows']}
 if ar.keys()!=a.keys() or br.keys()!=b.keys():raise ValueError('Unpaired output')
 for key in a:
  x,y=a[key],b[key]
  if x['case']!=y['case']:raise ValueError('Case changed: '+key)
  if x['draft']['hypothesis']!=y['draft']['hypothesis']:draft.append(key)
  if x.get('qwen',{}).get('hypothesis')!=y.get('qwen',{}).get('hypothesis'):qwen.append(key)
  if ar[key]['hypothesis']!=br[key]['hypothesis']:output.append(key)
 return dict(files=len(a),passed=not(draft or qwen or output),draftChanged=draft,qwenChanged=qwen,outputChanged=output,limitation='Exact text parity on this corpus only; not a proof of numerical or streaming stability.')

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('first',type=Path);p.add_argument('second',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 result=compare(json.loads(a.first.read_text()),json.loads(a.second.read_text()));a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));raise SystemExit(0 if result['passed'] else 1)
