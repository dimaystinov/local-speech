/* Headless browser API. Bundled with pinned local adapters by tools/build-sdk.cjs. */
(function(root){
  'use strict';
  const {selectRecognitionPlan,selectRecognitionFallback}=root.SpeechRecognitionPolicy;
  const scriptBase=typeof document!=='undefined'&&document.currentScript?.src?new URL('.',document.currentScript.src).href:null;
  class SpeechClient {
    constructor(options={}){
      const base=options.assetBaseURL||scriptBase;
      if(!base)throw Error('assetBaseURL is required');
      this.assetBaseURL=new URL(base,root.location?.href).href;
      if(!this.assetBaseURL.endsWith('/'))throw Error('assetBaseURL must end with /');
      if(root.location&&new URL(this.assetBaseURL).origin!==root.location.origin)throw Error('Serve speech assets on the application origin');
      this.options={language:'ru',allowLargeModels:true,cacheOnly:false,terms:[],pauseSeconds:.7,maxSegmentSeconds:12,...options};
      if(!Number.isFinite(this.options.pauseSeconds)||this.options.pauseSeconds<.3||this.options.pauseSeconds>2)throw Error('pauseSeconds must be 0.3..2');
      if(!Number.isFinite(this.options.maxSegmentSeconds)||this.options.maxSegmentSeconds<3||this.options.maxSegmentSeconds>20)throw Error('maxSegmentSeconds must be 3..20');
      this.hints=options.deviceHints===undefined?readDeviceHints():{...options.deviceHints};this.plan=selectRecognitionPlan(this.hints,this.options);
      this.state='idle';this.listeners=new Map();this.epoch=0;this.startEpoch=0;this.backendEpoch=0;
      this.buffer=new AudioReplayBuffer(30);this.attempted=new Set();this.finalized=new Set();this.segmentBase=0;this.nativeOverlapMs=0;
    }
    on(type,listener){if(typeof listener!=='function')throw TypeError('Listener must be a function');if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);return ()=>this.listeners.get(type)?.delete(listener);}
    emit(type,data={}){const event={...data,type,schemaVersion:1};for(const fn of [...(this.listeners.get(type)||[]),...(this.listeners.get('*')||[])]){try{fn(event);}catch{/* Host observers cannot break capture or cleanup. */}}}
    setState(state,detail={}){this.state=state;queueMicrotask(()=>this.emit('state',{state,...detail}));}
    assertOpen(){if(this.state==='disposed'||this.disposing)throw Error('Speech client is disposed');}
    async prepare({input='microphone'}={}){
      this.assertOpen();if(!['microphone','pcm'].includes(input))throw Error('input must be microphone or pcm');
      if(this.state==='preparing'){if(input!==this.input)throw Error('Input mode cannot change during prepare');return this.preparing;}
      if(this.state==='ready'&&this.input===input)return this.diagnostics();
      if(!['idle','ready','error'].includes(this.state))throw Error('Stop the session before preparing');
      this.closeBackend();this.candidate=null;this.input=input;this.attempted=new Set();const epoch=++this.epoch;this.setState('preparing');
      const job=(async()=>{try{await this.nextBackend(epoch,'failure');if(epoch!==this.epoch)throw Error('Preparation cancelled');this.setState('ready');return this.diagnostics();}catch(error){if(epoch===this.epoch){this.closeBackend();this.setState('error');this.emit('error',{code:'prepare-failed',message:error.message});}throw error;}})();
      this.preparing=job;return job;
    }
    async nextBackend(epoch,reason,lastFailure){
      let candidate;
      while(epoch===this.epoch&&(candidate=selectRecognitionFallback(this.plan,{attempted:this.attempted,reason,current:this.candidate}))){
        this.attempted.add(candidate.key);if(this.input==='pcm'&&candidate.engine==='system')continue;
        this.closeBackend();const backendEpoch=++this.backendEpoch;this.candidate=candidate;
        const current=()=>epoch===this.epoch&&backendEpoch===this.backendEpoch&&this.state!=='disposed';
        try{
          if(candidate.engine==='system'){
            const adapter=new SystemRecognizer(root.SpeechRecognition||root.webkitSpeechRecognition,d=>{if(current())this.result(d);},(state,message)=>{if(!current())return;if(state==='error')this.recover(Error(String(message)),'failure');if(state==='context')this.emit('context',message);if(state==='stopped'||state==='stopped-incomplete')this.systemStopped?.(state);});
            this.system=adapter;const check=await adapter.check(this.plan.systemLocale);if(!current())throw Error('Preparation cancelled');if(check.status!=='available')throw Error(check.message||check.status);
            this.loadStats={backend:'system',localOnly:true};
          }else{
            const adapter=new LocalEngine(candidate.model,d=>{if(current())this.result(d);},error=>{if(current()&&['listening','starting'].includes(this.state))this.recover(error,error.code||'failure');},{assetBaseURL:this.assetBaseURL});this.engine=adapter;
            this.loadStats=await adapter.load((message,progress)=>{if(current())this.emit('progress',{message,progress});},{cacheOnly:this.plan.cacheOnly,language:this.plan.workerLanguage,contextTerms:this.plan.terms,pauseSeconds:this.options.pauseSeconds});
            if(!current()){adapter.close();throw Error('Preparation cancelled');}
          }
          this.emit('backend',{backend:candidate.key,localOnly:true,contextCapability:candidate.context,context:this.loadStats.context||{status:'not-reported',count:0},load:this.loadStats});return;
        }catch(error){if(epoch!==this.epoch)throw error;lastFailure=error;this.closeBackend();this.emit('warning',{code:'backend-unavailable',backend:candidate.key,message:error.message});}
      }
      if(lastFailure){
        const failure=Error(`Local backend ${this.candidate?.key||'unknown'} failed: ${lastFailure.message}. No eligible local fallback remains.`);
        failure.code=lastFailure.code||'backend-failed';failure.cause=lastFailure;
        failure.processing=lastFailure.processing;failure.pendingAudio=lastFailure.pendingAudio;
        throw failure;
      }
      throw Error('No usable local speech backend for this language and resource policy');
    }
    start({input='microphone'}={}){
      this.assertOpen();if(this.startTask)return this.startTask;if(['listening','recovering','stopping'].includes(this.state))return Promise.reject(Error('Session is already active'));
      const startEpoch=++this.startEpoch;
      const job=(async()=>{
        await this.prepare({input});if(startEpoch!==this.startEpoch)throw Error('Start cancelled');
        this.sessionId=crypto.randomUUID();this.buffer.clear();this.finalized.clear();this.segmentBase=0;this.nativeOverlapMs=0;this.rate=null;this.quietMs=0;this.speechSinceTextMs=0;this.recovery=null;this.setState('starting');
        const epoch=this.epoch;const current=()=>epoch===this.epoch&&startEpoch===this.startEpoch;
        try{
          if(this.engine)this.beginEngine(0);
          if(input==='microphone'){
            const capture=new MicrophoneCapture((samples,rate)=>{if(current()||(epoch===this.epoch&&this.flushing))return this.accept(samples,rate).catch(error=>{if(current())return this.fail(error);});},()=>{if(current()){this.emit('warning',{code:'microphone-ended',message:'Microphone disconnected'});this.stop();}},{assetBaseURL:this.assetBaseURL});
            this.capture=capture;await capture.start();if(!current()){await capture.stop();throw Error('Start cancelled');}
          }
          if(this.system)this.system.start(this.plan.systemLocale,this.sessionId,this.plan.terms);
          if(!current())throw Error('Start cancelled');this.setState('listening');return this.diagnostics();
        }catch(error){if(current())await this.fail(error);throw error;}
      })();this.startTask=job;job.finally(()=>{if(this.startTask===job)this.startTask=null;}).catch(()=>{});return job;
    }
    beginEngine(offsetMs){this.engine.begin({sessionId:this.sessionId,segmentBase:this.segmentBase,offsetMs,pauseSeconds:this.options.pauseSeconds,maxSegmentSeconds:this.options.maxSegmentSeconds,threshold:.006});}
    write(samples,sampleRate,hints){if(this.input!=='pcm')return Promise.reject(Error('write requires start({input:"pcm"})'));return this.accept(samples,sampleRate,hints);}
    async accept(samples,rate,hints={}){
      const acceptingEpoch=this.epoch;
      if(!hints||typeof hints!=='object'||Array.isArray(hints))throw Error('Audio hints must be an object');
      const pendingPackets=hints.pendingPackets===undefined?0:hints.pendingPackets;
      if(!Number.isSafeInteger(pendingPackets)||pendingPackets<0||pendingPackets>150)throw Error('pendingPackets must be an integer from 0 to 150');
      if(!['starting','listening','recovering'].includes(this.state)&&!(this.state==='stopping'&&this.flushing))throw Error('Session is not accepting audio');
      if(!(samples instanceof Float32Array)||!samples.length||!Number.isFinite(rate)||rate<8000||rate>96000||samples.length>rate)throw Error('Expected 1..1000 ms Float32 PCM at 8000..96000 Hz');
      for(const sample of samples)if(!Number.isFinite(sample)||Math.abs(sample)>1)throw Error('PCM must be finite and normalized to [-1,1]');
      if(this.rate&&this.rate!==rate)throw Error('Sample rate cannot change during a session');this.rate=rate;
      for(let pos=0;pos<samples.length;pos+=Math.round(rate/10)){
        if(acceptingEpoch!==this.epoch||(!['starting','listening','recovering'].includes(this.state)&&!(this.state==='stopping'&&this.flushing)))throw Error('Audio processing was interrupted');
        const packet=samples.slice(pos,pos+Math.round(rate/10)),duration=packet.length/rate*1000;let energy=0;for(const v of packet)energy+=v*v;
        const speech=Math.sqrt(energy/packet.length)>.006;const lost=this.buffer.lostMs;this.buffer.push(packet,rate,speech);
        if(this.buffer.lostMs>lost)this.emit('warning',{code:'audio-buffer-overflow',lostMs:this.buffer.lostMs,message:'Uncommitted audio exceeded the 30 second recovery buffer'});
        if(this.state==='recovering')continue;
        if(this.system){
          this.quietMs=speech?0:this.quietMs+duration;if(speech)this.speechSinceTextMs+=duration;
          if(this.quietMs>=this.options.pauseSeconds*1000)this.system.endPhrase();
          if(this.speechSinceTextMs>=8000){await this.recover(Error('Speech detected without system transcript'),'no-result');}
        }else if(this.engine){try{await this.engine.audio(packet.slice(),rate,this.sessionId,{pendingPackets});}catch(error){if(acceptingEpoch!==this.epoch)throw Error('Audio processing was interrupted');if(this.state==='stopping')throw error;await this.recover(error,error.code||'failure');}}
      }
    }
    result(data){
      if(data.type==='clear-partial'){this.emit('clear-partial',{sessionId:this.sessionId});return;}
      if(!this.sessionId||data.sessionId!==this.sessionId||!['partial','final','interrupted'].includes(data.type))return;
      const id=data.segmentId;this.segmentBase=Math.max(this.segmentBase,id||0);const key=this.sessionId+':'+id;
      if(this.finalized.has(key))return;this.speechSinceTextMs=0;
      const timingReliable=this.candidate?.engine==='local'&&Number.isFinite(data.endMs),backend=this.candidate?.key;
      const event={...data,backend,sessionId:this.sessionId,rawText:data.text||'',text:data.text||'',turnComplete:false,timingReliable};
      if(data.type==='final'){
        this.finalized.add(key);if(event.text){if(timingReliable)this.buffer.commit(data.endMs);else this.nativeOverlapMs=this.buffer.endMs;}
        event.replayPossibleOverlap=timingReliable&&this.nativeOverlapMs>0&&(!Number.isFinite(data.startMs)||data.startMs<this.nativeOverlapMs);
        event.quality=assessQuality({text:event.text,durationMs:(data.endMs||0)-(data.startMs||0),voicedMs:data.voicedMs||0,clippedRatio:data.clippedRatio||0});
        if(event.replayPossibleOverlap){event.quality.status='review';event.quality.flags.push('Recovered audio may overlap a system transcript');}
      }
      this.emit(data.type,event);
    }
    recover(error,reason='failure'){
      if(this.recovery)return this.recovery;if(!['listening','starting'].includes(this.state))return Promise.resolve();
      const epoch=this.epoch,previous=this.candidate?.key;this.setState('recovering');this.closeBackend();this.emit('clear-partial',{sessionId:this.sessionId});this.emit('warning',{code:'recovering',message:error.message,previous});
      const job=(async()=>{try{
        const started=Date.now();
        while(epoch===this.epoch&&this.state==='recovering'){
          await this.nextBackend(epoch,reason,error);if(epoch!==this.epoch||this.state!=='recovering')return;
          let cursor=this.buffer.snapshot()[0]?.startMs??this.buffer.endMs;this.beginEngine(cursor);
          try{
            while(epoch===this.epoch&&this.state==='recovering'){
              const batch=this.buffer.snapshot().filter(p=>p.startMs>=cursor-.01);if(!batch.length)break;
              for(let i=0;i<batch.length;i++){const p=batch[i];if(epoch!==this.epoch||this.state!=='recovering')return;if(Date.now()-started>90000)throw Error('Recovery timeout');await this.engine.audio(p.samples,p.rate,this.sessionId,{pendingPackets:Math.min(150,batch.length-i)});cursor=p.endMs;}
            }
            if(epoch===this.epoch&&this.state==='recovering'){this.speechSinceTextMs=0;this.setState('listening');this.emit('recovered',{previous,backend:this.candidate.key,lostMs:this.buffer.lostMs});}return;
          }catch(nextError){if(epoch!==this.epoch)return;this.closeBackend();error=nextError;reason=nextError.code||'failure';}
        }
      }catch(failure){if(epoch===this.epoch)await this.fail(failure);}})();
      this.recovery=job;job.finally(()=>{if(this.recovery===job)this.recovery=null;}).catch(()=>{});return job;
    }
    async fail(error){if(this.state==='disposed')return;++this.epoch;++this.startEpoch;this.closeBackend();this.setState('error');this.emit('error',{code:error.code||'recognition-failed',message:error.message,sessionId:this.sessionId,backend:this.candidate?.key,processing:error.processing,pendingAudio:error.pendingAudio,recoverableAudioMs:this.buffer.endMs-this.buffer.committedMs});const capture=this.capture;this.capture=null;await capture?.stop();}
    closeBackend(){++this.backendEpoch;this.engine?.close();this.engine=null;this.system?.dispose();this.system=null;}
    stop(){
      if(this.stopTask)return this.stopTask;if(this.state==='disposed'||this.state==='idle')return Promise.resolve(this.diagnostics());
      const was=this.state;++this.startEpoch;this.startTask=null;this.setState('stopping');
      const job=(async()=>{let failure;
        if(['preparing','recovering'].includes(was)){++this.epoch;this.closeBackend();}
        this.flushing=true;const capture=this.capture;this.capture=null;try{await capture?.stop();}catch(e){failure=e;}this.flushing=false;
        try{
          if(this.engine&&this.sessionId&&this.rate)await this.engine.end(this.sessionId,this.rate);
          if(this.system&&this.sessionId)await new Promise(resolve=>{const timer=setTimeout(()=>{this.system?.stopTimedOut();resolve();},2000);this.systemStopped=()=>{clearTimeout(timer);resolve();};this.system.stop();});
        }catch(e){failure=e;}
        ++this.epoch;this.closeBackend();this.systemStopped=null;
        if(failure)this.emit('error',{code:'stop-incomplete',message:failure.message,sessionId:this.sessionId});
        if(this.state!=='disposed')this.setState('idle');return this.diagnostics();
      })();this.stopTask=job;job.finally(()=>{if(this.stopTask===job)this.stopTask=null;}).catch(()=>{});return job;
    }
    dispose(){if(this.disposeTask)return this.disposeTask;if(this.state==='disposed')return Promise.resolve();this.disposing=true;this.disposeTask=Promise.resolve().then(async()=>{await this.stop();this.setState('disposed');this.listeners.clear();this.buffer.clear();});return this.disposeTask;}
    diagnostics(){return {version:'__LOCAL_SPEECH_VERSION__',state:this.state,sessionId:this.sessionId||null,backend:this.candidate?.key||null,plan:this.plan,load:this.loadStats||null,bufferedMs:this.buffer.endMs-this.buffer.committedMs,lostMs:this.buffer.lostMs};}
    exportPendingAudio(){return this.buffer.snapshot();}
  }
  root.LocalSpeech=Object.freeze({version:'__LOCAL_SPEECH_VERSION__',create:options=>new SpeechClient(options)});
})(globalThis);
