class LocalEngine {
  constructor(model,onEvent=()=>{},onError=()=>{},{assetBaseURL}={}){
    if(typeof SPEECH_MODELS==='undefined'||!Object.prototype.hasOwnProperty.call(SPEECH_MODELS,model))throw Error('Неизвестная модель: '+model);
    this.assetBaseURL=assetBaseURL===undefined?null:new URL(assetBaseURL).href;
    this.model=model;this.onEvent=onEvent;this.onError=onError;this.pending=new Map();this.closed=false;this.sequence=0;
    this.metrics={maxQueueMs:0,packets:0};this.abort=new AbortController();this.transcription=null;this.resolveLoad=null;this.rejectLoad=null;this.resolveEnd=null;this.rejectEnd=null;this.sessionId=null;
  }
  assetURL(path){return this.assetBaseURL?new URL(path,this.assetBaseURL).href:path;}
  async load(progress=()=>{},{cacheOnly=false,language="ru",vadMode="silero",contextTerms=[],contextScore=1.5,beamSearch=false}={}){
    if(this.closed)throw this.failure||Error('Движок закрыт');
    if(this.loading||this.worker)throw Error('Модель уже загружается или загружена');
    this.loading=true;
    let cacheHits=0,downloadedBytes=0;const cacheWarnings=[];
    const timeout=setTimeout(()=>this.abort.abort(),60000);
    try{
      let cache;
      try{cache=await caches.open('local-speech-verified-v1');}catch{cacheWarnings.push('Хранилище моделей недоступно');}
      const manifestURL=this.assetURL('evidence/model-manifest.json');let response;
      if(cacheOnly){
        try{response=await cache?.match(manifestURL);}catch{}
        if(!response)try{response=await caches.match(manifestURL);}catch{}
      }else response=await fetch(manifestURL,{signal:this.abort.signal});
      if(!response?.ok)throw Error('Не удалось прочитать контрольные суммы моделей.');
      const manifest=await response.json(),seen=new Set();
      if(!Array.isArray(manifest)||!manifest.every(entry=>{
        if(!entry||typeof entry.model!=='string'||!/^[a-zA-Z0-9_-]+$/.test(entry.model)||typeof entry.file!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.file)||!Number.isSafeInteger(entry.bytes)||entry.bytes<=0||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))return false;
        const key=entry.model+'/'+entry.file;if(seen.has(key))return false;seen.add(key);return true;
      }))throw Error('Некорректный манифест моделей');
      if(!cacheOnly&&cache){
        try{await cache.put(manifestURL,new Response(JSON.stringify(manifest),{headers:{'Content-Type':'application/json'}}));}
        catch{cacheWarnings.push('Не удалось сохранить манифест моделей; повторная загрузка может потребовать сеть');}
      }
      const files=[];
      const assets=SPEECH_MODELS[this.model].files.map(name=>({model:this.model,name}));
      if(vadMode==='silero')assets.push({model:'vad',name:'silero_vad.onnx'});
      if(contextTerms.length&&['small','zipformer'].includes(this.model))assets.push({model:'context',name:'ru-bpe.vocab'});
      for(const {model,name} of assets){
        try{
        if(this.closed)throw Error('Загрузка отменена');
        const entry=manifest.find(x=>x.model===model&&x.file===name);
        if(!entry)throw Error('Нет контрольной суммы '+name);
        const url=this.assetURL(`models/${model}/${name}`),key=url+'?sha256='+entry.sha256;
        let buffer;try{const saved=await cache?.match(key);if(saved)buffer=await saved.arrayBuffer();}catch{}
        const verify=async bytes=>{
          if(bytes.byteLength!==entry.bytes)return false;
          const digest=await crypto.subtle.digest('SHA-256',bytes);
          return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')===entry.sha256;
        };
        if(buffer&&!await verify(buffer)){await cache?.delete(key);buffer=null;}
        if(buffer)cacheHits++;
        if(!buffer){
          if(cacheOnly)throw Error("Модель не сохранена или повреждена: "+name);
          progress('Загрузка '+name,files.length/assets.length);
          const r=await fetch(url,{signal:this.abort.signal});if(!r.ok)throw Error(name+': HTTP '+r.status);
          buffer=await r.arrayBuffer();downloadedBytes+=buffer.byteLength;if(!await verify(buffer))throw Error('Контрольная сумма не совпала: '+name);
          try{await cache?.put(key,new Response(buffer));}catch{cacheWarnings.push('Не удалось сохранить '+name+'; повторная загрузка может потребовать сеть');}
        }
        files.push({name,buffer});
        }catch(e){if(!['vad','context'].includes(model)||this.closed||this.abort.signal.aborted)throw e;cacheWarnings.push((model==='vad'?'Silero недоступен; используется порог громкости: ':'Словарь подсказок недоступен; распознавание без подсказок: ')+e.message);}
      }
      if(this.closed)throw Error('Загрузка отменена');
      progress('Инициализация '+SPEECH_MODELS[this.model].label,1);
      this.worker=new Worker(this.assetURL('worker.js'));
      this.worker.onerror=e=>this.error(Error(e.message));
      this.worker.onmessage=({data:d})=>{
        if(this.closed)return;
        if(d.type==='error'){this.error(Error(d.message));return;}
        if(d.type==='ready'){clearTimeout(this.initTimer);const resolve=this.resolveLoad;this.resolveLoad=this.rejectLoad=null;resolve?.(d);return;}
        if(d.type==='transcribed'&&this.transcription?.id===d.id){clearTimeout(this.transcription.timer);const job=this.transcription;this.transcription=null;job.resolve(d);return;}
        if(d.type==='transcribed')return;
        if(['begun','partial','final','ack','processing','preview-policy','ended'].includes(d.type)&&(this.sessionId===null||d.sessionId!==this.sessionId))return;
        if(d.sessionId!==undefined&&d.sessionId!==this.sessionId)return;
        if(d.type==='processing'&&d.sessionId===this.sessionId){
          const valid=d.action==='audio'?this.pending.has(d.packetId):d.action==='end'&&Boolean(this.resolveEnd);
          if(valid){
            this.metrics.lastProcessing={...d};
            if(d.state==='start')this.processing={...d,observedAt:Date.now()};
            else if(d.state==='end'&&this.processing?.packetId===d.packetId&&this.processing?.stage===d.stage)this.processing=null;
          }
        }
        if(d.type==='preview-policy')this.metrics.previewPolicy={...d};
        if(d.type==='ack'){const item=this.pending.get(d.id);if(item){this.pending.delete(d.id);this.metrics.maxQueueMs=Math.max(this.metrics.maxQueueMs,Date.now()-item.time);this.metrics.packets++;d.queueMs=Date.now()-item.time;d.queueDepth=this.pending.size;this.metrics.recentQueueMs=d.queueMs;this.metrics.audioMs=(this.metrics.audioMs||0)+(d.audioMs||0);this.metrics.processingMs=(this.metrics.processingMs||0)+(d.processingMs||0);item.resolve();}}
        if(d.type==='ended'){if(!this.resolveEnd)return;clearTimeout(this.endTimer);const resolve=this.resolveEnd;this.resolveEnd=this.rejectEnd=null;this.endedSessionId=this.sessionId;this.sessionId=null;this.processing=null;resolve();}
        this.onEvent(d);
      };
      const ready=new Promise((resolve,reject)=>{this.resolveLoad=resolve;this.rejectLoad=reject;this.initTimer=setTimeout(()=>this.close(Error('Инициализация модели дольше 30 секунд')),30000);});
      try{this.worker.postMessage({action:'load',model:this.model,language,contextTerms,contextScore,beamSearch,files},files.map(f=>f.buffer));}catch(e){this.close(e);}
      const result=await ready;
      if(this.closed)throw this.failure||Error('Движок закрыт');
      this.watchdog=setInterval(()=>{
        const first=this.pending.values().next().value;
        if(first&&Date.now()-first.time>8000)this.error(this.timeoutError('Движок не подтверждает обработку аудио 8 секунд'));
      },1000);
      return {...result,cacheHits,downloadedBytes,cacheWarnings};
    }catch(e){this.close(e);throw e;}finally{clearTimeout(timeout);this.loading=false;}
  }
  begin(options){
    if(this.closed||!this.worker||this.loading)throw this.failure||Error('Движок закрыт или не загружен');
    if(!options||typeof options.sessionId!=='string'||!options.sessionId)throw Error('Неверный идентификатор сеанса');
    if(this.sessionId!==null||this.resolveEnd||this.pending.size||this.transcription)throw Error('Предыдущий сеанс ещё не завершён');
    this.sessionId=options.sessionId;this.endedSessionId=null;this.endPromise=null;this.processing=null;this.metrics={maxQueueMs:0,packets:0};
    try{this.worker.postMessage({...options,action:'begin'});}catch(e){this.close(e);throw e;}
  }
  validateAudio(samples,sampleRate){
    if(Object.prototype.toString.call(samples)!=='[object Float32Array]'||!samples.length||!samples.every(Number.isFinite))throw Error('Некорректный PCM');
    if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>96000)throw Error('Некорректная частота аудио');
    // A view may cover only part of a microphone buffer. Never send the surrounding samples.
    return samples.byteOffset||samples.byteLength!==samples.buffer.byteLength?samples.slice():samples;
  }
  timeoutError(message){
    const first=this.pending.entries().next().value,processing=this.processing?{...this.processing,elapsedMs:Date.now()-this.processing.observedAt}:null;
    const error=Error(message+(processing?' · этап '+processing.stage+(processing.packetId!==null?', пакет '+processing.packetId:''):''));
    error.code='timeout';error.processing=processing;error.pendingAudio={queueDepth:this.pending.size,oldestPacketId:first?.[0]??null,oldestAgeMs:first?Date.now()-first[1].time:0};return error;
  }
  transcribe(samples,sampleRate,id,timeoutMs=15000){
    if(this.closed||!this.worker||this.loading)return Promise.reject(this.failure||Error('Движок уточнения закрыт'));
    if(this.transcription||this.sessionId!==null)return Promise.reject(Error('Движок уточнения занят'));
    try{samples=this.validateAudio(samples,sampleRate);if(samples.length/sampleRate>20||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw Error('Недопустимый фрагмент или время уточнения');}catch(e){return Promise.reject(e);}
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.close(Error('Уточнение превысило допустимое время')),timeoutMs);
      this.transcription={id,resolve,reject,timer};
      try{this.worker.postMessage({action:'transcribe',id,sampleRate,samples:samples.buffer},[samples.buffer]);}catch(e){this.close(e);}
    });
  }
  audio(samples,sampleRate,sessionId){
    if(this.closed||!this.worker||this.loading)return Promise.reject(this.failure||Error('Движок закрыт'));
    if(!this.sessionId||sessionId!==this.sessionId||this.resolveEnd)return Promise.reject(Error('Неверный или завершённый сеанс'));
    try{samples=this.validateAudio(samples,sampleRate);}catch(e){return Promise.reject(e);}
    if(this.pending.size>=50){const e=Error('Перегрузка: очередь аудио больше 5 секунд');e.code='overload';return Promise.reject(e);}
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject,time:Date.now()});
      try{this.worker.postMessage({action:'audio',sessionId,id,sampleRate,queueDepth:this.pending.size,samples:samples.buffer},[samples.buffer]);}catch(e){this.close(e);}
    });
  }
  end(sessionId,sampleRate){
    if(this.closed||!this.worker||this.loading)return Promise.reject(this.failure||Error('Движок закрыт'));
    if(typeof sessionId!=='string'||!sessionId)return Promise.reject(Error('Неверный сеанс'));
    if(sessionId===this.endedSessionId&&this.sessionId===null)return Promise.resolve();
    if(!this.sessionId||sessionId!==this.sessionId)return Promise.reject(Error('Неверный сеанс'));
    if(this.resolveEnd)return this.endPromise;
    if(!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>96000)return Promise.reject(Error('Некорректная частота аудио'));
    this.endPromise=new Promise((resolve,reject)=>{
      this.resolveEnd=resolve;this.rejectEnd=reject;this.endTimer=setTimeout(()=>this.error(this.timeoutError('Завершение модели дольше 15 секунд')),15000);
      try{this.worker.postMessage({action:'end',sessionId,sampleRate});}catch(e){this.close(e);}
    });
    return this.endPromise;
  }
  error(e){if(this.closed)return;this.close(e);this.onError(e);}
  close(reason){
    if(this.closed)return;this.closed=true;if(reason)this.failure=reason;const error=this.failure||Error('Движок закрыт');
    this.abort.abort();clearTimeout(this.initTimer);clearTimeout(this.endTimer);clearInterval(this.watchdog);this.worker?.terminate();
    const rejectLoad=this.rejectLoad,rejectEnd=this.rejectEnd;this.resolveLoad=this.rejectLoad=this.resolveEnd=this.rejectEnd=null;
    rejectLoad?.(error);rejectEnd?.(error);
    if(this.transcription){clearTimeout(this.transcription.timer);this.transcription.reject(error);this.transcription=null;}
    for(const x of this.pending.values())x.reject(error);this.pending.clear();this.sessionId=null;this.processing=null;
  }
}
