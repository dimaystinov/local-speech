"""Download allowlisted model files and verify bytes/SHA before atomic install."""
import argparse
import hashlib
import json
import shutil
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHOICES = ('small', 'whisper_tiny', 'whisper')


def verified(path, entry):
    if not path.is_file() or path.stat().st_size != entry['bytes']:
        return False
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest() == entry['sha256']


def install(entry, root=ROOT, opener=urllib.request.urlopen):
    # The committed manifest is trusted configuration, never user input.
    for part in (entry['model'], entry['file']):
        if not isinstance(part, str) or not part or Path(part).name != part or part in ('.', '..') or '/' in part or '\\' in part:
            raise ValueError('Invalid asset path')
    target = root / 'models' / entry['model'] / entry['file']
    if verified(target, entry):
        return 'cached'
    target.parent.mkdir(parents=True, exist_ok=True)
    if 'bundled' in entry:
        source = root / entry['bundled']
        if not verified(source, entry):
            raise ValueError('Bundled asset integrity mismatch')
        source_stream = source.open('rb')
    else:
        if not entry['url'].startswith(('https://huggingface.co/', 'https://github.com/')):
            raise ValueError('Unexpected download origin')
        source_stream = opener(entry['url'], timeout=120)
    temporary = None
    try:
        with source_stream as response, tempfile.NamedTemporaryFile(dir=target.parent, suffix='.part', delete=False) as output:
            temporary = Path(output.name)
            count = 0
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > entry['bytes']:
                    raise ValueError('Asset exceeds declared size')
                output.write(chunk)
        if not verified(temporary, entry):
            raise ValueError('Downloaded asset integrity mismatch')
        temporary.replace(target)
        return 'installed'
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', nargs='+', choices=CHOICES, default=list(CHOICES))
    args = parser.parse_args()
    wanted = set(args.models) | {'vad'}
    if 'small' in wanted:
        wanted.add('context')
    rows = json.loads((ROOT / 'evidence/model-manifest.json').read_text())
    for entry in rows:
        if entry['model'] in wanted:
            print(entry['model'] + '/' + entry['file'] + ': ' + install(entry))
    if 'small' in wanted:
        shutil.copyfile(ROOT / 'assets/licenses/zipformer.txt', ROOT / 'models/small/LICENSE')


if __name__ == '__main__':
    main()
