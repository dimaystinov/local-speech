'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildSpeakerAssets, validateManifest, parseArgs } = require('../tools/build-speaker-assets.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, content) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  write('dist/local-speech/package-manifest.json', JSON.stringify({ package: 'local-speech-sdk', files: [{ path: 'local-speech.js', bytes: 3, sha256: sha('sdk') }] }));
  write('dist/local-speech/local-speech.js', 'sdk');
  write('runtime/package.json', JSON.stringify({ name: '@huggingface/transformers', version: '3.8.1' }));
  const entries = [['model', 'config.json', 'models/speaker-wespeaker/config.json', 'model'], ['transformers', 'dist/transformers.min.js', 'vendor/speaker/transformers.min.js', 'runtime']];
  const manifest = { version: 1, model: { revision: 'a'.repeat(40) }, runtime: { package: '@huggingface/transformers', version: '3.8.1' }, files: entries.map(([source, file, dest, content]) => {
    write((source === 'model' ? 'models/speaker-wespeaker/' : 'runtime/') + file, content);
    return { source, file, path: dest, bytes: content.length, sha256: sha(content) };
  }) };
  for (const name of ['sdk/speaker-identity.js', 'speaker-worker.js', 'sdk/speaker-profiles.js', 'sdk/SPEAKER_THIRD_PARTY_NOTICES.md']) write(name, name);
  write('sdk/speaker-assets-manifest.json', JSON.stringify(manifest));
  return { root, write, manifest, options: { projectRoot: root, transformersDir: path.join(root, 'runtime'), manifest } };
}
test('speaker packaging records pinned assets without replacing the ASR payload', t => {
  const { root, options } = fixture(t);
  buildSpeakerAssets(options);
  buildSpeakerAssets(options);
  const out = path.join(root, 'dist/local-speech');
  assert.equal(fs.readFileSync(path.join(out, 'local-speech.js'), 'utf8'), 'sdk');
  assert.equal(fs.readFileSync(path.join(out, 'models/speaker-wespeaker/config.json'), 'utf8'), 'model');
  const inventory = JSON.parse(fs.readFileSync(path.join(out, 'package-manifest.json')));
  assert.equal(new Set(inventory.files.map(x => x.path)).size, inventory.files.length);
  for (const file of inventory.files) { const bytes = fs.readFileSync(path.join(out, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256); }
  assert.equal(inventory.totalBytes, inventory.files.reduce((n, f) => n + f.bytes, 0));
});
test('tampered model leaves the existing SDK untouched', t => {
  const { root, write, options } = fixture(t);
  const before = fs.readFileSync(path.join(root, 'dist/local-speech/package-manifest.json'));
  write('models/speaker-wespeaker/config.json', 'other');
  assert.throws(() => buildSpeakerAssets(options), /integrity mismatch/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'dist/local-speech/package-manifest.json')), before);
  assert.equal(fs.existsSync(path.join(root, 'dist/local-speech/speaker-identity.js')), false);
});
test('wrong runtime version cannot silently replace the pinned runtime', t => {
  const { write, options } = fixture(t);
  write('runtime/package.json', JSON.stringify({ name: '@huggingface/transformers', version: '3.8.2' }));
  assert.throws(() => buildSpeakerAssets(options), /version mismatch/);
});
test('manifest rejects traversal, absolute paths, duplicates and malformed hashes', t => {
  const { manifest } = fixture(t);
  for (const bad of ['../escape', '/escape', 'a/../escape', 'a\\escape', 'a//escape']) {
    const changed = structuredClone(manifest); changed.files[0].path = bad;
    assert.throws(() => validateManifest(changed), /Invalid/);
  }
  const duplicate = structuredClone(manifest); duplicate.files.push(duplicate.files[0]);
  assert.throws(() => validateManifest(duplicate), /Duplicate/);
  const invalid = structuredClone(manifest); invalid.files[0].sha256 = 'wrong';
  assert.throws(() => validateManifest(invalid), /Invalid/);
});
test('destination symlinks cannot redirect the build outside the SDK', t => {
  const { root, options } = fixture(t);
  fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'dist/local-speech/models'));
  assert.throws(() => buildSpeakerAssets(options), /symlink/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'outside')), []);
});
test('only an existing owned SDK accepts the speaker add-on', t => {
  const { write, options } = fixture(t);
  write('dist/local-speech/package-manifest.json', JSON.stringify({ package: 'other', files: [] }));
  assert.throws(() => buildSpeakerAssets(options), /build-sdk/);
});
test('speaker builder arguments remain explicit and reject duplicates', () => {
  assert.deepEqual(parseArgs(['--transformers-dir=/tmp/runtime', '--output=/tmp/sdk']), { transformersDir: '/tmp/runtime', outputRoot: '/tmp/sdk' });
  assert.throws(() => parseArgs(['--transformers-dir=']), /Usage/);
  assert.throws(() => parseArgs(['--output=a', '--output=b']), /Usage/);
});
