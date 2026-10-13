importScripts('model-catalog.js','vendor/sherpa-onnx-wasm-web.js','vendor/sherpa-onnx-asr.js','vendor/sherpa-onnx-vad.js','signal.js','context.js');
let contextInfo={status:'not-requested',count:0};
const PREVIEW_BUDGET_MS=1000;
let lastDecode=null,previewDisabled=false,previewCount=0;
let vad,resampler,vadRate,pauseSeconds=.7,maxSegmentSeconds=12,moduleInstance,recognizer,spec,session,stream,pre=[],chunks=[],voiced=false,quiet=0,elapsed=0,startTime=0,segment=0,lastPartial='',lastPartialAt=0,threshold=.006,voicedMs=0,clipped=0,totalSamples=0;
const send=data=>self.postMessage(data);
function release(){stream?.free();stream=null;chunks=[];voiced=false;quiet=0;lastPartial='';voicedMs=0;clipped=0;totalSamples=0;previewCount=0;}
function decodeOffline(target,audio,rate,stage,request){
  const audioMs=audio.length/rate*1000,info={type:'processing',stage,action:request.action,packetId:request.action==='audio'?request.id:null,sessionId:session,segmentId:segment,audioMs};
  send({...info,state:'start'});const started=performance.now();let complete=false;
  try{target.acceptWaveform(rate,audio);recognizer.decode(target);complete=true;}
  finally{
    const processingMs=performance.now()-started;
    if(complete)lastDecode={processingMs,audioMs};
    send({...info,state:'end',status:complete?'complete':'failed',processingMs});
    if(stage==='preview'&&processingMs>PREVIEW_BUDGET_MS){previewDisabled=true;send({type:'preview-policy',sessionId:session,enabled:false,reason:'decode-budget-exceeded',processingMs,budgetMs:PREVIEW_BUDGET_MS});}
  }
}
function previewWithinBudget(audioMs){
  // Unknown speed is not permission. Do not assume a shorter prefix is cheaper
  // than the last measured decode; longer prefixes scale that measured cost up.
  return !previewDisabled&&previewCount===0&&lastDecode?.audioMs>0&&Math.max(lastDecode.processingMs,lastDecode.processingMs*audioMs/lastDecode.audioMs)<=PREVIEW_BUDGET_MS;
}
function feed(samples,rate){
  if(spec.online){stream.acceptWaveform(rate,samples);while(recognizer.isReady(stream))recognizer.decode(stream);}
  else chunks.push(samples);
}
function finalize(reason,rate,request){
  if(!voiced)return;
  const started=performance.now();let text='';
  try {
    if(spec.online){stream.acceptWaveform(rate,new Float32Array(Math.round(rate*.6)));stream.inputFinished();while(recognizer.isReady(stream))recognizer.decode(stream);}
    else {const audio=new Float32Array(chunks.reduce((n,c)=>n+c.length,0));let p=0;for(const c of chunks){audio.set(c,p);p+=c.length;}decodeOffline(stream,audio,rate,'final',request);}
    text=recognizer.getResult(stream).text||'';
    send({type:'final',sessionId:session,segmentId:segment,text:text.trim(),startMs:Math.round(startTime*1000),endMs:Math.round(elapsed*1000),reason,turnComplete:false,context:contextInfo,vadMode:vad?'silero':'energy',voicedMs,clippedRatio:totalSamples?clipped/totalSamples:0,processing_ms:performance.now()-started,wasm_memory_bytes:moduleInstance.HEAPU8.buffer.byteLength});
  }finally{release();pre=[];}
}
self.onmessage=async({data:d})=>{
  try{
    if(d.action==='load'){
      const started=performance.now();spec=SPEECH_MODELS[d.model];if(!spec)throw Error('Неизвестная модель');
      moduleInstance=await SherpaOnnx({locateFile:n=>'vendor/'+n,print:()=>{},printErr:x=>send({type:'log',message:x})});
      for(const f of d.files)moduleInstance.FS.writeFile('/'+f.name,new Uint8Array(f.buffer));
      const modelConfig={tokens:'/tokens.txt',numThreads:1,provider:'cpu'};
      if(spec.whisper){modelConfig.tokens='/'+spec.whisper+'-tokens.txt';modelConfig.whisper={encoder:'/'+spec.whisper+'-encoder.int8.onnx',decoder:'/'+spec.whisper+'-decoder.int8.onnx',language:d.language==='auto'?'':d.language||'ru',task:'transcribe'};}
      else if(spec.field)modelConfig[spec.field]={model:'/'+spec.model};
      else {modelConfig.transducer={encoder:'/'+spec.encoder,decoder:'/decoder.onnx',joiner:'/'+spec.joiner};modelConfig.modelType=spec.type;}
      const config={featConfig:{sampleRate:spec.rate,featureDim:spec.featureDim||80},modelConfig,decodingMethod:'greedy_search',enableEndpoint:false};
      const supportsContext=['small','zipformer'].includes(d.model),terms=d.contextTerms||[];
      contextInfo={status:terms.length?'unsupported':'not-requested',count:0};
      if(d.beamSearch&&supportsContext)config.decodingMethod='modified_beam_search';
      if(terms.length&&supportsContext){
        const prepared=prepareLocalContext(terms,moduleInstance.FS.readFile('/tokens.txt',{encoding:'utf8'}));
        contextInfo={status:'unavailable',count:0,rejected:prepared.rejected};
        if(prepared.accepted.length&&d.files.some(f=>f.name==='ru-bpe.vocab')){
          modelConfig.modelingUnit='bpe';modelConfig.bpeVocab='/ru-bpe.vocab';
          moduleInstance.FS.writeFile('/hotwords.txt',prepared.accepted.join('\n')+'\n');
          config.decodingMethod='modified_beam_search';config.hotwordsFile='/hotwords.txt';config.hotwordsScore=Math.max(.5,Math.min(3,Number(d.contextScore)||1.5));
          contextInfo={status:'applied',count:prepared.accepted.length,score:config.hotwordsScore,rejected:prepared.rejected};
        }
      }
      recognizer=spec.online?new OnlineRecognizer(config,moduleInstance):new OfflineRecognizer(config,moduleInstance);
      if(!recognizer.handle)throw Error('Движок не смог открыть модель');
      if(d.files.some(f=>f.name==='silero_vad.onnx')){vad=new Vad({sileroVad:{model:'/silero_vad.onnx',threshold:.5,minSilenceDuration:.1,minSpeechDuration:.1,windowSize:512,maxSpeechDuration:60},sampleRate:16000,numThreads:1,provider:'cpu',bufferSizeInSeconds:30},moduleInstance);if(!vad.handle)throw Error('Не удалось запустить Silero VAD');}
      for(const f of d.files)moduleInstance.FS.unlink('/'+f.name);
      if(contextInfo.status==='applied')moduleInstance.FS.unlink('/hotwords.txt');
      send({type:'ready',context:contextInfo,decodingMethod:config.decodingMethod,vadMode:vad?'silero':'energy',init_ms:performance.now()-started,wasm_memory_bytes:moduleInstance.HEAPU8.buffer.byteLength});
    }else if(d.action==='transcribe'){
      if(!recognizer||spec.online)throw Error('Уточнение требует загруженной непотоковой модели');
      const samples=new Float32Array(d.samples),rate=d.sampleRate;
      if(!Number.isFinite(rate)||rate<8000||rate>96000||!samples.length||samples.length/rate>20)throw Error('Недопустимый фрагмент для уточнения');
      const started=performance.now(),offlineStream=recognizer.createStream();
      try{
        offlineStream.acceptWaveform(rate,samples);recognizer.decode(offlineStream);
        send({type:'transcribed',id:d.id,text:(recognizer.getResult(offlineStream).text||'').trim(),processingMs:performance.now()-started});
      }finally{offlineStream.free();}
    }else if(d.action==='begin'){
      if(!recognizer)throw Error('Модель не загружена');
      const requestedWindow=d.maxSegmentSeconds===undefined?12:d.maxSegmentSeconds;
      if(!Number.isFinite(requestedWindow)||requestedWindow<3||requestedWindow>20)throw Error('maxSegmentSeconds must be 3..20');
      // Streaming models keep their existing segmentation; this controls offline latency.
      maxSegmentSeconds=spec.online?12:requestedWindow;
      release();pre=[];vad?.reset();resampler=null;vadRate=null;pauseSeconds=Math.max(.3,Math.min(2,Number(d.pauseSeconds)||.7));session=d.sessionId;segment=d.segmentBase||0;elapsed=(d.offsetMs||0)/1000;lastPartialAt=elapsed;threshold=d.threshold||.006;
      send({type:'begun',sessionId:session});
    }else if(d.action==='audio'){
      if(d.sessionId!==session)return;
      const packetStarted=performance.now();
      const samples=new Float32Array(d.samples),rate=d.sampleRate,dt=samples.length/rate;
      let sum=0;for(const x of samples)sum+=x*x;const rms=Math.sqrt(sum/samples.length);
      elapsed+=dt;
      let speech=rms>=threshold;
      if(vad){if(vadRate!==rate){vadRate=rate;resampler=new VadResampler(rate);}const input=resampler.push(samples);const gain=rms>.00005?Math.min(20,Math.max(1,.03/rms)):1;for(let i=0;i<input.length;i++)input[i]*=gain;vad.acceptWaveform(input);speech=vad.isDetected();while(!vad.isEmpty())vad.pop();}
      if(!voiced){
        if(speech){voiced=true;stream=recognizer.createStream();segment++;startTime=elapsed-dt-pre.reduce((n,x)=>n+x.length/rate,0);for(const x of pre)feed(x,rate);pre=[];}
        else {pre.push(samples);while(pre.reduce((n,x)=>n+x.length/rate,0)>.5)pre.shift();}
      }
      if(voiced){
        for(const x of samples){if(Math.abs(x)>=.99)clipped++;}totalSamples+=samples.length;if(speech)voicedMs+=dt*1000;
        feed(samples,rate);quiet=!speech?quiet+dt:0;
        if(spec.online&&elapsed-lastPartialAt>=.3){const text=(recognizer.getResult(stream).text||'').trim();if(text!==lastPartial){lastPartial=text;send({type:'partial',sessionId:session,segmentId:segment,text});}lastPartialAt=elapsed;}
        if(quiet>=pauseSeconds)finalize('pause',rate,d);
        else if(elapsed-startTime>=maxSegmentSeconds)finalize('window-limit',rate,d);
        else if(spec.preview&&(d.queueDepth||0)<=5&&elapsed-startTime>=4&&voicedMs>=1000&&previewWithinBudget(chunks.reduce((n,c)=>n+c.length,0)/rate*1000)){
          previewCount++;const preview=recognizer.createStream();try{const a=new Float32Array(chunks.reduce((n,c)=>n+c.length,0));let at=0;for(const c of chunks){a.set(c,at);at+=c.length;}decodeOffline(preview,a,rate,'preview',d);const text=(recognizer.getResult(preview).text||'').trim();if(text!==lastPartial){lastPartial=text;send({type:'partial',sessionId:session,segmentId:segment,text});}}finally{preview.free();}lastPartialAt=elapsed;
        }
      }
      send({type:'ack',sessionId:session,id:d.id,level:rms,speech,processingMs:performance.now()-packetStarted,audioMs:dt*1000,vadMode:vad?"silero":"energy"});
    }else if(d.action==='end'){
      if(d.sessionId!==session)return;
      finalize('stop',d.sampleRate,d);send({type:'ended',sessionId:session});session=null;
    }
  }catch(e){release();send({type:'error',sessionId:session,message:e.message||String(e)});}
};
