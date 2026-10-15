'use strict';
// Audible opt-in integration against the installed, running LocalSpeech app.
// No mock IPC or mock synthesizer: JSON-RPC stdio -> app -> Qwen -> audio player.
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createInterface } = require('node:readline');
test('real MCP voice: warm streaming, ordered fragments, mouth envelope, cancel synthesis and queue', { skip: process.env.ROKI_MCP_LIVE_TEST !== '1', timeout: 180000 }, async t => {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../tools/localspeech-mcp.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const pending = new Map(); let serial = 0, diagnostics = '';
  child.stderr.on('data', b => { diagnostics += b; });
  createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line), handler = pending.get(response.id);
    if (handler) { pending.delete(response.id); handler(response); }
  });
  function rpc(method, params) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('MCP response timed out: ' + method)); }, 6000);
      pending.set(id, reply => { clearTimeout(timer); reply.error ? reject(Error(JSON.stringify(reply.error))) : resolve(reply.result); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'roki-live-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await rpc('tools/list', {});
  assert.equal(listed.tools.length, 5);
  const initial = (await call('roki_voice_status')).structuredContent;
  assert.equal(initial.enabled, true); assert.equal(initial.qwenAvailable, true); assert.equal(initial.state, 'idle'); assert.equal(initial.canSpeak, true);
  const warmDeadline = Date.now() + 120000;
  while (!(await call('roki_voice_status')).structuredContent.warmReady) {
    assert.ok(Date.now() < warmDeadline, 'Warmup timed out');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  for (const text of ['Привет. Я Роки. Теперь я говорю через MCP, своим сохранённым голосом.', 'Hello. I am Roki. The local voice connection is ready.']) {
    const start = Date.now(), accepted = await call('roki_speak', { text, emotion: 'happy' });
    assert.equal(accepted.isError, false, JSON.stringify(accepted));
    const id = accepted.structuredContent.request_id;
    let previous = '', playedAt, maxMouth = 0, maxTime = 0, duration = 0, completed = false, streamed = false, underruns = 0;
    while (Date.now() - start < 110000) {
      const reply = await call('roki_voice_status', { request_id: id });
      assert.equal(reply.isError, false, JSON.stringify(reply));
      const state = reply.structuredContent.state;
      if (state !== previous) { console.log(JSON.stringify({ request_id: id, state, elapsedMs: Date.now() - start })); previous = state; }
      assert.ok(!['failed', 'rejected', 'stopped'].includes(state), JSON.stringify(reply));
      const status = (await call('roki_voice_status')).structuredContent;
      if (status.state === 'speaking') {
        streamed ||= status.generating;
        underruns = Math.max(underruns, status.underruns);
        playedAt ??= Date.now() - start;
        maxMouth = Math.max(maxMouth, status.mouthLevel); maxTime = Math.max(maxTime, status.playbackTime); duration = Math.max(duration, status.duration);
      }
      if (state === 'completed') { completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(completed); assert.ok(maxMouth > 0.1); assert.ok(maxTime > 1); assert.ok(duration > 2);
    assert.ok(streamed, 'Audio must play while synthesis is still in progress');
    assert.equal(underruns, 0, 'No gaps between chunks');
    assert.ok(playedAt < 2500, 'Warm speech must start within 2.5 seconds on this test Mac');
    console.log(JSON.stringify({ language: /[А-Яа-я]/.test(text) ? 'ru' : 'en', firstAudioMs: playedAt, duration, maxMouth, completed, streamed, underruns }));
  }
  const first = await call('roki_speak', { text: 'Первая часть ответа уже звучит.' });
  const second = await call('roki_speak', { text: 'Вторая часть продолжает тот же ответ.' });
  assert.equal(second.isError, false); assert.equal(second.structuredContent.state, 'queued');
  const queueDeadline = Date.now() + 30000;
  while (Date.now() < queueDeadline) {
    const a = (await call('roki_voice_status', { request_id: first.structuredContent.request_id })).structuredContent;
    const b = (await call('roki_voice_status', { request_id: second.structuredContent.request_id })).structuredContent;
    if (b.state === 'speaking' || b.state === 'completed') assert.equal(a.state, 'completed');
    if (b.state === 'completed') break;
    assert.ok(!['stopped', 'failed', 'rejected'].includes(b.state));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal((await call('roki_voice_status', { request_id: second.structuredContent.request_id })).structuredContent.state, 'completed');
  console.log(JSON.stringify({ orderedFragments: true }));
  const cancelled = await call('roki_speak', { text: 'Эта проверка должна быть отменена во время подготовки голоса.' });
  assert.equal(cancelled.isError, false);
  const queued = await call('roki_speak', { text: 'Эта фраза в очереди тоже должна быть отменена.' });
  assert.equal(queued.isError, false);
  const stopStart = Date.now(); assert.equal((await call('roki_stop')).isError, false);
  const outcome = await call('roki_voice_status', { request_id: cancelled.structuredContent.request_id });
  assert.equal(outcome.structuredContent.state, 'stopped');
  assert.equal((await call('roki_voice_status', { request_id: queued.structuredContent.request_id })).structuredContent.state, 'stopped');
  console.log(JSON.stringify({ cancellationMs: Date.now() - stopStart, state: 'stopped' }));
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal((await call('roki_voice_status')).structuredContent.state, 'idle');
  assert.equal(diagnostics, '');
});
