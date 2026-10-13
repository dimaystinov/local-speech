/* Dedicated offline embedding worker. Never shares ASR worker state or uploads audio. */
'use strict';
let extractor,model,preparing,library,assetBase,segmentModel,segmentPreparing,tail=Promise.resolve();
function normalizeEmbedding(values){
  if(!values||values.length!==256)throw Error('Expected a 256-dimensional speaker embedding');
  let norm=0;for(const value of values){if(!Number.isFinite(value))throw Error('Non-finite speaker embedding');norm+=value*value;}
  if(norm<1e-12)throw Error('Empty speaker embedding');
  norm=Math.sqrt(norm);return Float32Array.from(values,value=>value/norm);
}
function resampleSpeakerPCM(samples,rate,allowSilence=false){
  if(!(samples instanceof Float32Array)||!Number.isInteger(rate)||rate<8000||rate>96000||samples.length<rate||samples.length>rate*15)throw Error('Speaker input must contain 1..15 seconds of PCM');
  let energy=0;for(const value of samples){if(!Number.isFinite(value)||Math.abs(value)>1)throw Error('Invalid speaker PCM');energy+=value*value;}
  if(!allowSilence&&Math.sqrt(energy/samples.length)<.0001)throw Error('Not enough audible speech for a voice embedding');
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
    library=await import(new URL('vendor/speaker/transformers.min.js',base).href);
    const {env,AutoFeatureExtractor,AutoModel}=library;assetBase=base;
    env.allowRemoteModels=false;env.allowLocalModels=true;env.localModelPath=new URL('models/',base).href;
    env.backends.onnx.wasm.numThreads=1;env.backends.onnx.wasm.proxy=false;
    env.backends.onnx.wasm.wasmPaths=new URL('vendor/speaker/',base).href;
    extractor=await AutoFeatureExtractor.from_pretrained('speaker-wespeaker',{local_files_only:true});
    model=await AutoModel.from_pretrained('speaker-wespeaker',{local_files_only:true,device:'wasm',dtype:'q8'});
  })();
  return preparing;
}
// Powerset slots are local to one inference window, never persistent identities.
const SPEAKER_SETS=[[],[0],[1],[2],[0,1],[0,2],[1,2]];
function decodeSegmentation(logits,durationMs){
  const values=logits?.data, dims=logits?.dims;
  if(!dims||dims.length!==3||dims[0]!==1||dims[2]!==7||!Number.isInteger(dims[1])||dims[1]<1||dims[1]>1000||values?.length!==dims[1]*7||!Number.isFinite(durationMs)||durationMs<1000||durationMs>15000)throw Error('Invalid segmentation output');
  const intervals=[];const stepMs=durationMs/dims[1];let current;
  for(let i=0;i<dims[1];i++){
    let best=0,max=-Infinity;
    for(let j=0;j<7;j++){const value=values[i*7+j];if(!Number.isFinite(value))throw Error('Non-finite segmentation output');if(value>max){max=value;best=j;}}
    let total=0;for(let j=0;j<7;j++)total+=Math.exp(values[i*7+j]-max);
    const confidence=1/total;
    if(!current||current.classId!==best){current={classId:best,startMs:i*stepMs,endMs:(i+1)*stepMs,speakers:SPEAKER_SETS[best].slice(),confidence,frames:1};intervals.push(current);}
    else {current.endMs=(i+1)*stepMs;current.confidence+=confidence;current.frames++;}
  }
  return intervals.map(({classId,frames,...interval})=>({...interval,endMs:Math.min(durationMs,interval.endMs),confidence:interval.confidence/frames}));
}
function disposeTensors(...objects){
  const seen=new Set();for(const object of objects)for(const value of Object.values(object||{}))if(value?.dispose&&!seen.has(value)){seen.add(value);value.dispose();}
}
async function prepareSegmentation(){
  if(!library||!assetBase)throw Error('Prepare the speaker model first');
  if(!segmentPreparing)segmentPreparing=library.AutoModelForAudioFrameClassification.from_pretrained('segmentation-pyannote',{local_files_only:true,device:'wasm',dtype:'q8'}).then(value=>{segmentModel=value;});
  return segmentPreparing;
}
async function handle(data){
  if(data.action==='prepare'){await prepare(data.assetBaseURL);self.postMessage({type:'ready',id:data.id});return;}
  if(!['embed','segment'].includes(data.action))throw Error('Unknown speaker operation');
  if(!model||!extractor)throw Error('Prepare the speaker model first');
  const started=performance.now(),audio=resampleSpeakerPCM(new Float32Array(data.samples),data.rate,data.action==='segment');
  let inputs,output;
  try{
    if(data.action==='segment'){
      await prepareSegmentation();
      inputs={input_values:new library.Tensor('float32',audio,[1,1,audio.length])};
      output=await segmentModel(inputs);
      const durationMs=audio.length/16,intervals=decodeSegmentation(output.logits,durationMs);
      self.postMessage({type:'segmentation',id:data.id,result:{durationMs,processingMs:performance.now()-started,intervals}});
    }else{
      inputs=await extractor(audio);output=await model(inputs);
      const tensors=Object.values(output).filter(value=>value?.data?.length===256);
      if(tensors.length!==1)throw Error('Unexpected speaker model output');
      const embedding=normalizeEmbedding(tensors[0].data);
      self.postMessage({type:'embedding',id:data.id,embedding:embedding.buffer},[embedding.buffer]);
    }
  }finally{disposeTensors(inputs,output);}
}
if(typeof self!=='undefined')self.onmessage=({data})=>{
  tail=tail.then(()=>handle(data)).catch(error=>self.postMessage({type:'error',id:data?.id,message:error.message||String(error)}));
};
if(typeof module!=='undefined')module.exports={normalizeEmbedding,resampleSpeakerPCM,decodeSegmentation};
