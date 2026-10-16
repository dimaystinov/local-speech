"""Score a complete real cascade, checking parity with the frozen replay."""
import argparse
import importlib.util
import json
import math
from pathlib import Path

spec=importlib.util.spec_from_file_location('cascade',Path(__file__).with_name('asr-cascade.py'))
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)


def metrics(rows):
    groups={};times=[];seconds=audio=0
    for r in rows:
        g=groups.setdefault(r['language'],dict(files=0,errors=0,words=0,terms=0,matchedTerms=0))
        g['files']+=1
        for k in ('errors','words','terms','matchedTerms'):g[k]+=r[k]
        t=sum(r['chunkSeconds']);times.append(t);seconds+=t;audio+=r['audioSeconds']
    for g in groups.values():
        g['werPercent']=100*g['errors']/g['words']
        g['termRecallPercent']=100*g['matchedTerms']/g['terms'] if g['terms'] else None
    return dict(groups=groups,werPercent=100*sum(r['errors'] for r in rows)/sum(r['words'] for r in rows),
        errors=sum(r['errors'] for r in rows),words=sum(r['words'] for r in rows),files=len(rows),
        audioSeconds=audio,computeSeconds=seconds,rtf=seconds/audio,
        medianSeconds=sorted(times)[(len(times)-1)//2],p95Seconds=sorted(times)[math.ceil(len(times)*.95)-1])


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path);a=p.parse_args();b=a.directory
    read=lambda name:json.loads((b/name).read_text())
    small,large,actual,artifact=[read(x) for x in ['small.json','codeswitch.json','cascade-actual.json','policy.json']]
    pairs=[pair for pair in c.paired(small,large) if pair[0]['split']=='holdout']
    if not actual.get('complete'):raise ValueError('Incomplete actual cascade')
    if [r['id'] for r in actual['rows']] != [x['id'] for x,_ in pairs]:raise ValueError('Holdout mismatch')
    if actual['policy']!=artifact['policy']:raise ValueError('Policy mismatch')
    chosen=[];refined=0;improved=regressed=correct_to_incorrect=0;episodes={}
    for (x,y),r in zip(pairs,actual['rows']):
        use=c.route(x['hypothesis'],x['diagnostics'],artifact['policy']);expected=y if use else x
        if r['smallHypothesis']!=x['hypothesis'] or r['hypothesis']!=expected['hypothesis'] or r['refined']!=use:
            raise ValueError('Actual inference differs from frozen replay: '+r['id'])
        if (r['reference'],r['errors'],r['words']) != (expected['reference'],expected['errors'],expected['words']):
            raise ValueError('Scoring mismatch')
        chosen.append(dict(expected,chunkSeconds=[r['totalComputeSeconds']]))
        refined+=x['audioSeconds'] if use else 0
        improved+=r['errors']<x['errors'];regressed+=r['errors']>x['errors']
        correct_to_incorrect+=x['errors']==0 and r['errors']>0
        group=episodes.setdefault(x['group'],dict(words=0,smallErrors=0,codeswitchErrors=0,cascadeErrors=0))
        for k,v in [('words',x['words']),('smallErrors',x['errors']),('codeswitchErrors',y['errors']),('cascadeErrors',r['errors'])]:group[k]+=v
    report=dict(small=metrics([x for x,_ in pairs]),codeswitch=metrics([y for _,y in pairs]),cascade=metrics(chosen),
        refinedAudioFraction=refined/sum(x['audioSeconds'] for x,_ in pairs),
        policy=artifact['policy'],actualMatchesReplay=True,improvedCases=improved,regressedCases=regressed,
        correctToIncorrectCases=correct_to_incorrect,byEpisode=episodes,modelStartupSeconds=actual['loadSeconds'],
        paidRequests=0,limitations=['Episode split, not proven speaker split',
        'Public model evaluation/pretraining exposure unknown','Transcript script used for mixed subset labels',
        'Whole-file recognition, not live latency','Podlodka data license unspecified; no redistribution/training'])
    if (b/'codeswitch-actual.json').exists():
        direct=read('codeswitch-actual.json')
        if not direct.get('complete') or direct.get('strategy')!='codeswitch-only':raise ValueError('Incomplete direct control')
        if [r['id'] for r in direct['rows']] != [y['id'] for _,y in pairs]:raise ValueError('Direct rows mismatch')
        timed=[]
        for (_,y),r in zip(pairs,direct['rows']):
            if (r['hypothesis'],r['errors']) != (y['hypothesis'],y['errors']):raise ValueError('Direct parity mismatch')
            timed.append(dict(y,chunkSeconds=[r['totalComputeSeconds']]))
        report['codeswitchMatchedControl']=metrics(timed)
        report['directMatchesBaseline']=True
    c.bench.pilot.write_json(b/'results.json',report)
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
