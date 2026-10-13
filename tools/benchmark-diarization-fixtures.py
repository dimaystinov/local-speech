#!/usr/bin/env python3
"""Generate private, reproducible diarization stress fixtures (macOS say + optional FLEURS).

Usage: python3 tools/benchmark-diarization-fixtures.py --out validation/diarization-fixtures
       [--human-dir PATH]
Requires Python numpy/scipy and macOS say/afconvert. Generated audio is NOT licensed
for redistribution by this script; keep output ignored/local. FLEURS attribution is
copied when supplied. Never uses microphone, network or a user's call recordings.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import platform
import wave
import numpy as np
from scipy.signal import resample_poly, fftconvolve, butter, sosfilt

RATE = 16000
SEED = 714209
VOICES = [('Milena', 'ru', True), ('Daniel', 'en', True), ('Samantha', 'en', True),
          ('Karen', 'en', False), ('Moira', 'en', False), ('Fred', 'en', False)]
TEXTS = {
    'ru': [
        'Здравствуйте. Сегодня мы проверяем голосовую связь. Пожалуйста, внимательно прочитайте описание проекта и уточните условия договора. Все документы уже подготовлены.',
        'Исполнитель отправит результат завтра утром. Заказчик просит проверить API, GitHub и новый интерфейс. Давайте согласуем стоимость работ, сроки и формат отчёта. Для следующего созвона подготовьте список открытых вопросов. Спасибо за помощь.',
        'Добрый день. Мы проверили документацию и нашли несколько ошибок в настройках. Сначала обновим базу данных, затем протестируем приложение. Если возникнут вопросы, обсудим их на встрече. Нужен отдельный отчёт о скорости работы и качестве результата.',
    ],
    'en': [
        'Hello. Today we are checking the voice connection. Please read the project description carefully and clarify the contract conditions. All documents have already been prepared.',
        'The contractor will send the result tomorrow morning. Our customer wants us to check the API, GitHub and the new interface. Let us agree on the price, delivery date and report format. Please prepare a list of open questions for our next call. Thank you for your help.',
        'Good afternoon. We reviewed the documentation and found a few configuration issues. First we will update the database, then test the application. If any questions remain we can discuss them during the meeting. Please prepare a separate report about performance and quality.',
    ],
}


def read_wav(path):
    with wave.open(str(path), 'rb') as audio:
        if audio.getsampwidth() != 2:
            raise ValueError('Expected 16-bit PCM WAV')
        data = np.frombuffer(audio.readframes(audio.getnframes()), '<i2').astype(np.float64) / 32768
        data = data.reshape(-1, audio.getnchannels()).mean(axis=1)
        rate = audio.getframerate()
    if rate != RATE:
        from math import gcd
        d = gcd(rate, RATE)
        data = resample_poly(data, RATE // d, rate // d)
    return data


def normalized(x):
    peak = np.max(np.abs(x), initial=0)
    return x * min(1, .95 / max(peak, 1e-9))


def crop(x, seconds, offset=.35):
    start = int(offset * RATE)
    data = x[start:start + int(seconds * RATE)]
    if len(data) != int(seconds * RATE):
        raise ValueError('Fixture too short for crop')
    return data


def noisy(x, snr, rng):
    if snr is None:
        return normalized(x)
    # Mix Gaussian broadband noise and low-frequency hum; report exact RMS SNR.
    noise = rng.normal(size=len(x))
    t = np.arange(len(x)) / RATE
    noise += .2 * np.sin(2 * np.pi * 60 * t)
    noise *= np.sqrt(np.mean(x*x) / max(np.mean(noise*noise), 1e-12)) / (10**(snr / 20))
    return normalized(x + noise)


def generate(out, human_dir=None):
    out.mkdir(parents=True, exist_ok=True)
    raw = out / 'source'
    raw.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)
    manifest = {'version': 1, 'rate': RATE, 'seed': SEED, 'platform': platform.platform(), 'enrollments': [], 'cases': [],
                'provenance': {
                    'synthetic': 'Locally generated with installed macOS say voices; distinct enrollment/evaluation scripts. Synthetic speech is a smoke/stress test, not human cross-call identity evidence. Audio must stay local, not committed or redistributed.',
                    'human': 'Optional Google FLEURS, CC BY 4.0; same-file disjoint halves only. No cross-recording identity labels available. See copied ATTRIBUTION.md. Not a conversational diarization corpus.',
                    'model': 'WeSpeaker ResNet34 LM q8, CC BY 4.0, pinned by SDK manifest.'}}

    def write(id_, samples, section='cases', **meta):
        samples = normalized(samples).astype('<f4')
        path = out / (id_ + '.f32le')
        path.write_bytes(samples.tobytes())
        row = {'id': id_, 'file': path.name, 'seconds': len(samples) / RATE,
               'sha256': hashlib.sha256(samples.tobytes()).hexdigest(), **meta}
        manifest[section].append(row)
        if section == 'enrollments' and meta.get('source') == 'say':
            with wave.open(str(out / (id_ + '.wav')), 'wb') as wav:
                wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(RATE)
                wav.writeframes((samples*32767).astype('<i2').tobytes())
        return row

    audio = {}
    for voice, language, known in VOICES:
        for index, text in enumerate(TEXTS[language]):
            stem = raw / f'{voice}-{index}'
            wav = stem.with_suffix('.wav')
            source_meta = {'voice': voice, 'text': text, 'wordsPerMinute': 165, 'rate': RATE}
            metadata = stem.with_suffix('.json')
            cached = json.loads(metadata.read_text()) if metadata.exists() else None
            if not wav.exists() or cached != source_meta:
                subprocess.run(['say', '-v', voice, '-r', '165', '-o', str(stem.with_suffix('.aiff')), text], check=True)
                subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', str(stem.with_suffix('.aiff')), str(wav)], check=True)
                metadata.write_text(json.dumps(source_meta, ensure_ascii=False, indent=2))
            samples = read_wav(wav)
            if index == 0 and known:
                write('enroll-' + voice, crop(samples, min(10, (len(samples) - int(.35*RATE)) / RATE)), section='enrollments', speaker=voice, language=language, source='say', text=text)
            if index == 1:
                audio[voice] = samples
            if index == 2:
                for seconds in [1, 2, 4, 6]:
                    for snr in [None, 20, 10, 0]:
                        write(f'holdout-{voice}-{seconds}s-snr{snr}', noisy(crop(samples, seconds), snr, rng),
                              speaker=voice, known=known, language=language, source='say', split='holdout',
                              condition='clean' if snr is None else 'noise', snrDb=snr,
                              expected=voice if known else None, text=text)
        for seconds in [1, 2, 4, 6]:
            for snr in [None, 20, 10, 0]:
                clean = crop(audio[voice], seconds)
                write(f'{voice}-{seconds}s-snr{snr}', noisy(clean, snr, rng),
                      speaker=voice, known=known, language=language, source='say', split='development',
                      condition='clean' if snr is None else 'noise', snrDb=snr,
                      expected=voice if known else None, text=TEXTS[language][1])

    for a, b in [('Milena', 'Daniel'), ('Daniel', 'Samantha'), ('Milena', 'Karen')]:
        for seconds in [1, 2, 4, 6]:
            x, y = crop(audio[a], seconds), crop(audio[b], seconds, offset=1)
            pause = np.zeros(int(.4 * RATE))
            samples = np.concatenate([x, pause, y])
            for snr in [None, 10]:
                write(f'turn-{a}-{b}-{seconds}-snr{snr}', noisy(samples, snr, rng),
                      source='say', condition='turn', known=False, expected=None,
                      speakers=[a, b], snrDb=snr, regions=[{'start': 0, 'end': seconds, 'speaker': a},
                      {'start': seconds + .4, 'end': 2 * seconds + .4, 'speaker': b}])
        for balance in [-6, 0, 6]:
            x, y = crop(audio[a], 4), crop(audio[b], 4, offset=1)
            y *= np.sqrt(np.mean(x*x) / np.mean(y*y)) * 10**(balance/20)
            for snr in [None, 10, 0]:
                write(f'overlap-{a}-{b}-balance{balance}-snr{snr}', noisy(x+y, snr, rng),
                      source='say', condition='overlap', known=False, expected=None,
                      speakers=[a,b], balanceDb=balance, snrDb=snr)
    for seconds in [1, 4, 6]:
        for kind in ['silence', 'white-noise', 'hum']:
            n = seconds * RATE
            samples = (np.zeros(n) if kind == 'silence' else rng.normal(0, .05, n)
                       if kind == 'white-noise' else .05*np.sin(2*np.pi*60*np.arange(n)/RATE))
            write(f'{kind}-{seconds}', samples, source='generated', condition=kind, known=False, expected=None)

    if human_dir:
        attribution = human_dir / 'ATTRIBUTION.md'
        if attribution.exists():
            (out / 'ATTRIBUTION.md').write_text(attribution.read_text())
        for path in sorted(human_dir.glob('fleurs-*.wav')):
            samples = read_wav(path)
            half = len(samples) // 2
            # Enrollment and evaluation are strictly disjoint; no identical audio.
            enrollment = samples[:half][:RATE*10]
            evaluation = samples[half:][:RATE*6]
            if min(len(enrollment), len(evaluation)) < RATE:
                continue
            speaker = path.stem
            write('enroll-' + speaker, enrollment, section='enrollments', speaker=speaker,
                  language=path.stem.split('-')[1], source='fleurs', isolatedProfile=True)
            for snr in [None, 20, 10, 0]:
                write(speaker + '-snr' + str(snr), noisy(evaluation, snr, rng), speaker=speaker,
                      known=True, language=path.stem.split('-')[1], source='fleurs',
                      condition='human-halves', snrDb=snr, expected=speaker, isolatedProfile=True)
    # Held-out channel stress: telephony bandwidth, gain, clipping and room echo.
    for voice, language, known in VOICES:
        x = crop(audio[voice], 6)
        phone = resample_poly(resample_poly(x, 1, 2), 2, 1)[:len(x)]
        room = np.zeros(int(.35 * RATE)); room[0] = 1; room[int(.07*RATE)] = .45; room[int(.18*RATE)] = .25
        variants = {'telephone8k': phone, 'room-echo': fftconvolve(x, room)[:len(x)],
                    'quiet-gain': x*.03, 'clipping': np.clip(x*8, -.9, .9),
                    'bandlimited': sosfilt(butter(4, [300, 3400], btype='bandpass', fs=RATE, output='sos'), x)}
        for condition, samples in variants.items():
            write(f'channel-{voice}-{condition}', samples, speaker=voice, known=known,
                  language=language, source='say', split='channel-stress', condition=condition,
                  expected=voice if known else None)
    if human_dir:
        # Human voices are definitively different from synthetic enrolled voices.
        # Do not infer identity differences between separate FLEURS recordings.
        for item in list(manifest['cases']):
            if item['source'] == 'fleurs':
                samples = np.frombuffer((out / item['file']).read_bytes(), '<f4')
                write('unknown-' + item['id'], samples, speaker=item['speaker'], known=False,
                      language=item['language'], source='fleurs', split='human-unknown',
                      condition='human-unknown', expected=None, snrDb=item['snrDb'])
    # Replayable WAV for actual Mac SDK file/capture checks; never redistributed.
    call = []; timeline = []; at = 0
    for index, voice in enumerate(['Milena','Daniel','Samantha','Karen','Milena','Daniel']):
        snr = [None,None,None,None,10,None][index]
        chunk = noisy(crop(audio[voice],6),snr,rng)
        speakers = [voice]
        if index == 5:
            other = crop(audio['Milena'],6)
            other *= np.sqrt(np.mean(chunk*chunk) / np.mean(other*other))
            chunk=normalized(chunk+other);speakers.append('Milena')
        call.extend([chunk,np.zeros(int(.6*RATE))])
        timeline.append({'start':at,'end':at+6,'speakers':speakers,'snrDb':snr});at+=6.6
    playback = np.concatenate(call)
    with wave.open(str(out / 'call-multispeaker.wav'),'wb') as wav:
        wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(RATE)
        wav.writeframes((playback*32767).astype('<i2').tobytes())
    manifest['call']={'file':'call-multispeaker.wav','seconds':len(playback)/RATE,'timeline':timeline}
    for case in manifest['cases']:
        case.setdefault('split', 'stress' if case['source'] != 'fleurs' else 'human-exploratory')
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'directory': str(out), 'enrollments': len(manifest['enrollments']), 'cases': len(manifest['cases'])}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=Path('validation/diarization-fixtures'))
    parser.add_argument('--human-dir', type=Path)
    args = parser.parse_args()
    generate(args.out, args.human_dir)
