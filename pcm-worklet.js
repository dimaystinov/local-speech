class PCMRecorder extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(Math.round(sampleRate/10));this.offset=0;
    this.port.onmessage=({data})=>{if(data==='flush'){this.flush();this.port.postMessage({flushed:true});}};
  }
  flush(){if(this.offset){const samples=this.buffer.slice(0,this.offset);this.port.postMessage({samples},[samples.buffer]);this.offset=0;}}
  process(inputs,outputs){
    const channels=inputs[0];
    if(channels?.length)for(let i=0;i<channels[0].length;i++){
      let x=0;for(const channel of channels)x+=channel[i]/channels.length;
      this.buffer[this.offset++]=x;if(this.offset===this.buffer.length)this.flush();
    }
    for(const output of outputs)for(const channel of output)channel.fill(0);
    return true;
  }
}
registerProcessor('pcm-recorder',PCMRecorder);
