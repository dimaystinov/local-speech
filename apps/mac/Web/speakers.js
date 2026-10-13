/* Optional speaker analysis; never blocks the ASR write/ACK path. */
(function(root){
  'use strict';
  let engine, current, last, enrollment;
  const send=message=>root.webkit?.messageHandlers?.speech?.postMessage(message);
  function client(){
    if(!engine||engine.closed)engine=root.LocalSpeechSpeakers.create({assetBaseURL:new URL('/sdk/',root.location.href).href});
    return engine;
  }
  const key=(channel,event)=>`${channel}:${event.sessionId}:${event.segmentId}`;
  function start({enabled=false,profiles=[]}={}){
    const s={enabled,requested:enabled,closed:false,rings:new Map(),samples:new Map(),outstanding:new Map(),tail:Promise.resolve(),pending:0,pressure:new Map()};
    last=null;current=s;
    if(enabled){
      try{s.matcher=new root.LocalSpeechVoiceProfiles.Session(profiles);s.preparation=client().prepare().then(()=>{if(!s.closed)return client().segment(new Float32Array(16000),16000);});s.preparation.catch(error=>{if(current===s&&!s.closed){s.enabled=false;send({type:'speaker-status',message:'Голоса недоступны: '+error.message});}});}
      catch(error){s.enabled=false;send({type:'speaker-status',message:error.message});}
    }
    return s;
  }
  function feed(s,channel,samples,rate){
    if(!s?.enabled||s.closed)return;
    try{if(!s.rings.has(channel))s.rings.set(channel,new root.LocalSpeechVoiceProfiles.AudioRing());s.rings.get(channel).append(samples,rate);}
    catch(error){s.enabled=false;send({type:'speaker-status',message:'Анализ голосов отключён: '+error.message});}
  }
  function annotation(s,channel,event,data){
    if(s.closed)return;
    send({type:'speaker',channel,sessionId:event.sessionId,segmentId:event.segmentId,...data});
  }
  const now=()=>root.performance?.now()??Date.now();
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function pressure(s,channel,{busy=false,pending=0}={}){
    if(s&&!s.closed)s.pressure.set(channel,{busy,pending});
  }
  async function runAnalysis(s,samples,rate,deadline){
    if(s.closed||!s.enabled)throw Error('Анализ голосов остановлен');
    if(now()>=deadline)throw Error('Анализ голоса пропущен: очередь занята');
    const used=client();let timedOut=false,timer,inFlight=false;
    const beforeInference=async()=>{
      while(!s.closed&&!timedOut&&[...s.pressure.values()].some(x=>x.busy||x.pending>2)){
        if(now()>=deadline)throw Error('Распознавание занято: анализ голоса пропущен');
        await delay(40);
      }
      if(s.closed||timedOut||now()>=deadline)throw Error('Превышен бюджет анализа голоса');
    };
    try{
      const boundedEngine=Object.fromEntries(['segment','embed'].map(method=>[method,async(...args)=>{
        inFlight=true;try{return await used[method](...args);}finally{inFlight=false;}
      }]));
      const analysis=(async()=>{
        inFlight=true;try{await s.preparation;}finally{inFlight=false;}
        if(s.closed||timedOut||!s.enabled)throw Error('Анализ голосов остановлен');
        return root.LocalSpeechDiarization.analyze(samples,rate,{engine:boundedEngine,matcher:s.matcher,beforeInference,cancelled:()=>s.closed||timedOut});
      })();
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
        timedOut=true;
        // CPU pressure skips a label; a stuck model is terminated independently of ASR.
        if(inFlight){s.enabled=false;void used.dispose();if(engine===used)engine=null;}
        reject(Error((inFlight?'Анализ голосов отключён до следующего созвона. ':'')+'Превышен бюджет анализа голоса. Текст продолжает распознаваться.'));
      },Math.max(1,deadline-now()));});
      return await Promise.race([analysis,timeout]);
    }finally{clearTimeout(timer);}
  }
  function final(s,channel,event){
    if(!s?.requested||s.closed||!event.rawText)return;
    if(!s.enabled){annotation(s,channel,event,{label:'Голос не определён · анализ недоступен',kind:'uncertain',canEnroll:false});return;}
    const ring=s.rings.get(channel),samples=ring?.get(event.startMs,event.endMs),rate=ring?.rate;
    if(!samples||samples.length<rate||samples.length>rate*15){annotation(s,channel,event,{label:'Голос не определён',kind:'uncertain',canEnroll:false});return;}
    const id=key(channel,event);
    // At most eight recent excerpts, each <=15 seconds. No raw audio persistence.
    const excerpt=samples.slice(0,rate*15);s.samples.set(id,{samples:excerpt,rate});
    while(s.samples.size>8)s.samples.delete(s.samples.keys().next().value);
    annotation(s,channel,event,{label:'Определяется голос…',kind:'pending',canEnroll:false});
    if(s.pending>=4){annotation(s,channel,event,{label:'Голос не определён · очередь занята',kind:'uncertain',canEnroll:false});return;}
    const job={channel,event,deadline:now()+5000,done:false,timer:null};
    const complete=data=>{if(job.done)return;job.done=true;clearTimeout(job.timer);annotation(s,channel,event,data);};
    job.timer=setTimeout(()=>complete({label:'Голос не определён · таймаут',kind:'uncertain',canEnroll:false}),5000);
    s.pending++;s.outstanding.set(id,job);
    s.tail=s.tail.then(async()=>{
      if(s.closed||job.done)return;
      try{complete(await runAnalysis(s,samples,rate,job.deadline));}
      catch(error){complete({label:'Голос не определён',kind:'uncertain',canEnroll:false});if(!s.closed)send({type:'speaker-status',message:'Не удалось определить голос: '+error.message});}
    }).finally(()=>{clearTimeout(job.timer);s.pending--;s.outstanding.delete(id);});
  }
  function finish(s){
    if(!s||s.closed)return Promise.resolve();
    if(s.finishing)return s.finishing;
    s.finishing=(async()=>{
      let timer;
      const drained=Promise.all([s.tail,s.preparation?.catch(()=>{})]);
      const complete=await Promise.race([drained.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),6000);})]);
      clearTimeout(timer);
      if(!complete){for(const job of s.outstanding.values()){clearTimeout(job.timer);if(!job.done)annotation(s,job.channel,job.event,{label:'Голос не определён · таймаут',kind:'uncertain',canEnroll:false});job.done=true;}send({type:'speaker-status',message:'Часть голосов не определена: превышено время ожидания.'});s.closed=true;await engine?.dispose();engine=null;}
      s.closed=true;s.rings.clear();last=s;if(current===s)current=null;
    })();
    return s.finishing;
  }
  function abortEnrollment(job,message){
    if(enrollment!==job||job.cancelled)return false;
    job.cancelled=true;clearTimeout(job.timer);enrollment=null;
    // Terminate the owned worker before a retry may obtain a fresh client.
    if(engine===job.engine)engine=null;
    try{Promise.resolve(job.engine?.dispose()).catch(()=>{});}catch{}
    send({type:'voice-error',requestId:job.id,message});
    job.reject(Error(message));return true;
  }
  function cancelEnrollment(id){
    if(typeof id!=='string'||!enrollment||enrollment.id!==id)return false;
    return abortEnrollment(enrollment,'Сохранение голосового профиля отменено');
  }
  async function enroll({name,id,encoded,rate,segmentKey}){
    let job;
    try{
      if(typeof id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))throw Error('Неверный идентификатор запроса');
      if(enrollment){
        // A repeated request cannot terminate the existing wait with the same ID.
        if(enrollment.id===id)return;
        throw Error('Уже выполняется сохранение голосового профиля');
      }
      if(current&&!current.closed)throw Error('Остановите созвон перед сохранением образца');
      if(typeof name!=='string'||!name.trim()||name.length>80||/[\u0000-\u001f\u007f]/.test(name))throw Error('Укажите имя длиной до 80 символов');
      let samples;
      if(segmentKey){const sample=last?.samples.get(segmentKey);if(!sample)throw Error('Образец уже недоступен. Выберите файл или запишите новый созвон.');samples=sample.samples;rate=sample.rate;}
      else{
        if(!Number.isInteger(rate)||rate<8000||rate>96000||typeof encoded!=='string'||encoded.length>rate*15*4*4/3+4)throw Error('Образец должен содержать от 3 до 15 секунд звука');
        const raw=root.atob(encoded);if(raw.length%4)throw Error('Неверный PCM');
        const bytes=Uint8Array.from(raw,x=>x.charCodeAt(0));samples=new Float32Array(bytes.buffer);
      }
      if(samples.length<rate*3||samples.length>rate*15)throw Error('Для образца нужно от 3 до 15 секунд речи одного человека');
      job={id,engine:client(),cancelled:false,timer:null,reject:null};enrollment=job;
      const cancelled=new Promise((_,reject)=>{job.reject=reject;});
      job.timer=setTimeout(()=>abortEnrollment(job,'Превышено время создания голосового профиля. Попробуйте снова.'),90000);
      const check=()=>{if(job.cancelled||enrollment!==job)throw Error('Сохранение голосового профиля отменено');};
      const status=message=>{check();send({type:'speaker-status',requestId:id,message});};
      const work=(async()=>{
        status('Загружаю локальные модели и выделяю чистую речь…');
        await job.engine.prepare();check();
        const segmentation=await job.engine.segment(samples,rate);check();
        samples=root.LocalSpeechDiarization.enrollmentAudio(samples,rate,segmentation);
        status('Проверяю, что в образце один голос…');
        const middle=Math.floor(samples.length/2);
        const a=await job.engine.embed(samples.slice(0,middle),rate);check();
        const b=await job.engine.embed(samples.slice(middle),rate);check();
        if(root.LocalSpeechVoiceProfiles.cosine(a,b)<.6)throw Error('Образец неоднороден. Выберите чистую речь одного человека без музыки и перебиваний.');
        status('Создаю голосовой профиль…');
        const embedding=await job.engine.embed(samples,rate);check();
        return root.LocalSpeechVoiceProfiles.validateProfile({id,name:name.trim(),modelId:root.LocalSpeechSpeakers.modelId,embedding:Array.from(embedding)});
      })();
      const profile=await Promise.race([work,cancelled]);check();
      send({type:'voice-profile',requestId:id,profile:{...profile,embedding:Array.from(profile.embedding)}});
    }catch(error){if(!job?.cancelled)send({type:'voice-error',requestId:id,message:error.message||String(error)});}
    finally{if(job){clearTimeout(job.timer);if(enrollment===job)enrollment=null;}}
  }
  root.CallSpeakers=Object.freeze({start,feed,pressure,final,finish,enroll,cancelEnrollment});
})(globalThis);
