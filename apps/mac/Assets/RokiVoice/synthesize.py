"""Offline, one-request Qwen voice worker. stdin JSON -> stdout PCM16 WAV.
The approved synthetic reference and all model weights remain on this Mac.
"""
import os
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
import contextlib
import hashlib
import io
import json
import sys
from pathlib import Path


def request(stream):
    data = stream.read(8193)
    if len(data) > 8192:
        raise ValueError('Request too large')
    value = json.loads(data)
    text = value.get('text')
    language = value.get('language')
    if not isinstance(text, str) or not text.strip() or len(text) > 600 or '\0' in text:
        raise ValueError('Invalid text')
    if language not in ('Russian', 'English'):
        raise ValueError('Invalid language')
    return text.strip(), language


def main():
    text, language = request(sys.stdin.buffer)
    root = Path(__file__).resolve().parent
    profile = json.loads((root / 'profile.json').read_text())
    reference = root / 'reference.wav'
    if hashlib.sha256(reference.read_bytes()).hexdigest() != profile['reference_sha256']:
        raise ValueError('Voice reference checksum mismatch')
    model_path = Path(sys.argv[1]).resolve()
    if model_path.name != profile['revision']:
        raise ValueError('Unexpected model revision')
    # Library diagnostics never enter the binary stdout protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        import numpy as np
        import soundfile as sf
        from mlx_audio.tts.utils import load_model
        model = load_model(model_path)
        if model.config.tts_model_type != 'base':
            raise ValueError('Expected Qwen Base voice-reference model')
        mx.random.seed(profile['seed'])
        chunks = list(model.generate(text=text, ref_audio=str(reference),
            ref_text=profile['reference_text'], lang_code=language,
            temperature=profile['temperature'], max_tokens=profile['max_tokens'], verbose=False))
        if not chunks or sum(c.token_count for c in chunks) >= profile['max_tokens']:
            raise ValueError('Speech did not finish within the generation limit')
        rate = chunks[0].sample_rate
        audio = np.concatenate([np.asarray(c.audio).reshape(-1) for c in chunks])
        if not np.isfinite(audio).all() or not 0 < len(audio) <= rate * 60:
            raise ValueError('Invalid audio')
        peak = float(np.max(np.abs(audio)))
        rms = float(np.sqrt(np.mean(audio * audio)))
        if peak < 0.005 or rms < 0.0001:
            raise ValueError('Silent audio')
        # Only gain adjustment: keep the selected natural timbre and safe headroom.
        audio = audio * min(0.794 / peak, 0.11 / rms, 4.0)
        output = io.BytesIO()
        sf.write(output, audio, rate, format='WAV', subtype='PCM_16')
    sys.stdout.buffer.write(output.getvalue())
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(type(exc).__name__ + ': ' + str(exc), file=sys.stderr)
        sys.exit(1)
