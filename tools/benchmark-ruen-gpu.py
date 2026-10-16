"""Paired Apple GPU experiment. Inputs are frozen local audio; no reference prompts."""
import argparse
import importlib.util
import json
import hashlib
import os
import selectors
import subprocess
import time
import wave
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location('pilot', Path(__file__).with_name('ruen-pilot.py'))
pilot = importlib.util.module_from_spec(spec); spec.loader.exec_module(pilot)


def read_line(proc, timeout=180):
    with selectors.DefaultSelector() as selector:
        selector.register(proc.stdout, selectors.EVENT_READ)
        if not selector.select(timeout):
            proc.kill()
            raise TimeoutError('Native worker timeout')
    line = proc.stdout.readline().strip()
    if not line:
        raise RuntimeError('Native worker closed stdout')
    return line


def audio_file(row):
    path = Path(row['file'])
    if hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256']:
        raise ValueError('Audio integrity mismatch')
    with wave.open(str(path)) as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            raise ValueError('Expected mono PCM16 16 kHz')
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768


def confidence_features(result):
    """Decoder diagnostics, not calibrated probabilities of correctness."""
    segments = result.get('segments', [])
    weighted = [(s.get('avg_logprob'), max(1, len(s.get('tokens', []))))
                for s in segments if s.get('avg_logprob') is not None]
    return dict(avgLogprob=sum(v*n for v, n in weighted)/sum(n for _, n in weighted)
                if weighted else None,
                maxCompressionRatio=max((s.get('compression_ratio', 0) for s in segments), default=0),
                maxNoSpeechProb=max((s.get('no_speech_prob', 0) for s in segments), default=0),
                detectedLanguage=result.get('language'))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--backend', choices=['mlx', 'nemotron'], required=True)
    p.add_argument('--model', required=True, type=Path)
    p.add_argument('--worker', type=Path)
    p.add_argument('--corpus', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    a = p.parse_args()
    if not a.model.exists() or a.output.exists():
        raise ValueError('Local model required; output must be new')
    cases = json.loads(a.corpus.read_text())['cases']
    a.output.parent.mkdir(parents=True, exist_ok=True)
    worker = None
    start = time.monotonic()
    if a.backend == 'mlx':
        import mlx.core as mx
        import mlx_whisper
        if not mx.metal.is_available():
            raise RuntimeError('Metal GPU unavailable')
        mx.set_default_device(mx.gpu)
        def recognize(audio, tag):
            before = time.monotonic()
            result = mlx_whisper.transcribe(audio, path_or_hf_repo=str(a.model),
                language=None, task='transcribe', temperature=0.0, fp16=True,
                condition_on_previous_text=False, without_timestamps=True, verbose=None)
            mx.synchronize()
            return result['text'].strip(), time.monotonic()-before, None, confidence_features(result)
    else:
        log = open(a.output.with_suffix('.native.log'), 'w')
        env = {k:v for k,v in os.environ.items() if not k.startswith('NEMO_SPEECH')}
        worker = subprocess.Popen([str(a.worker.resolve()), str(a.model.resolve())],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=log, text=True, bufsize=1, env=env)
        if read_line(worker) != 'READY':
            raise ValueError('Invalid native handshake')
        def recognize(audio, tag):
            raw = a.output.parent / (a.output.stem + '-' + tag + '.f32')
            audio.astype('<f4').tofile(raw)
            try:
                worker.stdin.write(str(raw.resolve()) + '\n'); worker.stdin.flush()
                fields = read_line(worker).split('\t')
                # Empty transcript has an empty last field; strip only newline in read_line.
                if len(fields) == 2: fields.append('')
                return bytes.fromhex(fields[2]).decode('utf-8'), float(fields[0]), float(fields[1]), {}
            finally:
                raw.unlink(missing_ok=True)
    try:
        recognize(np.zeros(16000, dtype=np.float32), 'warmup')
        setup = time.monotonic()-start
        rows = []
        for case in cases:
            audio = audio_file(case)
            text, elapsed, first, diagnostics = recognize(audio, case['id'])
            edits, count = pilot.errors(case['reference'], text)
            terms = [x['canonical'] if isinstance(x,dict) else x for x in case.get('terms',[])]
            tokens = pilot.normalized(text)
            matches = sum(any(tokens[i:i+len(pilot.normalized(t))] == pilot.normalized(t)
                              for i in range(len(tokens))) for t in terms)
            rows.append(dict(id=case['id'], language=case['language'], variant=case.get('variant','human'),
                reference=case['reference'], hypothesis=text, errors=edits, words=count,
                terms=len(terms), matchedTerms=matches, audioSeconds=len(audio)/16000,
                chunkSeconds=[elapsed], firstPartialAudioFedSeconds=first,
                diagnostics=diagnostics, split=case.get('split'), group=case.get('group')))
            report = dict(complete=False, backend=a.backend, model=str(a.model),
                corpusSHA256=hashlib.sha256(a.corpus.read_bytes()).hexdigest(), rows=rows,
                loadSeconds=setup, chunkWindowSeconds=0,
                modelBytes=sum(f.stat().st_size for f in a.model.rglob('*') if f.is_file()) if a.model.is_dir() else a.model.stat().st_size,
                method='Whole utterances; Nemotron streamed as fast as possible in 320ms chunks; warmed compute timing, not real-time mic latency')
            pilot.write_json(a.output, report)
            print(case['id'], edits, '/', count, round(elapsed,3),flush=True)
        report['complete'] = True
        if a.backend == 'mlx': report['mlxPeakMemoryBytes'] = mx.get_peak_memory()
        pilot.write_json(a.output, report)
    finally:
        if worker:
            worker.stdin.close()
            try: worker.wait(timeout=10)
            except subprocess.TimeoutExpired: worker.kill(); worker.wait()
            log.close()


if __name__ == '__main__': main()
