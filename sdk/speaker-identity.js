/* Optional, offline speaker embeddings. Recognition and profile matching are separate. */
(function(root){
  'use strict';
  const scriptBase=typeof document!=='undefined'&&document.currentScript?.src?new URL('.',document.currentScript.src).href:null;
  function validateSegmentation(result,expectedDuration){
    if(!result||!Number.isFinite(result.durationMs)||result.durationMs<1000||result.durationMs>15000||Math.abs(result.durationMs-expectedDuration)>.1||!Number.isFinite(result.processingMs)||result.processingMs<0||!Array.isArray(result.intervals)||result.intervals.length<1||result.intervals.length>1000)throw Error('Invalid speaker segmentation');
    let end=0;
    for(const item of result.intervals){
      if(!item||!Number.isFinite(item.startMs)||!Number.isFinite(item.endMs)||Math.abs(item.startMs-end)>.1||item.endMs<=item.startMs||item.endMs>result.durationMs+.1||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>1||!Array.isArray(item.speakers)||item.speakers.length>2||item.speakers.some((v,i)=>!Number.isInteger(v)||v<0||v>2||i>0&&v<=item.speakers[i-1]))throw Error('Invalid speaker segmentation interval');
      end=item.endMs;
    }
    if(Math.abs(end-result.durationMs)>.1)throw Error('Incomplete speaker segmentation');
    return result;
  }
  class SpeakerClient {
    constructor({assetBaseURL=scriptBase}={}){
      if(!assetBaseURL)throw Error('assetBaseURL is required');
      this.base=new URL(assetBaseURL,root.location?.href);
      if(!this.base.pathname.endsWith('/')||!['http:','https:'].includes(this.base.protocol)||root.location&&this.base.origin!==root.location.origin)throw Error('Serve speaker assets on the application origin with a trailing slash');
      this.pending=new Map();this.nextId=0;this.closed=false;this.ready=false;this.preparing=null;this.worker=null;this.embeddingJobs=0;
    }
    prepare(){
      if(this.closed)return Promise.reject(Error('Speaker client is disposed'));
      if(this.ready)return Promise.resolve();
      if(this.preparing)return this.preparing;
      try{
        this.worker=new Worker(new URL('speaker-worker.js',this.base));
        this.worker.onmessage=({data})=>{
          const wait=this.pending.get(data?.id);if(!wait)return;
          if(data.type==='error'){this.pending.delete(data.id);clearTimeout(wait.timer);wait.reject(Error(data.message||'Speaker model failed'));return;}
          if(data.type!==wait.type)return;
          this.pending.delete(data.id);clearTimeout(wait.timer);
          if(data.type==='embedding'){
            const values=new Float32Array(data.embedding||0);let norm=0;
            for(const v of values)norm+=v*v;
            if(values.length!==256||!Number.isFinite(norm)||Math.abs(norm-1)>.01){wait.reject(Error('Invalid speaker embedding'));return;}
            wait.resolve(values);
          }else if(data.type==='segmentation'){
            try{wait.resolve(validateSegmentation(data.result,wait.durationMs));}catch(error){wait.reject(error);}
          }else wait.resolve();
        };
        this.worker.onerror=event=>{event.preventDefault?.();this.abort(Error(event.message||'Speaker worker failed'));};
        this.worker.onmessageerror=()=>this.abort(Error('Speaker worker returned unreadable data'));
        this.preparing=this.request('prepare',{assetBaseURL:this.base.href},'ready',120000).then(()=>{this.ready=true;},error=>{this.abort(error);throw error;});
        return this.preparing;
      }catch(error){this.abort(error);return Promise.reject(error);}
    }
    embed(samples,rate){return this.infer('embed',samples,rate);}
    segment(samples,rate){return this.infer('segment',samples,rate);}
    async infer(action,samples,rate){
      if(this.closed)throw Error('Speaker client is disposed');
      if(!(samples instanceof Float32Array)||!Number.isInteger(rate)||rate<8000||rate>96000||samples.length<rate||samples.length>rate*15)throw Error('Speaker input must contain 1..15 seconds of Float32 PCM at 8000..96000 Hz');
      for(const v of samples)if(!Number.isFinite(v)||Math.abs(v)>1)throw Error('Speaker PCM must be finite and normalized');
      if(this.embeddingJobs>=2)throw Error('Speaker embedding queue is full');
      this.embeddingJobs++;
      try{
        // Copy now: caller may reuse the capture buffer while the model prepares.
        const copy=samples.slice();
        await this.prepare();
        if(this.closed)throw Error('Speaker client is disposed');
        return await this.request(action,{samples:copy.buffer,rate},action==='embed'?'embedding':'segmentation',45000,[copy.buffer]);
      }finally{this.embeddingJobs--;}
    }
    request(action,payload,type,timeout,transfer=[]){
      return new Promise((resolve,reject)=>{
        const id=++this.nextId;
        const timer=setTimeout(()=>this.abort(Error('Speaker '+action+' timed out')),timeout);
        this.pending.set(id,{resolve,reject,timer,type,durationMs:payload.samples?payload.samples.byteLength/4/payload.rate*1000:null});
        try{this.worker.postMessage({action,id,...payload},transfer);}catch(error){this.abort(error);}
      });
    }
    abort(error){
      this.closed=true;this.ready=false;this.worker?.terminate();this.worker=null;
      for(const wait of this.pending.values()){clearTimeout(wait.timer);wait.reject(error);}this.pending.clear();
    }
    dispose(){this.abort(Error('Speaker client is disposed'));return Promise.resolve();}
  }
  root.LocalSpeechSpeakers=Object.freeze({version:'0.2.0',modelId:'wespeaker-resnet34-lm-q8@6a61a1833ff2583aabeba044f5c8221f00b67ceb',create:options=>new SpeakerClient(options)});
})(globalThis);
