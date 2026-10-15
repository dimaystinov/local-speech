"""Resident offline Qwen worker: bounded JSON lines in, PCM16 chunks out.

No socket, microphone, file path arguments per request, or shell execution.
The selected model and synthetic voice reference are loaded once per worker.
"""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
import base64
import contextlib
import hashlib
import json
import sys
import time
from pathlib import Path


def parse(line):
    if len(line) > 8192:
        raise ValueError('Request too large')
    value = json.loads(line)
    if not isinstance(value, dict) or set(value) != {'id', 'text', 'language'}:
        raise ValueError('Invalid request')
    ident, text, language = value['id'], value['text'], value['language']
    if not isinstance(ident, str) or len(ident) > 64 or not ident:
        raise ValueError('Invalid id')
    if not isinstance(text, str) or not text.strip() or len(text) > 600 or any(ord(c) < 32 and c not in '\n\t' for c in text):
        raise ValueError('Invalid text')
    if language not in ('Russian', 'English'):
        raise ValueError('Invalid language')
    return ident, text.strip(), language


def main():
    output = sys.stdout
    def emit(value):
        output.write(json.dumps(value, separators=(',', ':')) + '\n')
        output.flush()
    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        import numpy as np
        from mlx_audio.tts.utils import load_model
        root = Path(__file__).resolve().parent
        profile = json.loads((root / 'profile.json').read_text())
        reference = root / 'reference.wav'
        model_path = Path(sys.argv[1]).resolve()
        if model_path.name != profile['revision'] or hashlib.sha256(reference.read_bytes()).hexdigest() != profile['reference_sha256']:
            raise ValueError('Voice profile mismatch')
        model = load_model(model_path)
        if model.config.tts_model_type != 'base':
            raise ValueError('Expected Qwen Base')
        # Force weights, reference cache, and decoder kernels before publishing ready.
        def generate(text, language, limit=profile['max_tokens']):
            mx.random.seed(profile['seed'])
            return model.generate(text=text, ref_audio=str(reference), ref_text=profile['reference_text'],
                lang_code=language, temperature=profile['temperature'], max_tokens=limit,
                verbose=False, stream=True, streaming_interval=0.64)
        for chunk in generate('Готово.', 'Russian', 80):
            mx.eval(chunk.audio)
        emit({'type': 'ready'})
        while True:
            line = sys.stdin.buffer.readline(8193)
            if not line:
                return
            ident = None
            try:
                ident, text, language = parse(line)
                started = time.monotonic()
                tokens, samples, count, energy, peak = 0, 0, 0, 0.0, 0.0
                for chunk in generate(text, language):
                    audio = np.asarray(chunk.audio).reshape(-1)
                    rate = int(chunk.sample_rate)
                    tokens += chunk.token_count
                    samples += len(audio)
                    if rate != 24000 or not np.isfinite(audio).all() or samples > rate * 60:
                        raise ValueError('Invalid audio')
                    if not len(audio):
                        continue
                    # Fixed gain across chunks avoids pumping and boundary jumps.
                    audio = np.clip(audio, -0.794, 0.794)
                    peak = max(peak, float(np.max(np.abs(audio))))
                    energy += float(np.sum(audio * audio))
                    pcm = (audio * 32767).astype('<i2').tobytes()
                    emit({'type': 'chunk', 'id': ident, 'rate': rate, 'index': count,
                          'pcm': base64.b64encode(pcm).decode('ascii')})
                    count += 1
                if not count or tokens >= profile['max_tokens'] or peak < 0.005 or (energy / max(samples, 1)) ** 0.5 < 0.0001:
                    raise ValueError('Incomplete or silent synthesis')
                emit({'type': 'end', 'id': ident, 'chunks': count, 'seconds': samples / 24000,
                      'generationSeconds': time.monotonic() - started})
            except Exception:
                emit({'type': 'error', 'id': ident, 'error': 'Local Qwen streaming synthesis failed'})
                # Decoder/caches may be inconsistent after an exception: let host restart.
                return


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('Roki streaming worker failed to initialize\n')
        sys.exit(1)
