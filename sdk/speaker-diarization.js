/* Local segmentation + clean-speech identity. Never assigns words to speakers. */
(function(root,factory){
  const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.LocalSpeechDiarization=api;
})(globalThis,function(){
  'use strict';
  const MIN_SPEECH_MS=2000,MIN_CONFIDENCE=.6,EDGE_MS=60;
  const unknown=()=>({kind:'uncertain',label:'Голос не определён',speakerId:null});
  function validateIntervals(result,durationMs){
    if(!result||!Array.isArray(result.intervals)||result.intervals.length>6000||!Number.isFinite(result.durationMs)||Math.abs(result.durationMs-durationMs)>2)throw Error('Invalid segmentation result');
    let previous=0;
    return result.intervals.map(item=>{
      if(!item||!Number.isFinite(item.startMs)||!Number.isFinite(item.endMs)||item.startMs<previous-.01||item.startMs<0||item.endMs<=item.startMs||item.endMs>durationMs+1||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>1||!Array.isArray(item.speakers)||item.speakers.length>2||new Set(item.speakers).size!==item.speakers.length||item.speakers.some(x=>!Number.isInteger(x)||x<0||x>2))throw Error('Invalid segmentation interval');
      previous=item.endMs;return {...item,speakers:item.speakers.slice()};
    });
  }
  function cleanSpeech(samples,rate,intervals,id){
    const ranges=intervals.filter(x=>x.speakers.length===1&&x.speakers[0]===id&&x.confidence>=MIN_CONFIDENCE&&x.endMs-x.startMs>=200).map(x=>[Math.ceil((x.startMs+EDGE_MS)*rate/1000),Math.floor((x.endMs-EDGE_MS)*rate/1000)]);
    // Input is already bounded to 15 seconds. Keep all clean evidence, including
    // late turns; truncating the longest run can hide a speaker change at its end.
    const length=ranges.reduce((sum,[start,end])=>sum+end-start,0);
    const audio=new Float32Array(length);let at=0,energy=0,clipped=0;
    for(const [start,end] of ranges){audio.set(samples.subarray(start,end),at);at+=end-start;}
    for(const x of audio){energy+=x*x;if(Math.abs(x)>=.995)clipped++;}
    const durationMs=audio.length*1000/rate;
    const usable=durationMs>=MIN_SPEECH_MS&&Math.sqrt(energy/Math.max(1,audio.length))>=.0005&&clipped/Math.max(1,audio.length)<.01;
    return {audio,durationMs,usable};
  }
  function cosine(a,b){
    if(a.length!==b.length)throw Error('Incompatible speaker vectors');
    let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
    return aa>0&&bb>0?dot/Math.sqrt(aa*bb):-1;
  }
  function enrollmentCandidate(samples,rate,raw){
    const voices=[...new Set(raw.flatMap(x=>x.speakers))].map(id=>({id,...cleanSpeech(samples,rate,raw,id)})).sort((a,b)=>b.durationMs-a.durationMs);
    const overlap=raw.filter(x=>x.speakers.length===2).reduce((n,x)=>n+x.endMs-x.startMs,0);
    const uncertain=raw.filter(x=>x.speakers.length&&x.confidence<MIN_CONFIDENCE).reduce((n,x)=>n+x.endMs-x.startMs,0);
    const best=voices[0];
    if(!best?.usable||best.durationMs<3000||overlap>=100||uncertain>800||voices.slice(1).some(x=>x.durationMs>=500))return null;
    return best;
  }
  function summarize(intervals){
    const speech=intervals.filter(x=>x.kind!=='silence');
    if(!speech.length)return {kind:'uncertain',label:'Речь не обнаружена'};
    if(speech.some(x=>x.kind==='overlap'&&x.endMs-x.startMs>=100))return {kind:'overlap',label:'Говорят одновременно'};
    if(speech.some(x=>x.kind==='uncertain'||x.kind==='overlap'))return unknown();
    const ids=new Set(speech.map(x=>x.speakerId));
    if(ids.size!==1)return {kind:'mixed',label:'Несколько говорящих'};
    return {kind:speech[0].kind,label:speech[0].label,speakerId:speech[0].speakerId};
  }
  async function analyze(samples,rate,{engine,matcher,beforeInference=async()=>{},cancelled=()=>false}={}){
    if(!(samples instanceof Float32Array)||!Number.isInteger(rate)||rate<8000||rate>96000||samples.length<rate||samples.length>rate*15)throw Error('Diarization requires 1..15 seconds of normalized mono PCM');
    for(const x of samples)if(!Number.isFinite(x)||Math.abs(x)>1)throw Error('Invalid diarization PCM');
    const check=()=>{if(cancelled())throw Error('Diarization cancelled');};
    check();await beforeInference();check();
    const result=await engine.segment(samples,rate);check();
    const raw=validateIntervals(result,samples.length*1000/rate),identities=new Map(),inconsistent=new Set();
    const speakers=new Set(raw.flatMap(x=>x.speakers));
    for(const id of speakers){
      const clean=cleanSpeech(samples,rate,raw,id);
      if(!clean.usable){identities.set(id,unknown());continue;}
      await beforeInference();check();
      // A segmentation slot may wrongly merge two consecutive people. Check separated
      // acoustic evidence before allowing the pooled embedding to name the whole slot.
      let embedding;
      if(clean.durationMs>=4000){
        const middle=Math.floor(clean.audio.length/2);
        const a=await engine.embed(clean.audio.slice(0,middle),rate);check();
        await beforeInference();check();
        const b=await engine.embed(clean.audio.slice(middle),rate);check();
        if(cosine(a,b)<.55){identities.set(id,unknown());inconsistent.add(id);continue;}
        // Reuse the two verified vectors: a third full-window inference adds latency.
        const an=Math.hypot(...a),bn=Math.hypot(...b);
        embedding=Float32Array.from(a,(v,i)=>(v/an+b[i]/bn)/2);
      }
      else embedding=await engine.embed(clean.audio,rate);
      check();
      identities.set(id,matcher.classify(embedding));
    }
    const intervals=raw.map(x=>{
      let identity;
      if(!x.speakers.length)identity={kind:'silence',label:'Пауза'};
      else if(x.speakers.length===2&&x.confidence>=.5)identity={kind:'overlap',label:'Говорят одновременно',speakerIds:x.speakers.map(id=>identities.get(id)?.speakerId).filter(Boolean)};
      else if(x.confidence<MIN_CONFIDENCE)identity=unknown();
      else identity=identities.get(x.speakers[0])||unknown();
      return {startMs:x.startMs,endMs:x.endMs,...identity};
    });
    // Enrollment is allowed only for enough clean evidence of one local voice.
    const canEnroll=inconsistent.size===0&&!!enrollmentCandidate(samples,rate,raw);
    return {...summarize(intervals),intervals,canEnroll,segmentationMs:result.processingMs??null};
  }
  function enrollmentAudio(samples,rate,result){
    const raw=validateIntervals(result,samples.length*1000/rate);
    const clean=enrollmentCandidate(samples,rate,raw);
    if(!clean)throw Error('Нужно минимум 3 секунды чистой речи одного человека без перебиваний');
    return clean.audio;
  }
  return Object.freeze({analyze,validateIntervals,cleanSpeech,enrollmentAudio,summarize});
});
