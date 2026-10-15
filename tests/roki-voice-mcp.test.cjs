'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RokiVoiceClient, validArguments } = require('../tools/roki-voice-client.cjs');
const { createProtocol } = require('../tools/localspeech-mcp.cjs');
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roki-mcp-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = new RokiVoiceClient({ directory, timeout: 150 });
  const sessionId = randomUUID();
  function write(name, value) { fs.writeFileSync(path.join(directory, name), JSON.stringify(value), { mode: 0o600 }); }
  const status = { version: 1, enabled: true, sessionId, updatedAt: Date.now(), state: 'idle' };
  write('status.json', status);
  return { directory, client, write, status, sessionId };
}
test('voice argument limits reject commands disguised as options and arbitrary paths', () => {
  for (const text of ['', ' ', 'x'.repeat(601), 'hello\0world']) assert.equal(validArguments('roki_speak', { text }), false);
  assert.equal(validArguments('roki_speak', { text: 'Роки $HOME `id`; hello', emotion: 'happy' }), true);
  assert.equal(validArguments('roki_speak', { text: 'Hello', engine: '/bin/sh' }), false);
  assert.equal(validArguments('roki_voice_status', { request_id: '../secret' }), false);
  assert.equal(validArguments('roki_speak', { text: 'Привет', emotion: 'evil' }), false);
  assert.equal(validArguments('roki_stop', { all: true }), false);
});
test('status requires fresh private files and canonical private directory', async t => {
  const f = fixture(t);
  assert.equal((await f.client.call('roki_voice_status', {})).enabled, true);
  f.write('status.json', { ...f.status, updatedAt: Date.now() - 11000 }); assert.equal(f.client.status().enabled, false);
  f.write('status.json', { ...f.status, updatedAt: Date.now() + 6000 }); assert.equal(f.client.status().enabled, false);
  f.write('status.json', f.status); fs.chmodSync(path.join(f.directory, 'status.json'), 0o644); assert.equal(f.client.status().enabled, false);
  fs.chmodSync(path.join(f.directory, 'status.json'), 0o600); fs.chmodSync(f.directory, 0o755); assert.equal(f.client.status().enabled, false);
  await assert.rejects(f.client.call('roki_speak', { text: 'Hello' }), /enable/);
});
test('symlinks and hardlinks cannot leak data through voice status', t => {
  const f = fixture(t), file = path.join(f.directory, 'status.json'), target = path.join(f.directory, 'private');
  fs.renameSync(file, target); fs.symlinkSync(target, file); assert.equal(f.client.status().enabled, false);
  fs.unlinkSync(file); fs.linkSync(target, file); assert.equal(f.client.status().enabled, false);
});
test('atomic status replacement is retried without returning an obsolete snapshot', t => {
  const f = fixture(t), original = fs.readSync; let replaced = false;
  fs.readSync = (...args) => {
    const count = original(...args);
    if (!replaced) {
      replaced = true;
      f.write('next.json', { ...f.status, state: 'speaking' });
      fs.renameSync(path.join(f.directory, 'next.json'), path.join(f.directory, 'status.json'));
    }
    return count;
  };
  try { assert.equal(f.client.status().state, 'speaking'); } finally { fs.readSync = original; }
});
test('speech is sent as JSON, returns acceptance, and completion is a separate query', async t => {
  const f = fixture(t); let captured;
  const timer = setInterval(() => {
    const name = fs.readdirSync(f.directory).find(n => n.startsWith('request-'));
    if (!name) return;
    captured = JSON.parse(fs.readFileSync(path.join(f.directory, name), 'utf8'));
    assert.equal(fs.statSync(path.join(f.directory, name)).mode & 0o777, 0o600);
    fs.unlinkSync(path.join(f.directory, name));
    f.write('reply-' + captured.requestId + '.json', { ...f.status, requestId: captured.requestId, state: 'preparing' });
  }, 5);
  t.after(() => clearInterval(timer));
  const reply = await f.client.call('roki_speak', { text: 'Привет; $HOME', emotion: 'happy' });
  assert.equal(reply.state, 'preparing'); assert.equal(captured.text, 'Привет; $HOME'); assert.equal(captured.emotion, 'happy');
  f.write('reply-' + reply.request_id + '.json', { ...f.status, requestId: reply.request_id, state: 'completed' });
  assert.equal((await f.client.call('roki_voice_status', { request_id: reply.request_id })).state, 'completed');
  f.write('status.json', { ...f.status, sessionId: randomUUID() });
  await assert.rejects(f.client.call('roki_voice_status', { request_id: reply.request_id }), /earlier/);
});
test('dead app times out without claiming completion, removes pending text', async t => {
  const f = fixture(t);
  await assert.rejects(f.client.call('roki_speak', { text: 'Never keep this in a stale queue' }), /outcome unknown/);
  assert.deepEqual(fs.readdirSync(f.directory), ['status.json']);
});
test('MCP routes async voice calls, validates before effects, propagates failures', async () => {
  const calls = [];
  const handle = createProtocol({ read: () => ({ state: 'disabled' }) }, { call: async (name, args) => { calls.push([name, args]); if (name === 'roki_stop') throw Error('offline'); return { state: 'preparing' }; } });
  handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = (name, args) => handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  assert.equal((await call('roki_speak', { text: 'Привет' })).result.structuredContent.state, 'preparing');
  assert.equal((await call('roki_stop', {})).result.isError, true);
  assert.equal((await call('roki_speak', { text: '', path: '/tmp' })).error.code, -32602);
  assert.equal(calls.length, 2);
});
