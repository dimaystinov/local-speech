/* Optional speaker analysis; never blocks the ASR write/ACK path. */
(function(root){
  'use strict';
  let engine, current, last;
  const send=message=>root.webkit?.messageHandlers?.speech?.postMessage(message);
  function client(){
    if(!engine||engine.closed)engine=root.LocalSpeechSpeakers.create({assetBaseURL:new URL('/sdk/',root.location.href).href});
    return engine;
  }
  const key=(channel,event)=>`${channel}:${event.sessionId}:${event.segmentId}`;
  function start({enabled=false,profiles=[]}={}){
    const s={enabled,closed:false,rings:new Map(),samples:new Map(),outstanding:new Map(),tail:Promise.resolve(),pending:0};
    last=null;current=s;
    if(enabled){
      try{s.matcher=new root.LocalSpeechVoiceProfiles.Session(profiles);void client().prepare().catch(error=>{if(current===s&&!s.closed){s.enabled=false;send({type:'speaker-status',message:'Голоса недоступны: '+error.message});}});}
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
  async function analyze(samples,rate,matcher){
    const count=Math.max(1,Math.ceil(samples.length/rate/4)),size=Math.floor(samples.length/count);
    const intervals=[];
    for(let i=0;i<count;i++){
      const begin=i*size,end=i===count-1?samples.length:(i+1)*size;
      if((end-begin)/rate<1.5){intervals.push({startMs:begin/rate*1000,endMs:end/rate*1000,kind:'uncertain',label:'Короткая реплика',speakerId:null});continue;}
      const vector=await client().embed(samples.slice(begin,end),rate);
      intervals.push({startMs:begin/rate*1000,endMs:end/rate*1000,...matcher.classify(vector)});
    }
    const ids=new Set(intervals.map(x=>x.speakerId).filter(Boolean));
    if(intervals.some(x=>x.kind==='uncertain'))return {label:'Голос не определён',kind:'uncertain',intervals};
    if(ids.size!==1){
      // New anonymous clusters can reflect phonetic variation, not a real speaker change.
      if(intervals.every(x=>x.kind==='known'))return {label:'Несколько голосов',kind:'mixed',intervals};
      return {label:'Голос не определён',kind:'uncertain',intervals};
    }
    return {label:intervals[0].label,kind:intervals[0].kind,speakerId:intervals[0].speakerId,intervals};
  }
  function final(s,channel,event){
    if(!s?.enabled||s.closed||!event.rawText)return;
    const ring=s.rings.get(channel),samples=ring?.get(event.startMs,event.endMs),rate=ring?.rate;
    if(!samples||samples.length<rate*1.5){annotation(s,channel,event,{label:'Голос не определён',kind:'uncertain',canEnroll:false});return;}
    const id=key(channel,event);
    // At most eight recent excerpts, each <=15 seconds. No raw audio persistence.
    const excerpt=samples.slice(0,rate*15);s.samples.set(id,{samples:excerpt,rate});
    while(s.samples.size>8)s.samples.delete(s.samples.keys().next().value);
    annotation(s,channel,event,{label:'Определяется голос…',kind:'pending',canEnroll:true});
    if(s.pending>=4){annotation(s,channel,event,{label:'Голос не определён · очередь занята',kind:'uncertain',canEnroll:true});return;}
    s.pending++;s.outstanding.set(id,{channel,event});
    s.tail=s.tail.then(async()=>{
      if(s.closed)return;
      try{annotation(s,channel,event,{...await analyze(samples,rate,s.matcher),canEnroll:true});}
      catch(error){annotation(s,channel,event,{label:'Голос не определён',kind:'uncertain',canEnroll:true});if(!s.closed)send({type:'speaker-status',message:'Не удалось определить голос: '+error.message});}
    }).finally(()=>{s.pending--;s.outstanding.delete(id);});
  }
  async function finish(s){
    if(!s)return;
    let timer;
    const complete=await Promise.race([s.tail.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),6000);})]);
    clearTimeout(timer);
    if(!complete){for(const {channel,event} of s.outstanding.values())annotation(s,channel,event,{label:'Голос не определён · таймаут',kind:'uncertain',canEnroll:true});send({type:'speaker-status',message:'Часть голосов не определена: превышено время ожидания.'});s.closed=true;await engine?.dispose();engine=null;}
    s.closed=true;s.rings.clear();last=s;if(current===s)current=null;
  }
  async function enroll({name,id,encoded,rate,segmentKey}){
    try{
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
      // Two disjoint halves guard grossly mixed enrollment; not an overlap detector.
      const middle=Math.floor(samples.length/2),a=await client().embed(samples.slice(0,middle),rate),b=await client().embed(samples.slice(middle),rate);
      if(root.LocalSpeechVoiceProfiles.cosine(a,b)<.6)throw Error('Образец неоднороден. Выберите чистую речь одного человека без музыки и перебиваний.');
      const embedding=await client().embed(samples,rate);
      const profile=root.LocalSpeechVoiceProfiles.validateProfile({id,name:name.trim(),modelId:root.LocalSpeechSpeakers.modelId,embedding:Array.from(embedding)});
      send({type:'voice-profile',requestId:id,profile:{...profile,embedding:Array.from(profile.embedding)}});
    }catch(error){send({type:'voice-error',requestId:id,message:error.message||String(error)});}
  }
  root.CallSpeakers=Object.freeze({start,feed,final,finish,enroll});
})(globalThis);
