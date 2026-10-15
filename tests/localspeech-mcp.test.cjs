'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough, Writable } = require('node:stream');
const { BridgeReader, createProtocol, serve, MAX_FILE_BYTES, MAX_INPUT_BYTES, LEASE_MS } = require('../tools/localspeech-mcp.cjs');
const NOW = Date.parse('2026-10-13T12:00:00Z');
const snapshot = overrides => ({ version: 1, enabled: true, sessionId: '12345678-1234-1234-1234-123456789abc', status: 'ready', rawText: 'private original', text: 'Visible draft', updatedAt: new Date(NOW).toISOString(), ...overrides });
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localspeech-mcp-test-')));
  fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'dictation-bridge.json');
  return { directory, file, reader: new BridgeReader({ directory, now: () => NOW }), write(value = snapshot()) { fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); } };
}
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const initialize = () => request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
function ready(reader) { const handle = createProtocol(reader); handle(initialize()); handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); return handle; }
const call = (name, args = {}) => request(2, 'tools/call', { name, arguments: args });

test('snapshot is opt-in and only processed text is returned', t => {
  const f = fixture(t); assert.equal(f.reader.read().state, 'disabled'); f.write();
  const handle = ready(f.reader), status = handle(call('localspeech_get_status')).result;
  assert.equal(status.structuredContent.enabled, true); assert.equal(status.structuredContent.hasDraft, true);
  assert.ok(!JSON.stringify(status).includes('Visible draft')); assert.ok(!JSON.stringify(status).includes('private original'));
  const draft = handle(call('localspeech_read_draft')).result;
  assert.equal(draft.structuredContent.text, 'Visible draft'); assert.ok(!JSON.stringify(draft).includes('private original'));
  f.write(snapshot({ enabled: false })); assert.equal(handle(call('localspeech_read_draft')).result.isError, true);
  fs.unlinkSync(f.file); assert.equal(handle(call('localspeech_get_status')).result.structuredContent.enabled, false);
});
test('stale, future, invalid, oversized and wrong-version snapshots fail closed', t => {
  const f = fixture(t);
  for (const value of [snapshot({ updatedAt: new Date(NOW - LEASE_MS - 1).toISOString() }), snapshot({ updatedAt: new Date(NOW + 6000).toISOString() }), snapshot({ updatedAt: 'bad' }), snapshot({ version: 2 }), snapshot({ sessionId: '../other' }), snapshot({ text: 'x'.repeat(32001) }), snapshot({ rawText: 'x'.repeat(32001) }), snapshot({ status: '\nsecret' }), snapshot({ unexpected: 'secret' }), 'null', '[]', '{', 'x'.repeat(MAX_FILE_BYTES + 1)]) {
    f.write(value); assert.notEqual(f.reader.read().state, 'ready');
    assert.equal(ready(f.reader)(call('localspeech_read_draft')).result.isError, true);
  }
  f.write(snapshot({ updatedAt: new Date(NOW - LEASE_MS).toISOString() })); assert.equal(f.reader.read().state, 'ready');
});
test('private modes, regular file and symlink/hardlink checks', t => {
  const f = fixture(t); f.write(); fs.chmodSync(f.file, 0o644); assert.equal(f.reader.read().state, 'unavailable');
  fs.chmodSync(f.file, 0o600); fs.chmodSync(f.directory, 0o755); assert.equal(f.reader.read().state, 'unavailable');
  fs.chmodSync(f.directory, 0o700); const target = path.join(f.directory, 'target.json'); fs.renameSync(f.file, target); fs.symlinkSync(target, f.file); assert.equal(f.reader.read().state, 'unavailable');
  fs.unlinkSync(f.file); fs.linkSync(target, f.file); assert.equal(f.reader.read().state, 'unavailable');
  fs.unlinkSync(f.file); fs.unlinkSync(target); fs.mkdirSync(f.file); assert.equal(f.reader.read().state, 'unavailable');
});
test('symlinked bridge directory and symlinked ancestor are rejected', t => {
  const f = fixture(t), actual = path.join(f.directory, 'actual'); fs.mkdirSync(actual, { mode: 0o700 });
  fs.writeFileSync(path.join(actual, 'dictation-bridge.json'), JSON.stringify(snapshot()), { mode: 0o600 });
  const alias = path.join(f.directory, 'alias'); fs.symlinkSync(actual, alias);
  assert.equal(new BridgeReader({ directory: alias, now: () => NOW }).read().state, 'unavailable');
  fs.mkdirSync(path.join(actual, 'nested'), { mode: 0o700 });
  assert.equal(new BridgeReader({ directory: path.join(alias, 'nested'), now: () => NOW }).read().state, 'unavailable');
});
test('atomic replacement while reading returns neither stale text nor a mixed snapshot', t => {
  const f = fixture(t); f.write(); const original = fs.readSync; let replaced = false;
  fs.readSync = (...args) => { const count = original(...args); if (!replaced) { replaced = true; const next = path.join(f.directory, 'next'); fs.writeFileSync(next, JSON.stringify(snapshot({ text: 'New draft' })), { mode: 0o600 }); fs.renameSync(next, f.file); } return count; };
  try { assert.equal(f.reader.read().state, 'unavailable'); } finally { fs.readSync = original; }
  assert.equal(f.reader.read().text, 'New draft');
});
test('disable during read immediately prevents the old snapshot from being returned', t => {
  const f = fixture(t); f.write(); const original = fs.readSync; let removed = false;
  fs.readSync = (...args) => { const count = original(...args); if (!removed) { removed = true; fs.unlinkSync(f.file); } return count; };
  try { assert.equal(f.reader.read().state, 'disabled'); } finally { fs.readSync = original; }
});
test('invalid UTF8 is not repaired into an accepted snapshot', t => {
  const f = fixture(t); f.write(); const bytes = fs.readFileSync(f.file), offset = bytes.indexOf('Visible'); bytes[offset] = 0xff; fs.writeFileSync(f.file, bytes); assert.equal(f.reader.read().state, 'unavailable');
});
test('MCP initialize negotiation, lifecycle, listing and bounded tools', () => {
  const handle = createProtocol({ read: () => ({ state: 'disabled' }) });
  assert.equal(handle(request(0, 'tools/list')).error.code, -32002);
  assert.equal(handle(request(0, 'initialize', {})).error.code, -32602);
  const init = initialize(); init.params.protocolVersion = 'unknown'; const result = handle(init).result;
  assert.equal(result.protocolVersion, '2025-11-25'); assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal(handle(request(0, 'tools/list')).error.code, -32002);
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(handle(request(3, 'tools/list')).result.tools.length, 5);
  assert.equal(handle(initialize()).error.code, -32600);
  assert.equal(handle(call('run_command', { command: 'x' })).error.code, -32602);
  assert.equal(handle(call('localspeech_read_draft', { path: '/etc/passwd' })).error.code, -32602);
  assert.equal(handle(request(3, 'resources/read')).error.code, -32601);
  assert.equal(handle(request(3, 'tools/list', { cursor: 'fake' })).error.code, -32602);
  assert.deepEqual(handle(request(4, 'ping')).result, {});
});
test('malformed JSON-RPC envelopes and unsupported batch are rejected without reflecting content', () => {
  const handle = ready({ read: () => ({ state: 'disabled' }) });
  for (const value of [null, [], {}, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }, request(2, 'ping', []), request(2, 'ping', null)]) {
    const reply = handle(value); assert.equal(reply.error.code, -32600); assert.equal(reply.id, null);
  }
  assert.equal(handle({ jsonrpc: '2.0', method: 'unknown_notification' }), null);
});
test('stdio handles split UTF8, parse errors, oversized lines and resumes after newline', async () => {
  const input = new PassThrough(), output = new PassThrough(); let data = ''; output.on('data', bytes => { data += bytes; });
  const done = serve(input, output, { read: () => ({ state: 'disabled' }) });
  const init = Buffer.from(JSON.stringify({ ...initialize(), params: { ...initialize().params, clientInfo: { name: 'Тест', version: '1' } } }) + '\n');
  const split = init.indexOf(Buffer.from('Т')) + 1; input.write(init.subarray(0, split)); input.write(init.subarray(split));
  input.write('{bad}\n'); input.write('x'.repeat(MAX_INPUT_BYTES + 1)); input.write('\n'); input.write(JSON.stringify(request(9, 'ping')) + '\n'); input.end(); await done;
  const replies = data.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 4); assert.equal(replies[0].result.serverInfo.name, 'localspeech'); assert.equal(replies[1].error.code, -32700); assert.equal(replies[2].error.code, -32700); assert.equal(replies[3].id, 9);
});
test('stdio respects output backpressure', async () => {
  const input = new PassThrough(); let writes = 0;
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { writes++; setImmediate(callback); } });
  const done = serve(input, output, { read: () => ({ state: 'disabled' }) });
  input.end(Array.from({ length: 30 }, (_, i) => JSON.stringify(request(i, 'ping'))).join('\n') + '\n'); await done; assert.equal(writes, 30);
});
test('CLI serves a real initialized JSON-RPC session without stdout logging', async t => {
  const f = fixture(t); f.write(snapshot({ updatedAt: new Date().toISOString(), text: 'CLI verified' }));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../tools/localspeech-mcp.cjs')], { env: { ...process.env, LOCALSPEECH_BRIDGE_DIR: f.directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { stderr += b; });
  child.stdin.end([initialize(), { jsonrpc: '2.0', method: 'notifications/initialized' }, request(3, 'tools/list'), call('localspeech_read_draft')].map(x => JSON.stringify(x)).join('\n') + '\n');
  const code = await new Promise(resolve => child.on('close', resolve)); assert.equal(code, 0); assert.equal(stderr, '');
  const replies = output.trim().split('\n').map(JSON.parse); assert.equal(replies.length, 3); assert.equal(replies[2].result.structuredContent.text, 'CLI verified'); assert.ok(!output.includes('private original'));
});
