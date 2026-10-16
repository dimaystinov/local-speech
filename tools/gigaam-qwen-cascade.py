"""Experimental GigaAM draft + conservative Qwen patches; never a production default.

Workers receive audio paths/hashes only. Policy is fitted on development, frozen,
then measured with both models resident. Word scores are uncalibrated CTC scores.
"""
import argparse, difflib, hashlib, importlib.util, json, os, re, subprocess, sys, time
from pathlib import Path

def module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    obj=importlib.util.module_from_spec(spec);spec.loader.exec_module(obj);return obj
pilot=module('ruen-pilot')
term_review=module('term-review')

def words(text):
    return list(re.finditer(r'[^\W_]+',text,re.UNICODE))

def evidence(chars, scores):
    text=''.join(chars); expanded=[p for c,p in zip(chars,scores) for _ in c]
    return [dict(word=m.group(),score=min(expanded[m.start():m.end()])) for m in words(text)]

def suspect(word, threshold):
    return word['score']<threshold or bool(re.search('[a-zA-Z]',word['word']))

def route(draft,policy):
    return policy['mode']!='off' and (not draft['hypothesis'].strip() or any(suspect(w,policy['threshold']) for w in draft['wordEvidence']) or bool(term_review.matches(draft['hypothesis'],policy.get('glossary',[]))))

def patch(draft,candidate,policy):
    original=draft['hypothesis'];aa=words(original);bb=words(candidate)
    ev=draft['wordEvidence']
    if len(ev)!=len(aa) or [w['word'] for w in ev]!=[w.group() for w in aa]:raise ValueError('Evidence not aligned')
    matcher=difflib.SequenceMatcher(None,pilot.normalized(original),pilot.normalized(candidate),autojunk=False)
    edits=term_review.confirmed_edits(original,candidate,policy.get('glossary',[]))
    for tag,i,j,k,l in matcher.get_opcodes():
        # Insertions/deletions and long rewrites are intentionally not applied.
        if tag!='replace' or max(j-i,l-k)>4:continue
        if any(aa[i].start()<end and aa[j-1].end()>start for start,end,_ in edits):continue
        replacement=candidate[bb[k].start():bb[l-1].end()]
        source=original[aa[i].start():aa[j-1].end()]
        if term_review.confirms(source,replacement,policy.get('glossary',[])):
            edits.append((aa[i].start(),aa[j-1].end(),replacement));continue
        if max(j-i,l-k)>3:continue
        if not any(suspect(w,policy['threshold']) for w in ev[i:j]):continue
        replacement=candidate[bb[k].start():bb[l-1].end()]
        if policy['mode']=='terms' and not re.search('[a-zA-Z]',replacement):continue
        # Do not change confident neighbouring Russian words in a larger block.
        if any(not suspect(w,policy['threshold']) for w in ev[i:j]):continue
        edits.append((aa[i].start(),aa[j-1].end(),replacement))
    if len(edits)>3:return original
    for start,end,text in sorted(edits,reverse=True):original=original[:start]+text+original[end:]
    return original

def metrics(rows):
    groups={};improved=regressed=corrupted=0
    for r in rows:
        g=groups.setdefault(r['language'],dict(words=0,baseErrors=0,errors=0))
        for key in g:g[key]+=r[key]
        improved+=r['errors']<r['baseErrors'];regressed+=r['errors']>r['baseErrors'];corrupted+=r['baseErrors']==0 and r['errors']>0
    total=sum(r['words'] for r in rows)
    return dict(werPercent=100*sum(r['errors'] for r in rows)/total,baseWERPercent=100*sum(r['baseErrors'] for r in rows)/total,improved=improved,regressed=regressed,perfectCorrupted=corrupted,groups=groups,routedFraction=sum(r['audioSeconds'] for r in rows if r['refined'])/sum(r['audioSeconds'] for r in rows),draftSeconds=sum(r['draftSeconds'] for r in rows),totalSeconds=sum(r['totalSeconds'] for r in rows))

def score(case,draft,qwen,policy,total):
    use=route(draft,policy);text=patch(draft,qwen['hypothesis'],policy) if use else draft['hypothesis']
    e,n=pilot.errors(case['reference'],text);be,_=pilot.errors(case['reference'],draft['hypothesis'])
    return dict(id=case['id'],language=case['language'],reference=case['reference'],hypothesis=text,baseHypothesis=draft['hypothesis'],baseErrors=be,errors=e,words=n,audioSeconds=case['durationSeconds'],refined=use,draftSeconds=draft['seconds'],totalSeconds=total)

def worker(a):
    os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
    import numpy as np
    bench=module('benchmark-ruen-gpu')
    if a.backend=='gigaam':
        import torch
        torch.set_num_threads(4);torch.manual_seed(0)
        sys.path.insert(0,str(a.model.resolve()))
        from modeling_gigaam import GigaAMModel
        core=GigaAMModel.from_pretrained(str(a.model),local_files_only=True,weights_only=True).eval().model
        if not core.decoding.tokenizer.charwise:raise ValueError('Character tokenizer required')
        for layer in core.encoder.layers:layer.self_attn.torch_sdpa_attn=False
        core.encoder.to('mps');core.head.to('mps')
        @torch.inference_mode()
        def infer(audio):
            features,lens=core.preprocessor(torch.from_numpy(audio).unsqueeze(0),torch.tensor([len(audio)]))
            encoded,lens=core.encoder(features.to('mps'),lens.to('mps'))
            values,labels=core.head(encoder_output=encoded)[0,:int(lens[0])].max(-1)
            labels=labels.cpu().tolist();probs=values.exp().cpu().tolist();chars=[];scores=[];last=None
            for token,p in zip(labels,probs):
                if token!=last and token!=core.decoding.blank_id:
                    chars.append(core.decoding.tokenizer.id_to_str(token));scores.append(p)
                last=token
            torch.mps.synchronize()
            return dict(hypothesis=''.join(chars),wordEvidence=evidence(chars,scores))
        def memory():return dict(allocatedBytes=torch.mps.current_allocated_memory(),driverBytes=torch.mps.driver_allocated_memory())
    else:
        import mlx.core as mx
        from mlx_audio.stt import load
        mx.set_default_device(mx.gpu);mx.random.seed(0);model=load(str(a.model))
        def infer(audio):
            result=model.generate(mx.array(audio),max_tokens=2048,temperature=0.,language=None);mx.synchronize()
            return dict(hypothesis=result.text.strip())
        def memory():return dict(peakBytes=mx.get_peak_memory())
    start=time.monotonic();infer(np.zeros(16000,dtype=np.float32))
    print(json.dumps(dict(ready=True,warmupSeconds=time.monotonic()-start)),flush=True)
    for line in sys.stdin:
        request=json.loads(line);audio=bench.audio_file(request);t=time.monotonic();out=infer(audio)
        out.update(seconds=time.monotonic()-t,memory=memory());print(json.dumps(out,ensure_ascii=False),flush=True)

def run(a):
    bench=module('benchmark-ruen-gpu');corpus=json.loads(a.corpus.read_text());digest=hashlib.sha256(a.corpus.read_bytes()).hexdigest()
    if a.output.exists():raise ValueError('Output exists')
    artifact=json.loads(a.policy.read_text()) if a.policy else None
    if a.split=='holdout' and not artifact:raise ValueError('Freeze development policy first')
    if artifact and (artifact['corpusSHA256']!=digest or artifact['gigaam']!=str(a.gigaam.resolve()) or artifact['qwen']!=str(a.qwen.resolve())):raise ValueError('Policy provenance mismatch')
    children=[];logs=[]
    try:
        for backend,python,model in [('gigaam',a.gigaam_python,a.gigaam),('qwen',a.qwen_python,a.qwen)]:
            log=a.output.with_suffix('.'+backend+'.log').open('w');logs.append(log)
            p=subprocess.Popen([str(python),str(Path(__file__).resolve()),'worker','--backend',backend,'--model',str(model.resolve())],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,bufsize=1);children.append(p)
            while True:
                line=bench.read_line(p)
                if line.startswith('{') and json.loads(line).get('ready'):break
        result=dict(complete=False,corpusSHA256=digest,gigaam=str(a.gigaam.resolve()),qwen=str(a.qwen.resolve()),split=a.split,policy=artifact['policy'] if artifact else None,rows=[],pairs=[])
        def request(p,case):
            p.stdin.write(json.dumps({k:case[k] for k in ['file','sha256']})+'\n');p.stdin.flush()
            return json.loads(bench.read_line(p))
        for case in [c for c in corpus['cases'] if c['split']==a.split]:
            t=time.monotonic();draft=request(children[0],case)
            use=not artifact or route(draft,artifact['policy'])
            qwen=request(children[1],case) if use else {'hypothesis':draft['hypothesis'],'seconds':0}
            elapsed=time.monotonic()-t
            if artifact:result['rows'].append(score(case,draft,qwen,artifact['policy'],elapsed))
            result['pairs'].append(dict(case=case,draft=draft,qwen=qwen,seconds=elapsed))
            pilot.write_json(a.output,result);print(len(result['pairs']),case['id'],round(elapsed,3),flush=True)
        result['complete']=True
        if artifact:result['metrics']=metrics(result['rows'])
        pilot.write_json(a.output,result)
    finally:
        for p in children:
            if p.stdin:p.stdin.close()
            try:p.wait(timeout=10)
            except subprocess.TimeoutExpired:p.kill();p.wait()
        for log in logs:log.close()

def fit(a):
    report=json.loads(a.input.read_text())
    if not report['complete'] or report['split']!='development' or any(p['case']['split']!='development' for p in report['pairs']):raise ValueError('Complete development only')
    candidates=[]
    for mode in ['off','terms','uncertain']:
        for threshold in ([0] if mode=='off' else [0,.3,.5,.7,.85,.95]):
            policy=dict(mode=mode,threshold=threshold)
            rows=[score(p['case'],p['draft'],p['qwen'],policy,p['seconds']) for p in report['pairs']]
            m=metrics(rows);candidates.append(dict(policy=policy,metrics=m))
    # Fixed gates: <=50% audio routed, no aggregate language regression,
    # no previously perfect utterance corrupted. Individual regressions reported.
    eligible=[c for c in candidates if c['metrics']['routedFraction']<=.5 and c['metrics']['perfectCorrupted']==0 and all(g['errors']<=g['baseErrors'] for g in c['metrics']['groups'].values())]
    best=min(eligible,key=lambda c:(c['metrics']['werPercent'],c['metrics']['regressed'],c['metrics']['routedFraction']))
    artifact={k:report[k] for k in ['corpusSHA256','gigaam','qwen']};artifact.update(policy=best['policy'],development=best['metrics'],candidates=candidates)
    if a.output.exists():raise ValueError('Frozen policy already exists')
    pilot.write_json(a.output,artifact);print(json.dumps(best,ensure_ascii=False,indent=2))

def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    w=sub.add_parser('worker');w.add_argument('--backend',choices=['gigaam','qwen'],required=True);w.add_argument('--model',type=Path,required=True)
    r=sub.add_parser('run')
    for key in ['gigaam','qwen','gigaam-python','qwen-python','corpus','output']:r.add_argument('--'+key,type=Path,required=True)
    r.add_argument('--split',choices=['development','holdout'],required=True);r.add_argument('--policy',type=Path)
    f=sub.add_parser('fit');f.add_argument('--input',type=Path,required=True);f.add_argument('--output',type=Path,required=True)
    a=p.parse_args();{'worker':worker,'run':run,'fit':fit}[a.command](a)
if __name__=='__main__':main()
