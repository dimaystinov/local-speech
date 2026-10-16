"""Validate actual cascade against paired single-model baselines and score it."""
import argparse,importlib.util,json,math
from pathlib import Path
s=importlib.util.spec_from_file_location('cascade',Path(__file__).with_name('gigaam-qwen-cascade.py'));g=importlib.util.module_from_spec(s);s.loader.exec_module(g)

def matched_reference_indices(reference,text):
    """Deterministic minimum-edit alignment; repeated-word ties remain ambiguous."""
    a=g.pilot.normalized(reference);b=g.pilot.normalized(text)
    d=[[0]*(len(b)+1) for _ in range(len(a)+1)]
    for i in range(len(a)+1):d[i][0]=i
    for j in range(len(b)+1):d[0][j]=j
    for i in range(1,len(a)+1):
        for j in range(1,len(b)+1):d[i][j]=min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]!=b[j-1]))
    i,j=len(a),len(b);matches=set()
    while i or j:
        if i and j and d[i][j]==d[i-1][j-1]+(a[i-1]!=b[j-1]):
            if a[i-1]==b[j-1]:matches.add(i-1)
            i-=1;j-=1
        elif i and d[i][j]==d[i-1][j]+1:i-=1
        else:j-=1
    return matches

def summarize(cascade,gigaam,qwen):
    reports=[cascade,gigaam,qwen]
    if not all(r.get('complete') for r in reports):raise ValueError('Complete runs required')
    if len({r['corpusSHA256'] for r in reports})!=1:raise ValueError('Corpus mismatch')
    ids=[r['id'] for r in cascade['rows']]
    if len(ids)!=len(set(ids)) or any([r['id'] for r in x['rows']]!=ids for x in reports):raise ValueError('Pairing mismatch')
    if len(cascade['pairs'])!=len(ids):raise ValueError('Missing inference evidence')
    qwen_changed=0;terms=hits=0
    for actual,pair,base,large in zip(cascade['rows'],cascade['pairs'],gigaam['rows'],qwen['rows']):
        if actual['reference']!=base['reference'] or actual['reference']!=large['reference']:raise ValueError('Reference mismatch')
        if pair['case']['id']!=actual['id'] or pair['case']['split']!='holdout':raise ValueError('Case mismatch')
        if actual['baseHypothesis']!=base['hypothesis']:raise ValueError('GigaAM decoding regression')
        if actual['refined']!=g.route(pair['draft'],cascade['policy']):raise ValueError('Routing mismatch')
        expected=g.patch(pair['draft'],pair['qwen']['hypothesis'],cascade['policy']) if actual['refined'] else actual['baseHypothesis']
        if actual['hypothesis']!=expected:raise ValueError('Patch mismatch')
        if g.pilot.errors(actual['reference'],actual['hypothesis'])!=(actual['errors'],actual['words']):raise ValueError('Score mismatch')
        qwen_changed+=actual['refined'] and pair['qwen']['hypothesis']!=large['hypothesis']
        tokens=g.pilot.normalized(actual['hypothesis'])
        for term in pair['case'].get('terms',[]):
            tt=g.pilot.normalized(term);terms+=1;hits+=any(tokens[i:i+len(tt)]==tt for i in range(len(tokens)))
    def latency(values):
        return dict(median=sorted(values)[len(values)//2],p95=sorted(values)[math.ceil(len(values)*.95)-1])
    result=g.metrics(cascade['rows']);result.update(termMatches=hits,terms=terms,qwenTextDifferences=qwen_changed,draftLatency=latency([r['draftSeconds'] for r in cascade['rows']]),finalLatency=latency([r['totalSeconds'] for r in cascade['rows']]),audioSeconds=sum(r['audioSeconds'] for r in cascade['rows']),routedFiles=sum(r['refined'] for r in cascade['rows']))
    result['previouslyMatchedWordsLost']=sum(len(matched_reference_indices(r['reference'],r['baseHypothesis'])-matched_reference_indices(r['reference'],r['hypothesis'])) for r in cascade['rows'])
    result['singleModels']={name:dict(werPercent=100*sum(r['errors'] for r in report['rows'])/sum(r['words'] for r in report['rows']),computeSeconds=sum(sum(r['chunkSeconds']) for r in report['rows'])) for name,report in [('gigaam',gigaam),('qwen',qwen)]}
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for key in ['cascade','gigaam','qwen','output']:p.add_argument('--'+key,type=Path,required=True)
    a=p.parse_args();result=summarize(*[json.loads(x.read_text()) for x in [a.cascade,a.gigaam,a.qwen]])
    g.pilot.write_json(a.output,result);print(json.dumps(result,indent=2))
