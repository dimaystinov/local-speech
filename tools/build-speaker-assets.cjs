/* Optional offline speaker add-on. Run after build-sdk.cjs; never fetches assets. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const LOCAL_FILES = {
  'sdk/speaker-identity.js': 'speaker-identity.js',
  'speaker-worker.js': 'speaker-worker.js',
  'sdk/speaker-profiles.js': 'speaker-profiles.js',
  'sdk/SPEAKER_THIRD_PARTY_NOTICES.md': 'SPEAKER_THIRD_PARTY_NOTICES.md',
  'sdk/speaker-assets-manifest.json': 'speaker-assets-manifest.json',
};
function safePath(value) {
  return typeof value === 'string' && value.split('/').every(part => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part));
}
function validateManifest(manifest) {
  if (manifest?.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest?.model?.revision) || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid speaker manifest');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!['model', 'transformers', 'project'].includes(entry.source) || !safePath(entry.file) || !safePath(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid speaker asset entry');
    if (seen.has(entry.path)) throw Error('Duplicate speaker destination');
    seen.add(entry.path);
  }
  return manifest;
}
function contained(root, relative) {
  if (!safePath(relative)) throw Error('Unsafe asset path');
  const resolved = path.resolve(root, relative);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realRoot = fs.realpathSync(root), realAncestor = fs.realpathSync(ancestor);
  const rel = path.relative(realRoot, realAncestor);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw Error('Asset path escapes through symlink');
  return resolved;
}
function readChecked(root, entry) {
  const file = contained(root, entry.file);
  if (!fs.statSync(file).isFile()) throw Error('Speaker asset is not a regular file: ' + entry.file);
  const bytes = fs.readFileSync(file);
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw Error('Speaker asset integrity mismatch: ' + entry.file);
  return bytes;
}
function buildSpeakerAssets({ projectRoot = path.resolve(__dirname, '..'), outputRoot, transformersDir, manifest } = {}) {
  const root = path.resolve(projectRoot), out = path.resolve(outputRoot || path.join(root, 'dist/local-speech'));
  if (fs.lstatSync(out).isSymbolicLink()) throw Error('Speaker output must not be a symlink');
  const ownership = JSON.parse(fs.readFileSync(contained(out, 'package-manifest.json')));
  if (ownership.package !== 'local-speech-sdk' || !Array.isArray(ownership.files)) throw Error('Run build-sdk.cjs before adding speaker assets');
  const pinned = validateManifest(manifest || JSON.parse(fs.readFileSync(path.join(root, 'sdk/speaker-assets-manifest.json'))));
  const runtime = path.resolve(transformersDir || path.join(root, 'node_modules/@huggingface/transformers'));
  const metadata = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json')));
  if (metadata.name !== pinned.runtime.package || metadata.version !== pinned.runtime.version) throw Error('Speaker runtime version mismatch: requires ' + pinned.runtime.package + '@' + pinned.runtime.version);
  const roots = { project: root, model: path.join(root, 'models/speaker-wespeaker'), transformers: runtime };
  const payload = new Map(pinned.files.map(entry => [entry.path, readChecked(roots[entry.source], entry)]));
  for (const [source, destination] of Object.entries(LOCAL_FILES)) payload.set(destination, fs.readFileSync(contained(root, source)));
  // Complete all integrity and destination checks before changing the existing SDK package.
  for (const destination of payload.keys()) contained(out, destination);
  const inventory = [...payload].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: digest(bytes) }));
  const replaced = new Set(payload.keys());
  ownership.files = ownership.files.filter(entry => !replaced.has(entry.path)).concat(inventory);
  ownership.totalBytes = ownership.files.reduce((total, entry) => total + entry.bytes, 0);
  ownership.speaker = { model: pinned.model, runtime: pinned.runtime, bytes: inventory.reduce((total, entry) => total + entry.bytes, 0) };
  for (const [destination, bytes] of payload) {
    const target = contained(out, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + '.tmp-' + crypto.randomUUID();
    try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  const manifestPath = path.join(out, 'package-manifest.json');
  const temporary = manifestPath + '.tmp-' + crypto.randomUUID();
  try { fs.writeFileSync(temporary, JSON.stringify(ownership, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temporary, manifestPath); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { directory: out, files: inventory.length, speakerBytes: ownership.speaker.bytes };
}
function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    const key = arg.startsWith('--transformers-dir=') ? 'transformersDir' : arg.startsWith('--output=') ? 'outputRoot' : null;
    if (!key || options[key] || !arg.split('=').slice(1).join('=')) throw Error('Usage: node tools/build-speaker-assets.cjs [--transformers-dir=PATH] [--output=PATH]');
    options[key] = arg.slice(arg.indexOf('=') + 1);
  }
  return options;
}
if (require.main === module) console.log(JSON.stringify(buildSpeakerAssets(parseArgs(process.argv.slice(2))), null, 2));
module.exports = { buildSpeakerAssets, validateManifest, readChecked, parseArgs };
