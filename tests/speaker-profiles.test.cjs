const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {MODEL_ID,DIMENSION,normalize,cosine,validateProfile,Session,AudioRing}=require('../sdk/speaker-profiles.js');
const axis=(index=0)=>{const v=new Float32Array(DIMENSION);v[index]=1;return v;};
const vector=(a,b)=>{const v=axis();v[0]=a;v[1]=b;return normalize(v);};
const profile=(id='person-a',name='Алексей',embedding=axis())=>({id,name,modelId:MODEL_ID,embedding:Array.from(embedding)});

test('exports the same portable browser API and full model fingerprint',()=>{
 const ctx={};vm.runInNewContext(fs.readFileSync(require.resolve('../sdk/speaker-profiles.js'),'utf8'),ctx);
 assert.equal(ctx.LocalSpeechVoiceProfiles.MODEL_ID,MODEL_ID);
 assert.equal(MODEL_ID,'wespeaker-resnet34-lm-q8@6a61a1833ff2583aabeba044f5c8221f00b67ceb');
 assert.equal(DIMENSION,256);
});
test('normalization is stable for very large and very small finite embeddings',()=>{
 for(const scale of [1e308,1e-308]){const values=Array(256).fill(0);values[0]=scale;values[1]=scale;const v=normalize(values);assert.ok(Math.abs(cosine(v,vector(1,1))-1)<1e-6);}
 assert.equal(cosine(axis(),axis(1)),0);assert.equal(cosine(axis(),Float32Array.from(axis(),v=>-v)),-1);
 for(const values of [[],new Float32Array(256),Array(256).fill(NaN),Array(256).fill(Infinity),Array(256).fill('1')])assert.throws(()=>normalize(values));
});
test('profiles validate model, bounded safe names, ids, dimensions and copies',()=>{
 const input=profile();input.embedding[0]=2;const result=validateProfile(input);input.embedding[0]=0;input.name='Changed';assert.equal(result.embedding[0],1);assert.equal(result.name,'Алексей');assert.ok(Object.isFrozen(result.embedding));
 for(const patch of [{modelId:'different'}, {embedding:new Float32Array(256)}, {embedding:[1]}, {id:'../profile'}, {id:'a'.repeat(81)}, {name:' '}, {name:'a'.repeat(81)}, {name:'Alex\nAdmin'}, {name:'Alex\u202e'}, {name:'Alex\u0000'}])assert.throws(()=>validateProfile({...profile(),...patch}));
 assert.equal(validateProfile({...profile(),name:'  Alex Smith  '}).name,'Alex Smith');
});
test('known voice is recognized without mutating enrollment or accepting labels as truth',()=>{
 const enrollment=profile(),session=new Session([enrollment]);const before=JSON.stringify(enrollment);
 assert.deepEqual(session.classify(axis()),{speakerId:'person-a',label:'Алексей',kind:'known',similarity:1});
 assert.equal(session.classify(vector(.8,.6)).kind,'known');assert.equal(JSON.stringify(enrollment),before);
 enrollment.embedding.fill(0);enrollment.name='Overwrite';assert.equal(session.classify(axis()).label,'Алексей');
});
test('similar enrolled voices return uncertain and are not enrolled as anonymous',()=>{
 const session=new Session([profile('a','A'),profile('b','B',vector(.99,.1))]);
 const result=session.classify(axis());assert.equal(result.kind,'uncertain');assert.equal(result.speakerId,null);
 assert.equal(session.classify(axis(2)).speakerId,'voice1');
});
test('unknown voices get stable session-only clusters and no false enrolled match',()=>{
 const session=new Session([profile()]);assert.equal(session.classify(axis(1)).speakerId,'voice1');
 assert.equal(session.classify(axis(1)).kind,'anonymous');assert.equal(session.classify(axis(2)).speakerId,'voice2');
 assert.equal(new Session().classify(axis(2)).speakerId,'voice1');
});
test('anonymous anchors cannot drift through incremental observations',()=>{
 const session=new Session();session.classify(axis());assert.equal(session.classify(vector(.71,.7)).speakerId,'voice1');
 assert.equal(session.classify(axis(1)).speakerId,'voice2');
});
test('ambiguous anonymous matches are uncertain',()=>{
 const session=new Session();session.classify(axis());session.classify(axis(1));assert.equal(session.classify(vector(1,1)).kind,'uncertain');
});
test('profile and cluster counts are hard bounded and options cannot loosen safeguards',()=>{
 assert.throws(()=>new Session(Array.from({length:101},(_,i)=>profile('id'+i))));
 assert.throws(()=>new Session([profile(),profile()]));
 for(const options of [{knownThreshold:.5},{anonymousThreshold:.6},{margin:0},{maxClusters:17},{maxClusters:0},{knownThreshold:NaN},{margin:Infinity}])assert.throws(()=>new Session([],options));
 const session=new Session();for(let i=0;i<16;i++)assert.equal(session.classify(axis(i)).speakerId,'voice'+(i+1));assert.equal(session.classify(axis(16)).kind,'uncertain');
 assert.equal(session.classify(axis()).speakerId,'voice1');assert.throws(()=>session.classify(Array.from(axis())));
});
test('ring returns copied precise timeline ranges across packet boundaries',()=>{
 const ring=new AudioRing(2);const a=new Float32Array(8000).fill(.25),b=new Float32Array(8000).fill(.5);
 assert.deepEqual(ring.append(a,8000),{startMs:0,endMs:1000});ring.append(b,8000);a.fill(0);
 assert.equal(ring.rate,8000);assert.equal(ring.startMs,0);assert.equal(ring.endMs,2000);
 const part=ring.get(500,1500);assert.equal(part.length,8000);assert.equal(part[0],.25);assert.equal(part[3999],.25);assert.equal(part[4000],.5);
 part.fill(0);assert.equal(ring.get(500,501)[0],.25);
});
test('ring trims at exact capacity and reset releases rate and timeline',()=>{
 const ring=new AudioRing(.5);ring.append(new Float32Array(8000).fill(.1),8000);
 assert.equal(ring.startMs,500);assert.equal(ring.get(0,1000),null);assert.equal(ring.get(500,1000).length,4000);
 ring.append(new Float32Array(1600).fill(.8),8000);assert.equal(ring.startMs,700);assert.equal(ring.endMs,1200);assert.equal(ring.get(700,1200).length,4000);
 assert.ok(Math.abs(ring.get(1000,1200)[0]-.8)<1e-6);ring.reset();assert.equal(ring.rate,null);assert.equal(ring.get(0,1),null);assert.equal(ring.endMs,0);
 ring.append(new Float32Array(4800),48000);assert.equal(ring.endMs,100);
});
test('invalid PCM never mutates ring and unavailable or malformed ranges return null',()=>{
 for(const seconds of [0,-1,41,Infinity,NaN])assert.throws(()=>new AudioRing(seconds));
 const ring=new AudioRing();ring.append(new Float32Array(800),8000);
 for(const [pcm,rate] of [[new Float32Array(8001),8000],[new Float32Array(),8000],[new Float32Array([NaN]),8000],[new Float32Array([2]),8000],[new Float32Array(10),16000],[new Float32Array(10),7999],[[],8000]])assert.throws(()=>ring.append(pcm,rate));
 assert.equal(ring.endMs,100);for(const times of [[-1,10],[0,101],[10,10],[10,9],[NaN,10],[0,Infinity],['0',1]])assert.equal(ring.get(...times),null);
});
