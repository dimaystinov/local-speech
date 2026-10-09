// Stateful box-filter resampling for the VAD only. ASR receives original PCM.
class VadResampler {
  constructor(inputRate,outputRate=16000){if(inputRate<=0||outputRate<=0)throw Error('Invalid sample rate');this.ratio=inputRate/outputRate;this.sum=0;this.weight=0;}
  push(samples){const out=[];for(const sample of samples){let left=1;while(left>1e-9){const n=Math.min(left,this.ratio-this.weight);this.sum+=sample*n;this.weight+=n;left-=n;if(this.weight>=this.ratio-1e-9){out.push(this.sum/this.ratio);this.sum=0;this.weight=0;}}}return Float32Array.from(out);}
}
if(typeof module!=='undefined')module.exports={VadResampler};
