class MicrophoneCapture {
  constructor(onSamples,onEnded,options={}) {
    this.onSamples=onSamples;this.onEnded=onEnded;this.stopped=false;this.cleaned=false;
    this.stoppedTracks=new Set();
    this.workletURL=options.assetBaseURL===undefined?'pcm-worklet.js':new URL('pcm-worklet.js',new URL(options.assetBaseURL,globalThis.document?.baseURI||globalThis.location?.href)).href;
  }
  // Consumer callbacks may fail without taking ownership of capture cleanup.
  notify(callback,...args) {
    try{const result=callback?.(...args);if(result&&typeof result.catch==='function')result.catch(error=>{this.callbackError=error;});}
    catch(error){this.callbackError=error;}
  }
  start() {
    if(this.stopped)return Promise.reject(Error('Microphone capture is stopped. Create a new capture for another session.'));
    if(!this.startPromise)this.startPromise=this.open();
    return this.startPromise;
  }
  async open(){
    try {
      this.ctx=new AudioContext();
      await this.ctx.resume();
      if(this.stopped)return;
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      this.stream=stream;
      // A permission dialog cannot be cancelled. A late grant must still release its tracks.
      if(this.stopped){this.stopTracks();return;}
      await this.ctx.audioWorklet.addModule(this.workletURL);
      if(this.stopped){this.stopTracks();return;}
      this.node=new AudioWorkletNode(this.ctx,'pcm-recorder');
      this.node.port.onmessage=({data})=>{
        if(this.cleaned)return;
        if(data.flushed)this.flushDone?.();
        else if(data.samples)this.notify(this.onSamples,data.samples,this.ctx.sampleRate);
      };
      this.source=this.ctx.createMediaStreamSource(this.stream);
      this.source.connect(this.node);this.node.connect(this.ctx.destination);
      for(const track of this.stream.getTracks())track.onended=()=>{
        if(this.stopped)return;
        this.notify(this.onEnded);
        void this.stop();
      };
    }catch(error){await this.stop();throw error;}
  }
  stop(){
    if(this.stopPromise)return this.stopPromise;
    this.stopped=true;this.stopPromise=Promise.resolve().then(()=>this.cleanup());return this.stopPromise;
  }
  stopTracks(){
    for(const track of this.stream?.getTracks()||[]){
      track.onended=null;
      if(this.stoppedTracks.has(track))continue;
      this.stoppedTracks.add(track);
      try{track.stop();}catch(error){this.cleanupError=error;}
    }
  }
  async cleanup(){
    if(this.node&&this.ctx?.state==='running')await new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);this.flushDone=null;resolve();};
      const timer=setTimeout(finish,300);this.flushDone=finish;
      try{this.node.port.postMessage('flush');}catch(error){this.cleanupError=error;finish();}
    });
    this.cleaned=true;this.flushDone=null;
    if(this.node)this.node.port.onmessage=null;
    this.stopTracks();
    for(const resource of [this.source,this.node])try{resource?.disconnect();}catch(error){this.cleanupError=error;}
    if(this.ctx&&this.ctx.state!=='closed')try{await this.ctx.close();}catch(error){this.cleanupError=error;}
  }
}
if(typeof module!=='undefined')module.exports={MicrophoneCapture};
