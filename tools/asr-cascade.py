"""Local small -> Codeswitch experiment. Fit routing on development ONLY.

`fit` uses paired cached predictions for choosing a single frozen rule.
`run` actually runs that rule with two persistent local MLX worker processes.
No references, annotated terms, or ground-truth language enter routing/inference.
"""
import argparse
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('bench', Path(__file__).with_name('benchmark-ruen-gpu.py'))
bench = importlib.util.module_from_spec(spec); spec.loader.exec_module(bench)


def route(hypothesis, diagnostics, policy):
    if policy['kind'] == 'small-only': return False
    lp = diagnostics.get('avgLogprob')
    if lp is None or not math.isfinite(lp) or not hypothesis.strip(): return True
    suspicious = diagnostics.get('maxCompressionRatio', 0) > 2.4
    mixed = bool(re.search('[a-zA-Z]', hypothesis) and re.search('[а-яА-ЯёЁ]', hypothesis))
    return suspicious or lp < policy['threshold'] or (policy['kind'] == 'mixed-or-confidence' and mixed)


def paired(small, large):
    if not small.get('complete') or not large.get('complete'): raise ValueError('Incomplete baseline')
    if small['corpusSHA256'] != large['corpusSHA256']: raise ValueError('Corpus mismatch')
    a, b = small['rows'], large['rows']
    if [(x['id'], x['reference'], x['split']) for x in a] != [(x['id'], x['reference'], x['split']) for x in b]:
        raise ValueError('Row mismatch')
    return list(zip(a, b))


def summary(pairs, policy):
    errors = words = seconds = refined = audio = 0
    by_language = {}; improved = regressed = 0
    for a, b in pairs:
        use = route(a['hypothesis'], a['diagnostics'], policy)
        chosen = b if use else a
        errors += chosen['errors']; words += a['words']; audio += a['audioSeconds']
        seconds += sum(a['chunkSeconds']) + (sum(b['chunkSeconds']) if use else 0)
        refined += a['audioSeconds'] if use else 0
        group = by_language.setdefault(a['language'], dict(errors=0, words=0, smallErrors=0))
        group['errors'] += chosen['errors']; group['words'] += a['words']; group['smallErrors'] += a['errors']
        improved += chosen['errors'] < a['errors']; regressed += chosen['errors'] > a['errors']
    return dict(errors=errors, words=words, werPercent=100*errors/words,
                refinedAudioFraction=refined/audio, estimatedComputeSeconds=seconds,
                estimatedRTF=seconds/audio, byLanguage=by_language,
                improved=improved, regressed=regressed)


def choose_policy(development, budget):
    if not 0 <= budget <= 1: raise ValueError('Budget must be in [0, 1]')
    if not development or any(a['split'] != 'development' or b['split'] != 'development' for a,b in development):
        raise ValueError('Calibration requires development rows exclusively')
    candidates = [dict(kind='small-only', threshold=-100)]
    candidates += [dict(kind=kind, threshold=round(-1.5+i*.05, 2))
                   for kind in ('confidence', 'mixed-or-confidence') for i in range(31)]
    scored = [(p, summary(development,p)) for p in candidates]
    eligible = [(p,s) for p,s in scored if s['refinedAudioFraction'] <= budget and
                all(g['errors'] <= g['smallErrors'] for g in s['byLanguage'].values())]
    policy, metrics = min(eligible, key=lambda item:(item[1]['errors'],item[1]['refinedAudioFraction']))
    return policy, metrics, [dict(policy=p, metrics=s) for p,s in scored]


def worker(model):
    import mlx.core as mx
    import mlx_whisper
    import numpy as np
    if not model.exists() or not mx.metal.is_available(): raise ValueError('Local model and Metal required')
    mx.set_default_device(mx.gpu)
    def infer(audio):
        start=time.monotonic()
        r=mlx_whisper.transcribe(audio, path_or_hf_repo=str(model.resolve()),language=None,
            task='transcribe',temperature=0.,fp16=True,condition_on_previous_text=False,
            without_timestamps=True,verbose=None)
        mx.synchronize()
        return dict(hypothesis=r['text'].strip(),diagnostics=bench.confidence_features(r),
                    computeSeconds=time.monotonic()-start)
    infer(np.zeros(16000,dtype=np.float32))
    print('READY',flush=True)
    for line in sys.stdin:
        request=json.loads(line)
        print(json.dumps(infer(bench.audio_file(request)),ensure_ascii=False),flush=True)


def run(a):
    manifest=json.loads(a.corpus.read_text()); artifact=json.loads(a.policy.read_text())
    import hashlib
    if artifact['corpusSHA256'] != hashlib.sha256(a.corpus.read_bytes()).hexdigest():
        raise ValueError('Policy corpus mismatch')
    if artifact['models'] != dict(small=str(a.small.resolve()), large=str(a.large.resolve())):
        raise ValueError('Policy models mismatch')
    workers=[]; logs=[]; start=time.monotonic()
    try:
        models=[('codeswitch',a.large)] if a.direct_large else [('small',a.small),('codeswitch',a.large)]
        for name,model in models:
            log=open(a.output.with_suffix('.'+name+'.log'),'w');logs.append(log)
            env=dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
            p=subprocess.Popen([sys.executable,__file__,'worker','--model',str(model.resolve())],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,bufsize=1,env=env)
            workers.append(p)
            if bench.read_line(p) != 'READY': raise ValueError('Worker handshake')
        setup=time.monotonic()-start; rows=[]
        for c in manifest['cases']:
            if c['split']!='holdout': continue
            started=time.monotonic()
            request=json.dumps({k:c[k] for k in ('file','sha256')})+'\n'
            workers[0].stdin.write(request);workers[0].stdin.flush()
            small=json.loads(bench.read_line(workers[0])); first=time.monotonic()-started
            use=not a.direct_large and route(small['hypothesis'],small['diagnostics'],artifact['policy'])
            result=small
            if use:
                workers[1].stdin.write(request);workers[1].stdin.flush()
                result=json.loads(bench.read_line(workers[1]))
            total=time.monotonic()-started
            edits,words=bench.pilot.errors(c['reference'],result['hypothesis'])
            rows.append(dict(id=c['id'],reference=c['reference'],hypothesis=result['hypothesis'],
                smallHypothesis=None if a.direct_large else small['hypothesis'],errors=edits,words=words,
                refined=use,firstComputeSeconds=first,totalComputeSeconds=total,
                audioSeconds=c['durationSeconds'],language=c['language'],group=c['group']))
            bench.pilot.write_json(a.output,dict(complete=False,policy=artifact['policy'],loadSeconds=setup,rows=rows))
            print(c['id'],use,edits,'/',words,round(total,3),flush=True)
        bench.pilot.write_json(a.output,dict(complete=True,policy=artifact['policy'],loadSeconds=setup,rows=rows,
            strategy='codeswitch-only' if a.direct_large else 'cascade',
            method='Persistent Metal workers. Whole-file audio, not live-mic latency. IPC and WAV read included; model startup separate.'))
    finally:
        for p in workers:
            if p.poll() is None:
                p.stdin.close()
                try:p.wait(timeout=10)
                except subprocess.TimeoutExpired:p.kill();p.wait()
        for log in logs:log.close()


def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    fit=sub.add_parser('fit');fit.add_argument('--small',type=Path,required=True);fit.add_argument('--large',type=Path,required=True)
    fit.add_argument('--budget',type=float,default=.5);fit.add_argument('--output',type=Path,required=True)
    w=sub.add_parser('worker');w.add_argument('--model',type=Path,required=True)
    r=sub.add_parser('run')
    r.add_argument('--direct-large',action='store_true',help='Matched single-worker timing control')
    for name in ['small','large','corpus','policy','output']:r.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args()
    if a.command=='worker':return worker(a.model)
    if a.output.exists():raise ValueError('Refusing to overwrite experiment')
    if a.command=='run':return run(a)
    small=json.loads(a.small.read_text());large=json.loads(a.large.read_text());pairs=paired(small,large)
    dev=[pair for pair in pairs if pair[0]['split']=='development']
    policy,metrics,grid=choose_policy(dev,a.budget)
    # Freeze the selected rule BEFORE computing any holdout metrics.
    bench.pilot.write_json(a.output,dict(policy=policy,corpusSHA256=small['corpusSHA256'],
        models=dict(small=str(Path(small['model']).resolve()),large=str(Path(large['model']).resolve())),
        budget=a.budget,development=metrics,calibrationIds=[x['id'] for x,_ in dev],grid=grid,
        method='Minimize dev edits under audio-minute budget and no dev language-group regression; tie break lower refined duration.'))
    test=[pair for pair in pairs if pair[0]['split']=='holdout']
    bench.pilot.write_json(a.output.with_suffix('.replay.json'),dict(development=metrics,
        holdout=summary(test,policy),smallHoldout=summary(test,dict(kind='small-only')),
        method='Cached prediction replay; compute times estimated by summing baseline stage times. Actual cascade measured separately.'))
    print(json.dumps(dict(policy=policy,development=metrics,holdout=summary(test,policy)),ensure_ascii=False))


if __name__=='__main__':main()
