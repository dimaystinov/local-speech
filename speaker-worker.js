/* Dedicated offline embedding worker. Never shares ASR worker state or uploads audio. */
'use strict';
let extractor,model,preparing,tail=Promise.resolve();
function normalizeEmbedding(values){
  if(!values||values.length!==256)throw Error('Expected a 256-dimensional speaker embedding');
  let norm=0;for(const value of values){if(!Number.isFinite(value))throw Error('Non-finite speaker embedding');norm+=value*value;}
  if(norm<1e-12)throw Error('Empty speaker embedding');
  norm=Math.sqrt(norm);return Float32Array.from(values,value=>value/norm);
}
function resampleSpeakerPCM(samples,rate){
  if(!(samples instanceof Float32Array)||!Number.isInteger(rate)||rate<8000||rate>96000||samples.length<rate||samples.length>rate*15)throw Error('Speaker input must contain 1..15 seconds of PCM');
  let energy=0;for(const value of samples){if(!Number.isFinite(value)||Math.abs(value)>1)throw Error('Invalid speaker PCM');energy+=value*value;}
  if(Math.sqrt(energy/samples.length)<.0001)throw Error('Not enough audible speech for a voice embedding');
  if(rate===16000)return samples;
  // Integrate source samples into output bins; anti-aliases downsampling.
  const ratio=rate/16000,out=new Float32Array(Math.floor(samples.length/ratio));
  let sum=0,weight=0,index=0;
  for(const value of samples){let left=1;while(left>1e-9){const take=Math.min(left,ratio-weight);sum+=value*take;weight+=take;left-=take;if(weight>=ratio-1e-9){if(index<out.length)out[index++]=sum/ratio;sum=0;weight=0;}}}
  return out;
}
async function prepare(baseURL){
  if(preparing)return preparing;
  const base=new URL(baseURL);
  if(base.origin!==self.location.origin||!base.pathname.endsWith('/'))throw Error('Speaker assets must stay on the worker origin');
  preparing=(async()=>{
    const {env,AutoFeatureExtractor,AutoModel}=await import(new URL('vendor/speaker/transformers.min.js',base).href);
    env.allowRemoteModels=false;env.allowLocalModels=true;env.localModelPath=new URL('models/',base).href;
    env.backends.onnx.wasm.numThreads=1;env.backends.onnx.wasm.proxy=false;
    env.backends.onnx.wasm.wasmPaths=new URL('vendor/speaker/',base).href;
    extractor=await AutoFeatureExtractor.from_pretrained('speaker-wespeaker',{local_files_only:true});
    model=await AutoModel.from_pretrained('speaker-wespeaker',{local_files_only:true,device:'wasm',dtype:'q8'});
  })();
  return preparing;
}
async function handle(data){
  if(data.action==='prepare'){await prepare(data.assetBaseURL);self.postMessage({type:'ready',id:data.id});return;}
  if(data.action!=='embed')throw Error('Unknown speaker operation');
  if(!model||!extractor)throw Error('Prepare the speaker model first');
  const audio=resampleSpeakerPCM(new Float32Array(data.samples),data.rate);
  const inputs=await extractor(audio),output=await model(inputs);
  const tensors=Object.values(output).filter(value=>value?.data?.length===256);
  if(tensors.length!==1)throw Error('Unexpected speaker model output');
  const embedding=normalizeEmbedding(tensors[0].data);
  self.postMessage({type:'embedding',id:data.id,embedding:embedding.buffer},[embedding.buffer]);
}
if(typeof self!=='undefined')self.onmessage=({data})=>{
  tail=tail.then(()=>handle(data)).catch(error=>self.postMessage({type:'error',id:data?.id,message:error.message||String(error)}));
};
if(typeof module!=='undefined')module.exports={normalizeEmbedding,resampleSpeakerPCM};
