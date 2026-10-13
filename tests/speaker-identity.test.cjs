const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {normalizeEmbedding,resampleSpeakerPCM}=require('../speaker-worker.js');
function harness(){
 const workers=[];
 class Worker{constructor(url){this.url=url;this.messages=[];workers.push(this);}postMessage(data){this.messages.push(data);}terminate(){this.terminated=true;}reply(data){this.onmessage({data});}}
 const context={URL,Worker,Float32Array,setTimeout,clearTimeout,location:{href:'https://local.test/',origin:'https://local.test'}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../sdk/speaker-identity.js'),'utf8'),context);
 return {workers,create:options=>context.LocalSpeechSpeakers.create({assetBaseURL:'https://local.test/sdk/',...options})};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('prepare is shared and starts only a same-origin dedicated worker',async()=>{
 const h=harness();for(const assetBaseURL of ['https://elsewhere.test/','https://local.test/sdk','file:///tmp/'])assert.throws(()=>h.create({assetBaseURL}));
 const client=h.create(),a=client.prepare(),b=client.prepare();assert.equal(a,b);assert.equal(h.workers.length,1);
 const worker=h.workers[0];assert.equal(worker.url.href,'https://local.test/sdk/speaker-worker.js');
 worker.reply({type:'ready',id:worker.messages[0].id});await a;await client.prepare();assert.equal(worker.messages.length,1);await client.dispose();
});
test('embedding copies source PCM, validates normalized output and ignores stale replies',async()=>{
 const h=harness(),client=h.create(),pcm=new Float32Array(16000).fill(.1),job=client.embed(pcm,16000),worker=h.workers[0];
 pcm.fill(.9);worker.reply({type:'ready',id:worker.messages[0].id});await tick();
 const request=worker.messages[1];assert.ok(Math.abs(new Float32Array(request.samples)[0]-.1)<1e-6);
 worker.reply({type:'embedding',id:999,embedding:new Float32Array(256).fill(1/16).buffer});
 worker.reply({type:'embedding',id:request.id,embedding:new Float32Array(256).fill(1/16).buffer});
 const result=await job;assert.equal(result.length,256);assert.ok(Math.abs(result.reduce((sum,x)=>sum+x*x,0)-1)<1e-6);await client.dispose();
});
test('queue is bounded during preparation and disposal rejects every pending operation',async()=>{
 const h=harness(),client=h.create(),pcm=new Float32Array(16000).fill(.1);
 const first=assert.rejects(client.embed(pcm,16000),/disposed/),second=assert.rejects(client.embed(pcm,16000),/disposed/);
 await assert.rejects(client.embed(pcm,16000),/queue is full/);await client.dispose();await Promise.all([first,second]);assert.equal(h.workers[0].terminated,true);await assert.rejects(client.prepare(),/disposed/);
});
test('malformed input never starts inference and malformed embeddings reject',async()=>{
 const h=harness(),client=h.create();
 for(const [pcm,rate] of [[new Float32Array(15999),16000],[new Float32Array(240001),16000],[new Float32Array(16000).fill(NaN),16000],[new Float32Array(16000).fill(2),16000],[new Float32Array(16000),16000.5]])await assert.rejects(client.embed(pcm,rate));
 assert.equal(h.workers.length,0);const job=client.embed(new Float32Array(16000).fill(.1),16000),rejection=assert.rejects(job,/Invalid speaker embedding/);
 const worker=h.workers[0];worker.reply({type:'ready',id:worker.messages[0].id});await tick();worker.reply({type:'embedding',id:worker.messages[1].id,embedding:new Float32Array(256).buffer});await rejection;await client.dispose();
});
test('worker failure terminates processing and settles caller promises',async()=>{
 const h=harness(),client=h.create(),job=assert.rejects(client.prepare(),/runtime failed/);h.workers[0].onerror({message:'runtime failed',preventDefault(){}});await job;assert.equal(h.workers[0].terminated,true);
});
test('speaker PCM resampling retains duration, DC level and rejects silence',()=>{
 for(const rate of [8000,16000,44100,48000,96000]){const result=resampleSpeakerPCM(new Float32Array(rate*3).fill(.125),rate);assert.equal(result.length,48000);assert.ok(result.every(x=>Math.abs(x-.125)<1e-6));}
 assert.throws(()=>resampleSpeakerPCM(new Float32Array(16000),16000),/audible/);
 assert.throws(()=>resampleSpeakerPCM(new Float32Array(16000).fill(Infinity),16000),/Invalid/);
});
test('speaker vectors are normalized without changing their direction',()=>{
 const vector=new Float32Array(256);vector[0]=3;vector[1]=4;const normalized=normalizeEmbedding(vector);assert.ok(Math.abs(normalized[0]-.6)<1e-6);assert.ok(Math.abs(normalized[1]-.8)<1e-6);assert.equal(vector[0],3);
 for(const value of [new Float32Array(128),new Float32Array(256),new Float32Array(256).fill(NaN)])assert.throws(()=>normalizeEmbedding(value));
});
