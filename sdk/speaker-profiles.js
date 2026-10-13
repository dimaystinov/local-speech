/* Local, conservative voice matching. Cosine similarity is not an accuracy estimate. */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.LocalSpeechVoiceProfiles=api;
})(globalThis,function(){
  'use strict';
  const MODEL_ID='wespeaker-resnet34-lm-q8@6a61a1833ff2583aabeba044f5c8221f00b67ceb',DIMENSION=256;
  const controls=/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
  function normalize(embedding){
    if(!(Array.isArray(embedding)||embedding instanceof Float32Array)||embedding.length!==DIMENSION)throw Error('Speaker embedding must have 256 values');
    let scale=0;
    for(const v of embedding){if(typeof v!=='number'||!Number.isFinite(v))throw Error('Speaker embedding must be finite');scale=Math.max(scale,Math.abs(v));}
    if(scale===0)throw Error('Speaker embedding must be nonzero');
    let sum=0;for(const v of embedding)sum+=(v/scale)**2;
    const norm=Math.sqrt(sum);
    return Float32Array.from(embedding,v=>(v/scale)/norm);
  }
  function dot(a,b){let sum=0;for(let i=0;i<DIMENSION;i++)sum+=a[i]*b[i];return Math.max(-1,Math.min(1,sum));}
  function cosine(a,b){return dot(normalize(a),normalize(b));}
  function validateProfile(profile){
    if(!profile||typeof profile!=='object'||Array.isArray(profile))throw Error('Invalid voice profile');
    const {id,name,modelId,embedding}=profile;
    if(typeof id!=='string'||id.length<1||id.length>80||! /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))throw Error('Invalid voice profile id');
    if(typeof name!=='string'||name.length>80||!name.trim()||controls.test(name))throw Error('Invalid voice profile name');
    if(modelId!==MODEL_ID)throw Error('Voice profile model mismatch');
    if(!Array.isArray(embedding))throw Error('Voice profile embedding must be an array');
    return Object.freeze({id,name:name.trim(),modelId,embedding:Object.freeze(Array.from(normalize(embedding)))});
  }
  function threshold(value,fallback,min,label){
    const result=value===undefined?fallback:value;
    if(typeof result!=='number'||!Number.isFinite(result)||result<min||result>1)throw Error('Invalid '+label);
    return result;
  }
  class Session {
    #profiles; #clusters=[]; #knownThreshold; #anonymousThreshold; #margin; #maxClusters;
    constructor(profiles=[],options={}){
      if(!Array.isArray(profiles)||profiles.length>100)throw Error('At most 100 voice profiles are supported');
      if(!options||typeof options!=='object'||Array.isArray(options))throw Error('Invalid matching options');
      this.#profiles=profiles.map(validateProfile);
      if(new Set(this.#profiles.map(p=>p.id)).size!==this.#profiles.length)throw Error('Duplicate voice profile id');
      this.#knownThreshold=threshold(options.knownThreshold,.75,.75,'known threshold');
      this.#anonymousThreshold=threshold(options.anonymousThreshold,.7,.7,'anonymous threshold');
      this.#margin=threshold(options.margin,.08,.08,'winner margin');
      this.#maxClusters=options.maxClusters===undefined?16:options.maxClusters;
      if(!Number.isInteger(this.#maxClusters)||this.#maxClusters<1||this.#maxClusters>16)throw Error('At most 16 anonymous voices are supported');
    }
    classify(embedding){
      if(!(embedding instanceof Float32Array))throw Error('Expected Float32Array speaker embedding');
      const vector=normalize(embedding);
      const ranked=this.#profiles.map(profile=>({profile,score:dot(vector,profile.embedding)})).sort((a,b)=>b.score-a.score);
      const best=ranked[0];
      const uncertain=similarity=>({speakerId:null,label:'Голос не определён',kind:'uncertain',similarity});
      if(best&&best.score>=this.#knownThreshold){
        if(ranked[1]&&best.score-ranked[1].score<this.#margin)return uncertain(best.score);
        return {speakerId:best.profile.id,label:best.profile.name,kind:'known',similarity:best.score};
      }
      const anonymous=this.#clusters.map(cluster=>({cluster,score:dot(vector,cluster.anchor)})).sort((a,b)=>b.score-a.score);
      const match=anonymous[0];
      if(match&&match.score>=this.#anonymousThreshold){
        if(anonymous[1]&&match.score-anonymous[1].score<this.#margin)return uncertain(match.score);
        // Keep the first embedding as the anchor; observations cannot drift an identity.
        return {speakerId:match.cluster.id,label:match.cluster.label,kind:'anonymous',similarity:match.score};
      }
      if(this.#clusters.length>=this.#maxClusters)return uncertain(match?.score??best?.score??null);
      const index=this.#clusters.length+1;
      const cluster={id:'voice'+index,label:'Голос '+index,anchor:vector};
      this.#clusters.push(cluster);
      return {speakerId:cluster.id,label:cluster.label,kind:'anonymous',similarity:null};
    }
  }
  class AudioRing {
    #maxSeconds; #buffer=null; #rate=null; #total=0; #size=0;
    constructor(maxSeconds=40){
      if(typeof maxSeconds!=='number'||!Number.isFinite(maxSeconds)||maxSeconds<=0||maxSeconds>40)throw Error('Audio ring duration must be greater than 0 and at most 40 seconds');
      this.#maxSeconds=maxSeconds;
    }
    get rate(){return this.#rate;}
    get startMs(){return this.#rate?(this.#total-this.#size)*1000/this.#rate:0;}
    get endMs(){return this.#rate?this.#total*1000/this.#rate:0;}
    reset(){this.#buffer=null;this.#rate=null;this.#total=0;this.#size=0;}
    append(samples,rate){
      if(!(samples instanceof Float32Array)||!Number.isInteger(rate)||rate<8000||rate>96000||samples.length<1||samples.length>rate)throw Error('Audio ring requires at most one second of PCM at 8000..96000 Hz');
      if(this.#rate!==null&&this.#rate!==rate)throw Error('Audio ring sample rate changed; reset first');
      for(const v of samples)if(!Number.isFinite(v)||Math.abs(v)>1)throw Error('Audio ring PCM must be finite and normalized');
      if(!Number.isSafeInteger(this.#total+samples.length))throw Error('Audio ring timeline exhausted');
      if(!this.#buffer){this.#rate=rate;this.#buffer=new Float32Array(Math.max(1,Math.floor(this.#maxSeconds*rate)));}
      const startMs=this.endMs,capacity=this.#buffer.length;
      for(let i=0;i<samples.length;i++)this.#buffer[(this.#total+i)%capacity]=samples[i];
      this.#total+=samples.length;this.#size=Math.min(capacity,this.#size+samples.length);
      return {startMs,endMs:this.endMs};
    }
    get(startMs,endMs){
      if(!this.#buffer||typeof startMs!=='number'||typeof endMs!=='number'||!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||endMs<=startMs)return null;
      // Half-open ranges include only samples lying within the requested interval.
      const start=Math.ceil(startMs*this.#rate/1000-1e-7),end=Math.floor(endMs*this.#rate/1000+1e-7);
      if(start<this.#total-this.#size||end>this.#total||end<=start)return null;
      const result=new Float32Array(end-start);
      for(let i=0;i<result.length;i++)result[i]=this.#buffer[(start+i)%this.#buffer.length];
      return result;
    }
  }
  return Object.freeze({MODEL_ID,DIMENSION,normalize,cosine,validateProfile,Session,AudioRing});
});
