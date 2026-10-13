#!/usr/bin/env python3
"""Fetch the pinned optional speaker model once; runtime inference stays offline."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request


def safe_relative(value):
    parts = value.split('/')
    if not value or any(p in ('', '.', '..') for p in parts) or '\\' in value or ':' in value:
        raise ValueError('Unsafe manifest path')
    return Path(*parts)


def download(root):
    manifest = json.loads((root / 'sdk/speaker-assets-manifest.json').read_text())
    for entry in manifest['files']:
        if entry['source'] not in ('model', 'segmentation'):
            continue
        model = manifest[entry['source']]
        base = root / ('models/speaker-wespeaker' if entry['source'] == 'model' else 'models/segmentation-pyannote')
        base.mkdir(parents=True, exist_ok=True)
        relative = safe_relative(entry['file'])
        target = base / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.resolve().is_relative_to(base.resolve()):
            raise ValueError('Model destination escapes through a symlink')
        if target.is_file() and target.stat().st_size == entry['bytes']:
            if hashlib.sha256(target.read_bytes()).hexdigest() == entry['sha256']:
                print(f'Cached and verified: {relative}')
                continue
        url = f"https://huggingface.co/{model['id']}/resolve/{model['revision']}/{relative.as_posix()}"
        temporary = None
        try:
            digest = hashlib.sha256()
            size = 0
            with tempfile.NamedTemporaryFile(dir=target.parent, suffix='.part', delete=False) as output:
                temporary = Path(output.name)
                with urllib.request.urlopen(url, timeout=120) as response:
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if size > entry['bytes']:
                            raise ValueError(f'Oversized model asset: {relative}')
                        digest.update(chunk)
                        output.write(chunk)
            if size != entry['bytes'] or digest.hexdigest() != entry['sha256']:
                raise ValueError(f'Model integrity mismatch: {relative}')
            temporary.replace(target)
            print(f'Downloaded and verified: {relative} ({size} bytes)')
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-root', type=Path, default=Path(__file__).resolve().parents[1])
    download(parser.parse_args().project_root.resolve())
