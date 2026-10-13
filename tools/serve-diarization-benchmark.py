#!/usr/bin/env python3
"""Loopback-only real SDK benchmark. Only explicitly mapped assets/audio are served."""
import argparse
import hashlib
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', type=Path, help='Optional explicit fixture; never scans audio directories')
    parser.add_argument('--port', type=int, default=8768)
    args = parser.parse_args()
    audio = args.audio.resolve(strict=True) if args.audio else None
    if audio and (not audio.is_file() or audio.stat().st_size > 100 * 1024 * 1024):
        parser.error('Audio must be a regular file up to 100 MiB')
    sdk = (ROOT / 'dist/local-speech').resolve(strict=True)
    aliases = {
        '/': ROOT / 'tests/realtime-diarization.html',
        '/tests/realtime-diarization.html': ROOT / 'tests/realtime-diarization.html',
        '/tests/realtime-diarization.js': ROOT / 'tests/realtime-diarization.js',
        '/speakers.js': ROOT / 'apps/mac/Web/speakers.js',
        '/bridge.js': ROOT / 'apps/mac/Web/bridge.js',
    }
    if audio:
        aliases['/fixture'] = audio

    class Handler(BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.serve(False)

        def do_GET(self):
            self.serve(True)

        def serve(self, body):
            if self.headers.get('Host') not in (f'127.0.0.1:{args.port}', f'localhost:{args.port}'):
                self.send_error(403)
                return
            path = unquote(urlsplit(self.path).path)
            if path == '/benchmark-config':
                data = json.dumps({'fixture': '/fixture' if audio else None,
                                   'name': audio.name if audio else None,
                                   'sourceHashes': {name: hashlib.sha256(file.read_bytes()).hexdigest() for name, file in {
                                       'bridge.js': aliases['/bridge.js'], 'speakers.js': aliases['/speakers.js'],
                                       'local-speech.js': sdk / 'local-speech.js', 'speaker-worker.js': sdk / 'speaker-worker.js',
                                       'speaker-identity.js': sdk / 'speaker-identity.js', 'speaker-profiles.js': sdk / 'speaker-profiles.js',
                                       'speaker-diarization.js': sdk / 'speaker-diarization.js',
                                       'speaker-assets-manifest.json': sdk / 'speaker-assets-manifest.json',
                                   }.items()}}).encode()
                self.headers_for(200, 'application/json', len(data))
                if body:
                    self.wfile.write(data)
                return
            target = aliases.get(path)
            if path.startswith('/sdk/'):
                try:
                    target = (sdk / path[5:]).resolve(strict=True)
                    target.relative_to(sdk)
                except (OSError, ValueError):
                    target = None
            if not target or not target.is_file():
                self.send_error(404)
                return
            content_type = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
                            '.onnx': 'application/octet-stream'}.get(target.suffix, mimetypes.guess_type(str(target))[0] or 'application/octet-stream')
            self.headers_for(200, content_type, target.stat().st_size)
            if body:
                try:
                    with target.open('rb') as stream:
                        while chunk := stream.read(256 * 1024):
                            self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def headers_for(self, code, content_type, length):
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(length))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'http://127.0.0.1:{args.port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
