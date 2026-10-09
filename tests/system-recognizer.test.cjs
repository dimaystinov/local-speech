const {test}=require('node:test');const assert=require('node:assert/strict');
const {SystemRecognizer,parseContextTerms}=require('../system-recognizer.js');
function fake(){class API{constructor(){API.instances.push(this);}start(){this.onstart?.();}stop(){this.onend?.();}abort(){this.onend?.();}}
API.instances=[];API.prototype.processLocally=false;API.available=async()=> 'available';return API;}
test('unsupported system API is never treated as local',async()=>{const r=new SystemRecognizer(class {},()=>{},()=>{});assert.equal((await r.check('ru-RU')).status,'unsupported');assert.throws(()=>r.start('ru-RU','s'));});
test('availability and installation explicitly require local processing',async()=>{const API=fake();let request;API.available=async x=>{request=x;return 'downloadable';};const r=new SystemRecognizer(API,()=>{},()=>{});assert.equal((await r.check('ru-RU')).status,'downloadable');assert.deepEqual(request,{langs:['ru-RU'],processLocally:true});API.install=async x=>{assert.deepEqual(x,{langs:['ru-RU'],processLocally:true});return false;};await assert.rejects(r.install('ru-RU'));});
test('interim updates are emitted before final and final is not duplicated',()=>{const API=fake(),out=[];const r=new SystemRecognizer(API,x=>out.push(x),()=>{});r.start('ru-RU','s');const api=API.instances[0];assert.equal(api.processLocally,true);assert.equal(api.continuous,true);assert.equal(api.interimResults,true);const result=(text,isFinal)=>Object.assign([{transcript:text}],{isFinal});api.onresult({resultIndex:0,results:[result('привет',false)]});api.onresult({resultIndex:0,results:[result('привет мир',true)]});api.onresult({resultIndex:0,results:[result('привет мир',true)]});assert.deepEqual(out.map(x=>x.type),['partial','final']);assert.equal(out[0].segmentId,out[1].segmentId);r.dispose();});
test('fatal errors never retry with cloud and disposed results are ignored',()=>{const API=fake(),out=[],states=[];const r=new SystemRecognizer(API,x=>out.push(x),(s)=>states.push(s));r.start('en-US','s');const api=API.instances[0];api.onerror({error:'language-not-supported'});assert.equal(r.active,false);assert.equal(API.instances.length,1);assert.ok(states.includes('error'));r.dispose();api.onresult({resultIndex:0,results:[Object.assign([{transcript:'stale'}],{isFinal:true})]});assert.equal(out.filter(x=>x.type==='final').length,0);});
test('pause closes only an interim utterance, retains engine final',()=>{const API=fake(),out=[];const r=new SystemRecognizer(API,x=>out.push(x),()=>{});r.start('ru-RU','s');const api=API.instances[0];let stops=0;api.stop=()=>{stops++;};r.endPhrase();assert.equal(stops,0);api.onresult({resultIndex:0,results:[Object.assign([{transcript:'первая фраза'}],{isFinal:false})]});r.endPhrase();r.endPhrase();assert.equal(stops,1);api.onresult({resultIndex:0,results:[Object.assign([{transcript:'Первая фраза.'}],{isFinal:true})]});assert.deepEqual(out.map(x=>x.type),['partial','final']);r.dispose();});
test('context terms are bounded, trimmed and deduplicated',()=>{
 assert.deepEqual(parseContextTerms(' Docker, Python\nDocker; API,, '),['Docker','Python','API']);
 assert.equal(parseContextTerms(Array.from({length:110},(_,i)=>'term'+i).join(',')).length,100);
 assert.equal([...parseContextTerms('я'.repeat(100))[0]].length,80);
});
test('context is passed before start and reapplied on restart, keeping local processing',()=>{
 const API=fake();API.prototype.phrases=[];
 class Phrase{constructor(phrase,boost){this.phrase=phrase;this.boost=boost;}}
 const r=new SystemRecognizer(API,()=>{},()=>{},Phrase);r.start('ru-RU','s',['Docker','Python']);
 assert.deepEqual(API.instances[0].phrases.map(x=>x.phrase),['Docker','Python']);
 assert.equal(API.instances[0].phrases[0].boost,3);assert.equal(r.contextInfo.status,'applied');
 r.open(r.generation);assert.equal(API.instances[1].processLocally,true);assert.equal(API.instances[1].phrases.length,2);r.dispose();
});
test('missing contextual API does not masquerade as applied or prevent local recognition',()=>{
 const API=fake(),r=new SystemRecognizer(API,()=>{},()=>{});r.start('ru-RU','s',['Docker']);
 assert.equal(r.contextInfo.status,'unsupported');assert.equal(API.instances[0].processLocally,true);r.dispose();
});
test('rejected phrases recover without phrases, never enabling cloud processing',async()=>{
 const API=fake();API.prototype.phrases=[];
 const r=new SystemRecognizer(API,()=>{},()=>{},class Phrase{});r.start('ru-RU','s',['Docker']);
 API.instances[0].onerror({error:'phrases-not-supported'});
 await new Promise(resolve=>setTimeout(resolve,400));
 assert.equal(API.instances.length,2);assert.equal(API.instances[1].processLocally,true);
 assert.equal(r.contextInfo.status,'rejected');assert.equal(API.instances[1].phrases.length,0);r.dispose();
});
test('native end with unfinished interim reports recovery once and retains raw evidence',()=>{
 const API=fake(),out=[],states=[];const r=new SystemRecognizer(API,x=>out.push(x),(state,message)=>states.push({state,message}));
 r.start('ru-RU','s');const api=API.instances[0];api.onresult({resultIndex:0,results:[Object.assign([{transcript:'сырая фраза'}],{isFinal:false})]});api.onend();
 assert.equal(r.active,false);assert.equal(states.filter(x=>x.state==='error').length,1);assert.equal(states.some(x=>x.state==='restarting'),false);
 const evidence=out.find(x=>x.type==='interrupted');assert.equal(evidence.text,'сырая фраза');assert.equal(evidence.timingReliable,false);assert.equal(out.some(x=>x.type==='final'),false);r.dispose();
});
test('fatal native errors retain unfinished evidence exactly once before invalidating callbacks',()=>{
 const API=fake(),out=[],states=[];const r=new SystemRecognizer(API,x=>out.push(x),(state)=>states.push(state));
 r.start('ru-RU','s');const api=API.instances[0];api.onresult({resultIndex:0,results:[Object.assign([{transcript:'до ошибки сети'}],{isFinal:false})]});api.onerror({error:'network'});api.onend();
 const evidence=out.filter(x=>x.type==='interrupted');assert.equal(evidence.length,1);assert.equal(evidence[0].text,'до ошибки сети');assert.equal(evidence[0].reason,'network');assert.equal(states.filter(x=>x==='error').length,1);assert.equal(r.active,false);
});
test('explicit stop with unfinished native speech reports incompleteness without restart',()=>{
 const API=fake(),out=[],states=[];const r=new SystemRecognizer(API,x=>out.push(x),(state,message)=>states.push({state,message}));
 r.start('ru-RU','s');API.instances[0].onresult({resultIndex:0,results:[Object.assign([{transcript:'незавершённый ввод'}],{isFinal:false})]});r.stop();
 assert.equal(out.filter(x=>x.type==='interrupted').length,1);assert.equal(states.at(-1).state,'stopped-incomplete');assert.match(states.at(-1).message,/аудио|буфер/i);assert.equal(states.some(x=>x.state==='restarting'||x.state==='error'),false);r.dispose();
});
test('disposed audio and speech callbacks cannot resurrect listening state',()=>{const API=fake(),states=[],r=new SystemRecognizer(API,()=>{},x=>states.push(x));r.start('ru-RU','s');const api=API.instances[0];r.dispose();const count=states.length;api.onaudiostart?.();api.onspeechstart?.();api.onstart?.();assert.equal(states.length,count);});
test('duplicate end and callbacks from replaced native instance are ignored',async()=>{const API=fake(),states=[],out=[],r=new SystemRecognizer(API,x=>out.push(x),x=>states.push(x));r.start('ru-RU','s');const old=API.instances[0];old.onend();old.onend();await new Promise(resolve=>setTimeout(resolve,400));assert.equal(API.instances.length,2);const count=states.length;old.onerror({error:'network'});old.onresult({resultIndex:0,results:[Object.assign([{transcript:'stale'}],{isFinal:true})]});assert.equal(r.active,true);assert.equal(states.length,count);assert.equal(out.some(x=>x.text==='stale'),false);r.dispose();});
test('synchronous start failure leaves no active recognition or restart timer',()=>{const API=fake();API.prototype.start=function(){throw Error('start failed');};let aborts=0;API.prototype.abort=function(){aborts++;this.onend?.();};const r=new SystemRecognizer(API,()=>{},()=>{});assert.throws(()=>r.start('ru-RU','s'),/start failed/);assert.equal(r.active,false);assert.equal(aborts,1);assert.equal(r.timer,undefined);r.dispose();});
test('starting a replacement aborts previous recognizer and rejects old events',()=>{const API=fake(),out=[],r=new SystemRecognizer(API,x=>out.push(x),()=>{});r.start('ru-RU','one');const old=API.instances[0];let aborted=false;old.abort=()=>{aborted=true;old.onend?.();};r.start('en-US','two');assert.equal(aborted,true);old.onresult({resultIndex:0,results:[Object.assign([{transcript:'old'}],{isFinal:true})]});assert.equal(out.length,0);r.dispose();});
test('throwing consumer callbacks cannot leave a fatal recognition active',()=>{const API=fake(),r=new SystemRecognizer(API,()=>{throw Error('emit');},()=>{throw Error('state');});assert.doesNotThrow(()=>r.start('ru-RU','s'));const api=API.instances[0];assert.doesNotThrow(()=>api.onresult({resultIndex:0,results:[Object.assign([{transcript:'partial'}],{isFinal:false})]}));assert.doesNotThrow(()=>api.onerror({error:'network'}));assert.equal(r.active,false);r.dispose();});
test('consumer disposing during context notification prevents native start',()=>{const API=fake();let starts=0,r;API.prototype.start=function(){starts++;};r=new SystemRecognizer(API,()=>{},state=>{if(state==='context')r.dispose();});r.start('ru-RU','s');assert.equal(starts,0);assert.equal(r.active,false);});
test('consumer disposing on first result suppresses remaining results in same event',()=>{const API=fake(),out=[];let r;r=new SystemRecognizer(API,x=>{out.push(x);r.dispose();},()=>{});r.start('ru-RU','s');API.instances[0].onresult({resultIndex:0,results:['first','second'].map(transcript=>Object.assign([{transcript}],{isFinal:true}))});assert.equal(out.length,1);});
test('consumer starting a session from interrupted evidence is not cancelled by old error',()=>{const API=fake(),out=[];let r;r=new SystemRecognizer(API,x=>{out.push(x);if(x.type==='interrupted')r.start('en-US','new');},()=>{});r.start('ru-RU','old');const old=API.instances[0];old.onresult({resultIndex:0,results:[Object.assign([{transcript:'partial'}],{isFinal:false})]});old.onerror({error:'network'});assert.equal(r.active,true);assert.equal(r.sessionId,'new');r.dispose();});
test('stop between native sessions cancels restart and reports stopped promptly',async()=>{const API=fake(),states=[],r=new SystemRecognizer(API,()=>{},x=>states.push(x));r.start('ru-RU','s');API.instances[0].onend();r.stop();assert.equal(states.at(-1),'stopped');await new Promise(resolve=>setTimeout(resolve,400));assert.equal(API.instances.length,1);r.dispose();});
test('structured context hints retain punctuation, spacing and duplicates without mutating input',()=>{const API=fake();API.prototype.phrases=[];class Phrase{constructor(phrase){this.phrase=phrase;}}const terms=Object.freeze(['ACME, Inc.','  C++; API  ','ACME, Inc.']),r=new SystemRecognizer(API,()=>{},()=>{},Phrase);r.start('en-US','s',terms);assert.deepEqual(API.instances[0].phrases.map(x=>x.phrase),terms);assert.notEqual(r.terms,terms);r.dispose();});
test('invalid structured hints fail before replacing the current recognizer',()=>{const API=fake(),r=new SystemRecognizer(API,()=>{},()=>{});r.start('en-US','existing');const current=r.recognition;for(const terms of ['Docker',[''],['   '],[42],['bad\nterm'],['x'.repeat(81)],Array(101).fill('term')])assert.throws(()=>r.start('en-US','invalid',terms),/terms|term/i);assert.equal(r.recognition,current);assert.equal(r.active,true);assert.equal(r.sessionId,'existing');r.dispose();});
test('structured hints accept the existing 100 by 80 character native limit',()=>{const API=fake(),r=new SystemRecognizer(API,()=>{},()=>{}),terms=Array.from({length:100},(_,i)=>String(i).padEnd(80,'x'));r.start('en-US','s',terms);assert.deepEqual(r.terms,terms);r.dispose();});
