"""Local, reproducible RU/EN Whisper pilot. Never modifies application models.

Heavy dependencies are imported only by the train/evaluate commands.
All audio and weights stay in an explicitly selected experiment directory.
"""
import argparse
import hashlib
import json
import random
import re
import time
from pathlib import Path


def normalized(text):
    return re.findall(r"[^\W_]+", text.lower().replace("ё", "е"), re.UNICODE)


def errors(reference, hypothesis):
    a, b = normalized(reference), normalized(hypothesis)
    previous = list(range(len(b) + 1))
    for i, word in enumerate(a, 1):
        current = [i]
        for j, other in enumerate(b, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (word != other)))
        previous = current
    return previous[-1], len(a)


def validate_split(train, test):
    if not train or not test:
        raise ValueError('Both train and test partitions must be nonempty')
    for key in ("id", "baseId", "sha256"):
        left = {x[key] for x in train if x.get(key)}
        right = {x[key] for x in test if x.get(key)}
        if left & right:
            raise ValueError(f"Train/test leakage: {key}")
    if {tuple(normalized(x['reference'])) for x in train} & {
            tuple(normalized(x['reference'])) for x in test}:
        raise ValueError("Train/test leakage: reference")


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def checked_cases(path):
    path = Path(path)
    result = []
    for original in json.loads(path.read_text())['cases']:
        row = dict(original)
        audio = (path.parent / row['file']).resolve()
        digest = hashlib.sha256(audio.read_bytes()).hexdigest()
        if row.get('sha256') and digest != row['sha256']:
            raise ValueError(f"Audio hash mismatch: {row['id']}")
        row.update(file=str(audio), sha256=digest)
        result.append(row)
    return result


def prepare(args):
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'split.json').exists():
        raise ValueError('Use a new output directory; frozen splits cannot be overwritten')
    production = checked_cases(args.production)
    human = [x for x in checked_cases(args.human) if x.get('group') == 'human']
    train = [x for x in production if x['split'] == 'development'
             and x.get('variant') != 'long-spliced' and x['durationSeconds'] <= 28]
    train += [x for x in human if x['split'] == 'development']
    # Two predetermined base phrases per category, with quiet and noise variants.
    test = []
    for category in sorted({x['category'] for x in production}):
        eligible = [x for x in production if x['split'] == 'holdout'
                    and x['category'] == category and x.get('variant') in ('quiet', 'noise')]
        bases = sorted({x['baseId'] for x in eligible})[:2]
        test += [x for x in eligible if x['baseId'] in bases]
    test += [x for x in human if x['split'] == 'holdout']
    validate_split(train, test)
    write_json(output / 'split.json', {'train': train, 'test': test,
               'limitations': ['Synthetic mixed speech; human controls are monolingual.',
                               'Sentence-disjoint, not verified speaker-disjoint.']})
    print(json.dumps({'training': len(train), 'evaluation': len(test)}), flush=True)


def train(args):
    import numpy as np
    import torch
    from faster_whisper.audio import decode_audio
    from transformers import WhisperForConditionalGeneration, WhisperProcessor
    from transformers.modeling_outputs import BaseModelOutput
    output = Path(args.output)
    split = json.loads((output / 'split.json').read_text())
    validate_split(split['train'], split['test'])
    if (output / 'checkpoint').exists():
        raise ValueError('Checkpoint exists; do not silently overwrite an experiment')
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    rng = random.Random(args.seed)
    torch.set_num_threads(2)
    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    processor = WhisperProcessor.from_pretrained(args.model, local_files_only=True)
    model = WhisperForConditionalGeneration.from_pretrained(
        args.model, local_files_only=True, attn_implementation='eager').to(device)
    model.config.use_cache = False
    # Preserve acoustic representation and shared vocabulary; adapt decoder layers.
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(name.startswith('model.decoder.') and
                                 'embed_tokens' not in name and 'embed_positions' not in name)
    metadata = {'base': str(Path(args.model).resolve()), 'seed': args.seed,
                'steps': args.steps, 'batchSize': 2, 'lr': 2e-5, 'device': device,
                'parameters': sum(p.numel() for p in model.parameters()),
                'trainableParameters': sum(p.numel() for p in model.parameters() if p.requires_grad),
                'splitSHA256': hashlib.sha256((output / 'split.json').read_bytes()).hexdigest(),
                'selection': 'Fixed final step, no held-out checkpoint selection'}
    write_json(output / 'training-config.json', metadata)
    started = time.monotonic()
    cached = []
    model.eval()
    with torch.no_grad():
        for index, row in enumerate(split['train']):
            if hashlib.sha256(Path(row['file']).read_bytes()).hexdigest() != row['sha256']:
                raise ValueError('Training audio changed since split preparation')
            audio = decode_audio(row['file'], sampling_rate=16000)
            if len(audio) > 30 * 16000:
                raise ValueError('Training audio would be truncated')
            features = processor.feature_extractor(audio, sampling_rate=16000,
                                                  return_tensors='pt').input_features.to(device)
            hidden = model.model.encoder(features).last_hidden_state.cpu()
            processor.tokenizer.set_prefix_tokens(language='en' if row['language'] == 'en' else 'ru',
                                                   task='transcribe', predict_timestamps=False)
            labels = processor.tokenizer(row['reference']).input_ids
            if labels[0] == model.config.decoder_start_token_id:
                labels = labels[1:]
            if len(labels) > 440:
                raise ValueError('Training transcript too long')
            cached.append((hidden, labels))
            if index % 20 == 0:
                print(f'encoded {index + 1}/{len(split["train"])}', flush=True)
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                                 lr=2e-5, weight_decay=0.01)
    model.train()
    order = list(range(len(cached)))
    losses = []
    for step in range(args.steps):
        if step * 2 % len(order) < 2:
            rng.shuffle(order)
        batch = [cached[order[(step * 2 + i) % len(order)]] for i in range(2)]
        hidden = torch.cat([x[0] for x in batch]).to(device)
        labels = torch.full((2, max(len(x[1]) for x in batch)), -100, dtype=torch.long)
        for i, (_, ids) in enumerate(batch):
            labels[i, :len(ids)] = torch.tensor(ids)
        labels = labels.to(device)
        optimizer.zero_grad(set_to_none=True)
        loss = model(encoder_outputs=BaseModelOutput(last_hidden_state=hidden), labels=labels).loss
        if not torch.isfinite(loss):
            raise ValueError('Non-finite loss')
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        losses.append(float(loss.detach().cpu()))
        if step % 8 == 0 or step == args.steps - 1:
            print(f'step {step + 1}/{args.steps} loss={losses[-1]:.4f}', flush=True)
            write_json(output / 'training-progress.json', {'step': step + 1, 'losses': losses})
    model.config.use_cache = True
    model.save_pretrained(output / 'checkpoint', safe_serialization=True)
    processor.save_pretrained(output / 'checkpoint')
    write_json(output / 'training-result.json', {**metadata, 'losses': losses,
               'elapsedSeconds': time.monotonic() - started, 'complete': True})


def evaluate(args):
    import numpy as np
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    output = Path(args.output)
    split = json.loads((output / 'split.json').read_text())
    validate_split(split['train'], split['test'])
    start = time.monotonic()
    model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=2,
                         num_workers=1, local_files_only=True)
    load_seconds = time.monotonic() - start
    # Identical warmup; excluded from timing.
    list(model.transcribe(np.zeros(16000, dtype=np.float32), language='ru', beam_size=1)[0])
    rows = []
    for row in split['test']:
        if hashlib.sha256(Path(row['file']).read_bytes()).hexdigest() != row['sha256']:
            raise ValueError('Evaluation audio changed')
        audio = decode_audio(row['file'], sampling_rate=16000)
        chunks = []
        texts = []
        window = int(args.chunk * 16000) if args.chunk else len(audio)
        for i in range(0, len(audio), window):
            start = time.monotonic()
            segments, info = model.transcribe(audio[i:i + window], language=None, beam_size=1,
                temperature=0, condition_on_previous_text=False, vad_filter=False,
                without_timestamps=True)
            texts.append(' '.join(s.text.strip() for s in segments))
            chunks.append(time.monotonic() - start)
        hypothesis = ' '.join(texts)
        edits, words = errors(row['reference'], hypothesis)
        terms = [t['canonical'] if isinstance(t, dict) else t for t in row.get('terms', [])]
        # Exact case-insensitive token sequence match, no substring or transliteration credit.
        tokens = normalized(hypothesis)
        matched = sum(any(tokens[i:i+len(normalized(t))] == normalized(t)
                          for i in range(len(tokens))) for t in terms)
        rows.append({'id': row['id'], 'baseId': row.get('baseId', row['id']),
                     'language': row['language'], 'variant': row.get('variant', 'human'),
                     'reference': row['reference'], 'hypothesis': hypothesis,
                     'errors': edits, 'words': words, 'terms': len(terms), 'matchedTerms': matched,
                     'audioSeconds': len(audio)/16000, 'chunkSeconds': chunks})
        result = {'complete': False, 'model': args.model, 'chunkWindowSeconds': args.chunk,
                  'loadSeconds': load_seconds, 'rows': rows,
                  'modelBytes': sum(p.stat().st_size for p in Path(args.model).rglob('*') if p.is_file()),
                  'runtime': 'faster-whisper 1.2.1 / CTranslate2 CPU int8, 2 threads, beam 1, auto language'}
        write_json(output / args.report, result)
        print(f'{args.report}: {row["id"]} {edits}/{words} {sum(chunks):.2f}s', flush=True)
    result['complete'] = True
    write_json(output / args.report, result)


def convert(args):
    from ctranslate2.converters import TransformersConverter
    if not Path(args.model).is_dir():
        raise ValueError('Conversion requires a local model directory')
    TransformersConverter(args.model, copy_files=['tokenizer.json', 'preprocessor_config.json']).convert(
        args.output, quantization='int8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('--production', required=True)
    prep.add_argument('--human', required=True)
    training = sub.add_parser('train')
    training.add_argument('--model', required=True)
    training.add_argument('--steps', type=int, default=96)
    training.add_argument('--seed', type=int, default=1701)
    evaluation = sub.add_parser('evaluate')
    evaluation.add_argument('--model', required=True)
    evaluation.add_argument('--report', required=True)
    evaluation.add_argument('--chunk', type=float, default=6)
    conversion = sub.add_parser('convert')
    conversion.add_argument('--model', required=True)
    for command in (prep, training, evaluation, conversion):
        command.add_argument('--output', required=True)
    args = parser.parse_args()
    if getattr(args, 'steps', 1) < 1 or getattr(args, 'chunk', 0) < 0:
        parser.error('Invalid steps or chunk size')
    {'prepare': prepare, 'train': train, 'evaluate': evaluate, 'convert': convert}[args.command](args)


if __name__ == '__main__':
    main()
