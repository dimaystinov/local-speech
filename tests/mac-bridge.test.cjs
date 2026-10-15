'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../apps/mac/Web/bridge.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; };
const pcm = (values = [.1, -.2, .3]) => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  return bytes.toString('base64');
};
function fixture(hooks = {}) {
  const messages = [], clients = [], status = {textContent: ''};
  const context = {
    URL, atob, Uint8Array, Float32Array, DataView, setTimeout, clearTimeout, ...hooks.timers,
    location: {href:'http://127.0.0.1:8766/bridge.html'},
    document: {getElementById: () => status},
    webkit: {messageHandlers: {speech: {postMessage: message => messages.push(message)}}},
    LocalSpeech: {version:'0.1.0', create(options) {
      const client = {options, writes: [], stopped: 0, disposed: 0,
        on(type, callback) {this.callback = callback; return () => {this.unsubscribed=true;};},
        emit(event) {this.callback(event);},
        async prepare(input) {this.prepareInput=input; await hooks.prepare?.(this);},
        async start(input) {this.startInput=input; await hooks.start?.(this);},
        async write(samples, rate, hints) {this.writes.push({samples:[...samples],rate,hints}); await hooks.write?.(this, samples);},
        async stop() {this.stopped++; await hooks.stop?.(this);},
        async dispose() {this.disposed++; await hooks.dispose?.(this);},
      }; clients.push(client); return client;
    }},
  };
  vm.runInNewContext(source, context, {filename:'bridge.js'});
  return {bridge:context.CallBridge, messages, clients, status};
}
const options = (extra={}) => ({language:'mixed',terms:['Kubernetes'],cacheOnly:true,channels:['microphone','call'],...extra});
const count = (f,type) => f.messages.filter(message => message.type===type).length;

test('boots and prepares actual SDK contract: two PCM clients, local asset base, events and native hints', async () => {
  const f=fixture(), hints={cores:4,memoryGB:8,mobile:false,saveData:false};
  assert.equal(f.messages[0].type,'boot');
  assert.equal(await f.bridge.prepare(options({deviceHints:hints,allowLargeModels:false})),true);
  assert.equal(f.clients.length,2);
  for(const client of f.clients) {
    assert.equal(client.options.assetBaseURL,'http://127.0.0.1:8766/sdk/');
    assert.equal(client.options.language,'mixed');
    assert.equal(client.options.cacheOnly,true);
    assert.equal(client.options.deviceHints,hints);
    assert.equal(client.options.allowLargeModels,false);
    assert.equal(client.prepareInput.input,'pcm');
    assert.equal(client.startInput.input,'pcm');
  }
  assert.equal(count(f,'ready'),1);
  f.clients[1].emit({type:'backend',backend:'local:whisper',localOnly:true});
  assert.equal(f.messages.at(-1).channel,'call');
  assert.equal(f.messages.at(-1).event.backend,'local:whisper');
  await f.bridge.stop();
});

test('serializes each channel, channels independent, ACK follows write completion', async () => {
  const gate=deferred();
  const f=fixture({write:client=>client===f.clients[0]&&client.writes.length===1?gate.promise:undefined});
  await f.bridge.prepare(options());
  const p1=f.bridge.audio('microphone',pcm([.1]),16000,1);
  const p2=f.bridge.audio('microphone',pcm([.2]),16000,2);
  const p3=f.bridge.audio('call',pcm([.3]),16000,3);
  await tick();
  assert.equal(f.clients[0].writes.length,1);
  assert.equal(await p3,true);
  assert.deepEqual(f.messages.filter(m=>m.type==='ack').map(m=>m.packetId),[3]);
  gate.resolve(); await Promise.all([p1,p2]);
  assert.deepEqual(f.messages.filter(m=>m.type==='ack').map(m=>m.packetId),[3,1,2]);
  assert.ok(Math.abs(f.clients[0].writes[1].samples[0]-.2)<1e-6);
  await f.bridge.stop();
});

test('normal stop drains queue, forwards final flush before stopped, disposes and suppresses late callbacks', async () => {
  const gate=deferred();
  const f=fixture({write:()=>gate.promise,stop:client=>client.emit({type:'final',text:'Последняя фраза'})});
  await f.bridge.prepare(options({channels:['microphone']}));
  const write=f.bridge.audio('microphone',pcm(),16000,1);
  await tick(); const stop=f.bridge.stop();
  assert.equal(f.bridge.stop(),stop);
  await tick(); assert.equal(f.clients[0].stopped,0);
  gate.resolve(); await Promise.all([write,stop]);
  const types=f.messages.map(m=>m.type==='event'?m.event.type:m.type);
  assert.ok(types.indexOf('ack')<types.indexOf('final'));
  assert.ok(types.indexOf('final')<types.indexOf('stopped'));
  assert.equal(f.clients[0].disposed,1);
  const before=f.messages.length;
  f.clients[0].emit({type:'final',text:'stale'});
  assert.equal(f.messages.length,before);
});

test('stop cancels preparation without waiting for model load and permits a clean restart', async () => {
  const gate=deferred(); let first=true;
  const f=fixture({prepare:()=>{if(first){first=false;return gate.promise;}}});
  const preparation=f.bridge.prepare(options()); await tick();
  await f.bridge.stop();
  assert.equal(f.clients[0].disposed,1);
  assert.equal(count(f,'ready'),0);
  assert.equal(await f.bridge.prepare(options({channels:['call']})),true);
  gate.resolve(); assert.equal(await preparation,false);
  assert.equal(count(f,'ready'),1);
  assert.equal(f.clients[0].startInput,undefined);
  await f.bridge.stop();
});

test('second channel preparation failure cleans up first channel and never signals ready', async () => {
  const f=fixture({prepare:client=>{if(client===f.clients[1])throw Error('No model');}});
  assert.equal(await f.bridge.prepare(options()),false);
  assert.equal(count(f,'failure'),1); assert.equal(count(f,'ready'),0);
  assert.ok(f.clients.every(c=>c.disposed===1));
});

test('write failure closes all channels, cancels queued work and never ACKs failed packets', async () => {
  const gate=deferred(); const f=fixture({write:()=>gate.promise});
  await f.bridge.prepare(options());
  const p1=f.bridge.audio('microphone',pcm(),16000,1);
  const p2=f.bridge.audio('microphone',pcm(),16000,2);
  await tick(); gate.reject(Error('Worker died'));
  assert.deepEqual(await Promise.all([p1,p2]),[false,false]);
  assert.equal(count(f,'ack'),0); assert.equal(count(f,'failure'),1);
  assert.equal(f.clients[0].writes.length,1);
  assert.ok(f.clients.every(c=>c.disposed===1));
});

test('SDK fatal event propagates then cleans all clients with stale callbacks suppressed', async () => {
  const f=fixture(); await f.bridge.prepare(options());
  f.clients[0].emit({type:'error',message:'Backend failed'});
  f.clients[1].emit({type:'partial',text:'late'});
  await tick();
  assert.equal(count(f,'failure'),1);
  assert.equal(f.messages.some(m=>m.event?.text==='late'),false);
  assert.ok(f.clients.every(c=>c.disposed===1));
});

for (const [name,encoded,rate] of [
  ['bad base64','!!!!',16000], ['unaligned bytes','AQ==',16000],
  ['empty','',16000], ['NaN',pcm([NaN]),16000], ['out of range',pcm([1.1]),16000],
  ['invalid rate',pcm(),7999], ['fractional rate',pcm(),16000.5],
  ['over one second',pcm(Array(8001).fill(0)),8000],
]) test(`rejects ${name} PCM and releases clients`,async()=>{
  const f=fixture(); await f.bridge.prepare(options());
  assert.equal(await f.bridge.audio('microphone',encoded,rate,1),false);
  assert.equal(count(f,'failure'),1); assert.equal(count(f,'ack'),0);
  assert.equal(f.clients[0].writes.length,0); assert.ok(f.clients.every(c=>c.disposed===1));
});

test('rejects changing sample rate within a channel', async()=>{
  const f=fixture();await f.bridge.prepare(options());
  await f.bridge.audio('microphone',pcm(),16000,1);
  assert.equal(await f.bridge.audio('microphone',pcm(),48000,2),false);
  assert.equal(count(f,'failure'),1);
});

test('caps queued packets at 150 per channel before allocating or writing extra packets', async()=>{
  const gate=deferred();const f=fixture({write:()=>gate.promise});
  await f.bridge.prepare(options());
  const writes=[];for(let i=0;i<150;i++)writes.push(f.bridge.audio('microphone',pcm(),16000,i));
  await tick();
  assert.equal(await f.bridge.audio('microphone',pcm(),16000,150),false);
  gate.resolve();await Promise.all(writes);
  assert.equal(count(f,'failure'),1);assert.equal(count(f,'ack'),0);
  assert.equal(f.clients[0].writes.length,1);
});

test('validates configuration without creating SDK clients',async()=>{
  for(const config of [options({language:'fr'}),options({channels:[]}),options({channels:['call','call']}),options({channels:['system']}),options({cacheOnly:1}),options({terms:['']}),options({terms:['a\nb']})]){
    const f=fixture();assert.equal(await f.bridge.prepare(config),false);assert.equal(f.clients.length,0);assert.equal(count(f,'failure'),1);
  }
});

test('HTML references packaged SDK before native bridge',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../apps/mac/Web/bridge.html'),'utf8');
  assert.ok(html.indexOf('src="/sdk/local-speech.js"')<html.indexOf('src="/bridge.js"'));
  assert.equal(/https?:\/\//.test(html),false);
});

test('per-channel sample rates are independent and maximum 96kHz packet is accepted',async()=>{
  const f=fixture();await f.bridge.prepare(options());
  assert.equal(await f.bridge.audio('microphone',pcm(),16000,1),true);
  assert.equal(await f.bridge.audio('call',pcm(Array(96000).fill(0)),96000,1),true);
  assert.equal(f.clients[1].writes[0].samples.length,96000);
  assert.equal(count(f,'failure'),0);await f.bridge.stop();
});

test('rejects unknown channels and invalid packet IDs without processing audio',async()=>{
  for(const [channel,id] of [['unknown',1],['call',-1],['call',{}],['call','']]){
    const f=fixture();await f.bridge.prepare(options());
    assert.equal(await f.bridge.audio(channel,pcm(),16000,id),false);
    assert.equal(count(f,'ack'),0);assert.equal(count(f,'failure'),1);
    assert.ok(f.clients.every(c=>c.disposed===1));
  }
});

test('duplicate pending IDs fail explicitly rather than creating ambiguous ACKs',async()=>{
  const gate=deferred();const f=fixture({write:()=>gate.promise});await f.bridge.prepare(options());
  const first=f.bridge.audio('call',pcm(),16000,4);await tick();
  assert.equal(await f.bridge.audio('call',pcm(),16000,4),false);
  gate.resolve();await first;
  assert.equal(count(f,'ack'),0);assert.equal(count(f,'failure'),1);
});

test('second prepare during live session fails explicitly and disposes all clients',async()=>{
  const f=fixture();await f.bridge.prepare(options());
  assert.equal(await f.bridge.prepare(options()),false);
  assert.equal(count(f,'failure'),1);assert.equal(f.clients.length,2);
  assert.ok(f.clients.every(c=>c.disposed===1));
});


test('upstream native backlog reaches each serialized SDK write, not just the one in-flight packet',async()=>{
  const gate=deferred();const f=fixture({write:client=>client.writes.length===1?gate.promise:undefined});
  await f.bridge.prepare(options({channels:['call']}));
  const jobs=Array.from({length:12},(_,i)=>f.bridge.audio('call',pcm(),16000,i));
  await tick();assert.equal(f.clients[0].writes.length,1);
  assert.equal(f.clients[0].writes[0].hints.pendingPackets,12);
  gate.resolve();await Promise.all(jobs);
  assert.deepEqual(f.clients[0].writes.map(w=>w.hints.pendingPackets),Array.from({length:12},(_,i)=>12-i));
  await f.bridge.stop();
});

test('stop bounds a blocked recovery write, cancels clients, reports incomplete tail and permits restart',async()=>{
  const gate=deferred();let expire,cleared=false;
  const f=fixture({write:()=>gate.promise,dispose:()=>gate.resolve(),timers:{
    setTimeout(fn,ms){assert.equal(ms,8000);expire=fn;return 1;},clearTimeout(){cleared=true;},
  }});
  await f.bridge.prepare(options({channels:['call']}));
  const jobs=[f.bridge.audio('call',pcm(),16000,1),f.bridge.audio('call',pcm(),16000,2)];
  await tick();let done=false;const stopping=f.bridge.stop();stopping.then(()=>done=true);
  await tick();assert.equal(done,false);assert.equal(f.clients[0].disposed,0);
  expire();await stopping;assert.equal(done,true);assert.equal(cleared,true);
  assert.deepEqual(await Promise.all(jobs),[false,false]);assert.equal(count(f,'ack'),0);
  assert.equal(count(f,'failure'),1);assert.match(f.messages.find(m=>m.type==='failure').message,/tail.*8 seconds.*cancelled/i);
  assert.equal(count(f,'stopped'),1);assert.equal(f.clients[0].disposed,1);
  assert.equal(await f.bridge.prepare(options({channels:['call']})),true);await f.bridge.stop();
});

test('stop flushes both independent channel workers concurrently before disposal',async()=>{
  const a=deferred(),b=deferred();const f=fixture({stop:client=>client===f.clients[0]?a.promise:b.promise});
  await f.bridge.prepare(options());const stopping=f.bridge.stop();await tick();
  assert.deepEqual(f.clients.map(c=>c.stopped),[1,1]);assert.equal(count(f,'stopped'),0);
  a.resolve();await tick();assert.equal(count(f,'stopped'),0);
  b.resolve();await stopping;assert.equal(count(f,'stopped'),1);assert.ok(f.clients.every(c=>c.disposed===1));
});
