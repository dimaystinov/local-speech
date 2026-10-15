'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const emotions = ['calm', 'attentive', 'thinking', 'happy', 'concerned'];
const annotations = { destructiveHint: false, openWorldHint: false };
const voiceTools = [
  { name: 'roki_speak', description: 'Speak text aloud on this Mac using Roki’s selected offline Qwen voice. Requires LocalSpeech Calls with Voice via MCP enabled. Send a complete sentence as soon as ready; audio streams from a resident model. Additional calls queue up to eight text fragments behind active MCP speech. Returns a request_id after acceptance, not completion; poll roki_voice_status with that ID. Refuses while recording. Text is spoken literally, never executed. Does not control the Codex Pets mouth animation.', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 600 }, emotion: { type: 'string', enum: emotions } }, required: ['text'], additionalProperties: false }, annotations: { ...annotations, readOnlyHint: false, idempotentHint: false } },
  { name: 'roki_stop', description: 'Cancel Roki speech requested through this MCP, including Qwen preparation. Does not stop recordings or unrelated app speech.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { ...annotations, readOnlyHint: false, idempotentHint: true } },
  { name: 'roki_voice_status', description: 'Read local voice availability and playback state, or the result of a previous roki_speak request. No spoken text, microphone audio, or call transcripts are returned. completed means audio playback finished successfully; preparing is not completed.', inputSchema: { type: 'object', properties: { request_id: { type: 'string', pattern: UUID.source } }, additionalProperties: false }, annotations: { ...annotations, readOnlyHint: true, idempotentHint: true } },
];
function validArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (name === 'roki_stop') return Object.keys(args).length === 0;
  if (name === 'roki_voice_status') return Object.keys(args).every(k => k === 'request_id') && (args.request_id === undefined || typeof args.request_id === 'string' && UUID.test(args.request_id));
  return name === 'roki_speak' && Object.keys(args).every(k => ['text', 'emotion'].includes(k)) && typeof args.text === 'string' && args.text.trim().length > 0 && [...args.text].length <= 600 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(args.text) && (args.emotion === undefined || emotions.includes(args.emotion));
}
function privateFile(stat, directory = false) {
  return stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1);
}
function identity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
class RokiVoiceClient {
  constructor({ directory = process.env.LOCALSPEECH_VOICE_DIR || path.join(os.homedir(), 'Library/Application Support/LocalSpeech/RokiMCP'), now = Date.now, timeout = 3500 } = {}) {
    if (!path.isAbsolute(directory)) throw Error('Voice directory must be absolute');
    this.directory = path.resolve(directory); this.now = now; this.timeout = timeout;
  }
  checkDirectory() {
    const stat = fs.lstatSync(this.directory);
    if (!privateFile(stat, true) || fs.realpathSync(this.directory) !== this.directory) throw Error('Unsafe voice directory');
    return stat;
  }
  read(name) {
    // The app atomically replaces status during playback. A replacement race is
    // neither a disabled bridge nor a corrupt file: retry with a fresh descriptor.
    for (let attempt = 0; attempt < 3; attempt++) {
      const value = this.readOnce(name);
      if (value) return value;
    }
    return null;
  }
  readOnce(name) {
    let fd;
    try {
      const directory = this.checkDirectory(), file = path.join(this.directory, name);
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const before = fs.fstatSync(fd);
      if (!privateFile(before) || before.size < 2 || before.size > 16384) return null;
      const bytes = Buffer.alloc(before.size + 1), length = fs.readSync(fd, bytes, 0, bytes.length, 0), after = fs.fstatSync(fd);
      if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !identity(before, fs.lstatSync(file)) || !identity(directory, this.checkDirectory())) return null;
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      return result && typeof result === 'object' && !Array.isArray(result) && result.version === 1 && UUID.test(result.sessionId) ? result : null;
    } catch { return null; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  status() {
    const status = this.read('status.json');
    if (!status || typeof status.updatedAt !== 'number' || !Number.isFinite(status.updatedAt) || this.now() - status.updatedAt > 10000 || status.updatedAt > this.now() + 5000 || status.enabled !== true) return { enabled: false, state: 'unavailable' };
    return status;
  }
  async call(name, args) {
    if (!validArguments(name, args)) throw Error('Invalid voice tool arguments');
    const status = this.status();
    if (name === 'roki_voice_status' && !args.request_id) return status;
    if (!status.enabled) throw Error('Open LocalSpeech Calls and enable «Голос Роки через MCP».');
    if (name === 'roki_voice_status') {
      if (!args.request_id) return status;
      const reply = this.read('reply-' + args.request_id + '.json');
      if (!reply || reply.sessionId !== status.sessionId || reply.requestId !== args.request_id) throw Error('Request is unknown, expired, or belongs to an earlier app session.');
      return reply;
    }
    const id = randomUUID(), request = { version: 1, sessionId: status.sessionId, requestId: id, createdAt: this.now(), action: name === 'roki_stop' ? 'stop' : 'speak', ...args };
    const before = this.checkDirectory();
    if (fs.readdirSync(this.directory).filter(n => n.startsWith('request-')).length >= 32) throw Error('Voice request queue is full.');
    const temporary = path.join(this.directory, '.voice-' + id), filename = path.join(this.directory, 'request-' + id + '.json');
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify(request)); fs.closeSync(fd); fd = undefined;
      if (!identity(before, this.checkDirectory())) throw Error('Voice bridge changed during request.');
      fs.renameSync(temporary, filename);
      const deadline = Date.now() + this.timeout;
      do {
        const reply = this.read('reply-' + id + '.json');
        if (reply && reply.sessionId === status.sessionId && reply.requestId === id) {
          if (['rejected', 'failed'].includes(reply.state)) throw Error(reply.error || 'Voice request failed');
          return { ...reply, request_id: id };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      // Never claim success or retry automatically: the app might have accepted it at the deadline.
      throw Error('Voice acknowledgement timed out; outcome unknown. Check roki_voice_status with request_id ' + id + ' before retrying.');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (identity(before, (() => { try { return this.checkDirectory(); } catch { return {}; } })())) {
        try { fs.unlinkSync(temporary); } catch {}
        try { fs.unlinkSync(filename); } catch {}
      }
    }
  }
}
module.exports = { RokiVoiceClient, voiceTools, validArguments };
