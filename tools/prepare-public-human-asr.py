"""Prepare pinned public podcast audio for local evaluation; no model training.

Podlodka has no license declaration in its card. Do not redistribute its audio
or include it in product artifacts. Its validation and test archives duplicate
each other; isolate all official test episodes from development.
"""
import argparse
import hashlib
import io
import json
import math
import re
import shutil
import urllib.request
from pathlib import Path

REVISION = '4a9161485a70ea849ccaa54a72faa9bfc0a60627'
HASHES = {'test': '53ebea8e77b6470dbafaa2c867586b5a99a6ffedecec4d22465a6c9148b36625',
          'train': 'a0c34e6761f303a15112f0b7c0e04aa58748315785e10528bfa50c1295a6a079'}


def main():
    import numpy as np
    import pyarrow.parquet as pq
    import soundfile as sf
    from scipy.signal import resample_poly
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--fleurs-corpus', type=Path, required=True)
    a = p.parse_args(); root = a.output.resolve()
    (root/'downloads').mkdir(parents=True, exist_ok=True)
    (root/'audio').mkdir(exist_ok=True)
    if (root/'corpus.json').exists():
        raise ValueError('Refusing to replace a frozen corpus')
    sources = []; records = []
    for partition in ('test', 'train'):
        path = root/'downloads'/f'podlodka-{partition}.parquet'
        url = f'https://huggingface.co/datasets/bond005/podlodka_speech/resolve/{REVISION}/data/{partition}-00000-of-00001.parquet'
        if not path.exists():
            with urllib.request.urlopen(url, timeout=90) as response, path.with_suffix('.tmp').open('wb') as out:
                shutil.copyfileobj(response, out)
            path.with_suffix('.tmp').replace(path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != HASHES[partition]: raise ValueError('Source hash mismatch')
        sources.append(dict(url=url, sha256=digest, license='unspecified; local evaluation only'))
        for i, row in enumerate(pq.read_table(path).to_pylist()):
            records.append(dict(row, originalSplit=partition, index=i))
    holdout_episodes = {r['episode'] for r in records if r['originalSplit'] == 'test'}
    seen = set(); cases = []
    for r in records:
        raw = r['audio']['bytes']; digest = hashlib.sha256(raw).hexdigest()
        if digest in seen: continue
        seen.add(digest)
        audio, rate = sf.read(io.BytesIO(raw), dtype='float32', always_2d=True)
        audio = audio.mean(axis=1)
        if rate != 16000:
            divisor = math.gcd(rate, 16000)
            audio = resample_poly(audio, 16000//divisor, rate//divisor)
        identity = f"podlodka-{r['episode']}-{r['originalSplit']}-{r['index']:03d}"
        path = root/'audio'/f'{identity}.wav'
        sf.write(path, np.clip(audio, -1, 32767/32768), 16000, subtype='PCM_16')
        terms = sorted(set(re.findall(r'[A-Za-z]+(?:[-.][A-Za-z0-9]+)*[0-9]*', r['transcription'])))
        cases.append(dict(id=identity, file=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            originalAudioSHA256=digest, reference=r['transcription'], terms=terms,
            language='mixed' if terms else 'ru', variant='human', group=f"podlodka-{r['episode']}",
            split='holdout' if r['episode'] in holdout_episodes else 'development',
            durationSeconds=len(audio)/16000, source='bond005/podlodka_speech',
            mixedLabel='Latin tokens in publisher transcript; not an independent linguistic audit'))
    corpus = json.loads(a.fleurs_corpus.read_text())
    for c in corpus['cases']:
        if not c['id'].startswith('fleurs-'): continue
        c = dict(c, file=str((a.fleurs_corpus.parent/c['file']).resolve()), terms=[], variant='human',
                 group='fleurs-'+c['language']+'-'+c['split'])
        cases.append(c)
    dev = [c for c in cases if c['split']=='development']
    test = [c for c in cases if c['split']=='holdout']
    for key in ('sha256','reference','group'):
        if {r[key] for r in dev} & {r[key] for r in test}: raise ValueError('Split overlap: '+key)
    report = dict(cases=cases, sources=sources, fleursProvenance=corpus['humanProvenance'],
        rule='All unique podcast rows; official test episodes reserved entirely for holdout, including their train rows. FLEURS keeps previous split. No synthetic audio.',
        limitation='Podcast hosts may occur across episodes. Episode separation is not verified speaker separation. Model pretraining overlap unknown.')
    (root/'corpus.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(dict(cases=len(cases), development=len(dev), holdout=len(test),
                         minutes=sum(c['durationSeconds'] for c in cases)/60)))


if __name__ == '__main__': main()
