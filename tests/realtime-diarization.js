/* Diagnostic harness: uses the production CallBridge without replacing inference. */
(function(root){
  'use strict';
  const $=id=>document.getElementById(id),clock=()=>performance.now();
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const finite=x=>Number.isFinite(x)?Math.round(x*100)/100:null;
  function distribution(values){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);return {n:a.length,p50:finite(a[Math.max(0,Math.ceil(a.length*.5)-1)]),p95:finite(a[Math.max(0,Math.ceil(a.length*.95)-1)]),max:finite(a.at(-1))};}
  let current=null,report=null,config={},cancel=false,running=false,fatal=false;
  function eventKey(channel,event){return `${channel}:${event.sessionId}:${event.segmentId}`;}
  function receive(message){
    const s=current;if(!s)return;
    const at=clock();
    if(message.type==='ack'){
      const key=`${message.channel}:${message.packetId}`,sent=s.pending.get(key);
      if(sent!==undefined){s.writeMs.push(at-sent);s.pending.delete(key);s.acknowledged++;}
    }else if(message.type==='failure'){
      s.failures.push(String(message.message));cancel=true;
    }else if(message.type==='speaker-status'){
      s.speakerStatus.push(String(message.message));
    }else if(message.type==='event'){
      const event=message.event||{};
      if(event.type==='final'){
        const id=eventKey(message.channel,event);
        if(s.finalTimes.has(id)){s.duplicateFinals++;return;}
        s.finalTimes.set(id,at);
        s.finals.push({id,channel:message.channel,processing_ms:finite(event.processing_ms),
          startMs:finite(event.startMs),endMs:finite(event.endMs),
          finalLagMs:finite(at-s.started-event.endMs),audioMs:finite(event.endMs-event.startMs),
          characterCount:typeof event.text==='string'?event.text.length:0,
          backend:event.backend||null,reason:event.reason||null});
      }else if(event.type==='partial'){s.partials++;}
      else if(event.type==='error'){s.failures.push(String(event.message||event.code||'SDK error'));cancel=true;}
      else if(event.type==='warning'&&event.code==='audio-buffer-overflow'){s.lossEvents++;s.lostMs=Math.max(s.lostMs,Number(event.lostMs)||0);} else if(event.type==='gap'||event.type==='audio-loss'){s.lossEvents++;s.lostMs+=Number(event.lostMs||event.durationMs)||0;}
      else if(event.type==='backend'){s.backends.push(event.backend||event.key||event.engine||'backend event');} else if(event.type==='warning'){s.warnings.push({code:event.code||'warning',message:String(event.message||'')});}
    }else if(message.type==='speaker'&&message.kind!=='pending'){
      const id=eventKey(message.channel,message),textAt=s.finalTimes.get(id);
      s.speakers.set(id,{id,kind:message.kind||'missing',latencyAfterTextMs:textAt===undefined?null:finite(at-textAt),
        segmentationMs:finite(message.segmentationMs),
        intervals:Array.isArray(message.intervals)?message.intervals.map(x=>({startMs:x.startMs,endMs:x.endMs,kind:x.kind})):[]});
    }
  }
  // The app's exact postMessage interface; all model work remains in its real workers.
  root.webkit={messageHandlers:{speech:{postMessage:receive}}};
  async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}finally{clearTimeout(timer);}}
  function encode(samples){const bytes=new Uint8Array(samples.buffer,samples.byteOffset,samples.byteLength);let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
  async function loadAudio(){
    const rate=Number($('sample-rate').value);if(![16000,48000].includes(rate))throw Error('Unsupported test sample rate');
    const file=$('audio').files[0];let bytes;
    if(file){if(file.size>100*1024*1024)throw Error('Файл больше 100 MiB');bytes=await file.arrayBuffer();}
    else{if(!config.fixture)throw Error('Выберите аудиофайл');const response=await fetch(config.fixture);if(!response.ok)throw Error('Не удалось прочитать fixture');bytes=await response.arrayBuffer();}
    const context=new AudioContext();let decoded;
    try{decoded=await context.decodeAudioData(bytes);}finally{await context.close();}
    if(!decoded.length||decoded.duration>600)throw Error('Нужен файл от 0 до 600 секунд');
    // Browser resampling/downmix occurs before timing; each run gets identical PCM.
    const resampler=new OfflineAudioContext(1,Math.ceil(decoded.duration*rate),rate),source=resampler.createBufferSource();
    source.buffer=decoded;source.connect(resampler.destination);source.start();
    const mono=(await resampler.startRendering()).getChannelData(0).slice();
    for(let i=0;i<mono.length;i++)mono[i]=Math.max(-1,Math.min(1,mono[i]));
    const digest=await crypto.subtle.digest('SHA-256',mono.buffer);
    return {samples:mono,rate,sourceDurationSeconds:mono.length/rate,sourceName:file?.name||config.name||'local file',
      pcmSha256:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')};
  }
  function makePackets(audio,seconds){
    const result=[],length=Math.round(seconds*audio.rate),size=audio.rate/10;
    // Repeat short fixtures without time compression. Boundaries are reported, not hidden.
    for(let offset=0;offset<length;offset+=size){const samples=new Float32Array(Math.min(size,length-offset));for(let j=0;j<samples.length;j++)samples[j]=audio.samples[(offset+j)%audio.samples.length];result.push(encode(samples));}
    return result;
  }
  function summarize(s){
    const speakers=[...s.speakers.values()];return {mode:s.mode,sequenceIndex:s.index,completed:s.completed,
      prepareMs:finite(s.prepareMs),replayWallMs:finite(s.replayWallMs),stopMs:finite(s.stopMs),
      submittedPackets:s.submitted,acknowledgedPackets:s.acknowledged,unacknowledgedPackets:s.pending.size,
      rejectedPackets:s.rejected,maxOutstandingPackets:s.maxOutstanding,lossEvents:s.lossEvents,lostMs:s.lostMs,
      duplicateFinals:s.duplicateFinals,finalCount:s.finals.length,partialCount:s.partials,
      asrProcessingMs:distribution(s.finals.map(x=>x.processing_ms)),finalLagMs:distribution(s.finals.map(x=>x.finalLagMs)),
      writeAckMs:distribution(s.writeMs),producerSchedulingLateMs:distribution(s.schedulingMs),
      speakerAfterTextMs:distribution(speakers.map(x=>x.latencyAfterTextMs)),speakerSegmentationMs:distribution(speakers.map(x=>x.segmentationMs)),
      speakerCounts:speakers.reduce((counts,x)=>(counts[x.kind]=(counts[x.kind]||0)+1,counts),{}),
      missingSpeakerResults:s.mode==='B'?s.finals.filter(x=>!s.speakers.has(x.id)).length:0,
      backends:s.backends,warnings:s.warnings,speakerStatus:s.speakerStatus,failures:s.failures,finals:s.finals,speakers};
  }
  function compare(runs){
    const a=runs.filter(x=>x.mode==='A'&&x.completed),b=runs.filter(x=>x.mode==='B'&&x.completed);
    if(!a.length||!b.length)return {verdict:'incomplete',reason:'Нужны завершённые A и B'};
    const ap=distribution(a.flatMap(x=>x.finals.map(f=>f.processing_ms))),bp=distribution(b.flatMap(x=>x.finals.map(f=>f.processing_ms)));
    const overhead=ap.p95>0&&bp.p95!==null?(bp.p95/ap.p95-1)*100:null;
    const transportOK=runs.every(x=>x.completed&&!x.failures.length&&!x.rejectedPackets&&!x.unacknowledgedPackets&&!x.lossEvents&&!x.lostMs);
    const hasEnoughFinals=ap.n>=10&&bp.n>=10;
    const backends=new Set(runs.flatMap(x=>x.backends));const sameBackend=backends.size===1;
    const speakerLatency=distribution(b.flatMap(x=>x.speakers.map(s=>s.latencyAfterTextMs)));
    const speakerOK=speakerLatency.p95!==null&&speakerLatency.p95<=5000&&b.every(x=>!x.missingSpeakerResults&&!x.speakerStatus.length);
    return {asrProcessingP95A:ap.p95,asrProcessingP95B:bp.p95,overheadPercent:finite(overhead),
      speakerAfterTextP95Ms:speakerLatency.p95,
      acceptance:{maximumProcessingP95OverheadPercent:15,maximumSpeakerAfterTextP95Ms:5000,speakerLatencyAndNoTimeouts:speakerOK,noQueueOverflowOrDroppedPackets:transportOK,minimum10FinalsPerArm:hasEnoughFinals,sameAsrBackend:sameBackend},
      verdict:!sameBackend?'incomparable-backends':overhead===null?'unmeasurable':!transportOK?'failed':!hasEnoughFinals?'insufficient-samples':overhead<=15&&speakerOK?'latency-gate-passed':'latency-gate-failed',
      limitation:'Это проверка задержки конкретного устройства и аудио. Она не доказывает точность диаризации, качество ASR или стабильность длинных звонков. Неопределённые голоса учитываются отдельно.'};
  }
  function render(){
    if(!report)return;report.comparison=compare(report.runs);
    $('report').textContent=JSON.stringify(report,null,2);
    const rows=report.runs.map(x=>`<tr><td>${x.sequenceIndex+1}: ${x.mode}</td><td>${x.finalCount}</td><td>${x.asrProcessingMs.p95??'—'}</td><td>${x.finalLagMs.p95??'—'}</td><td>${x.writeAckMs.p95??'—'}</td><td>${x.speakerAfterTextMs.p95??'—'}</td><td>${x.failures.length}/${x.rejectedPackets+x.unacknowledgedPackets}</td></tr>`).join('');
    $('summary').innerHTML='<table><thead><tr><th>Прогон</th><th>Фразы</th><th>ASR p95, мс</th><th>Лаг p95, мс</th><th>ACK p95, мс</th><th>Голос p95, мс</th><th>Ошибки/пакеты</th></tr></thead><tbody>'+rows+'</tbody></table>';
    $('download').disabled=false;
  }
  async function runOnce(mode,index,options,packets,rate){
    const s={mode,index,pending:new Map(),writeMs:[],schedulingMs:[],finalTimes:new Map(),finals:[],speakers:new Map(),speakerStatus:[],failures:[],backends:[],warnings:[],
      submitted:0,acknowledged:0,rejected:0,maxOutstanding:0,lossEvents:0,lostMs:0,duplicateFinals:0,partials:0,started:NaN,completed:false};
    current=s;const began=clock();
    try{
      $('progress').textContent=`${index+1}/${report.sequence.length}: ${mode} — загружаю настоящие модели…`;
      const ready=await bounded(root.CallBridge.prepare({...options,speakerEnabled:mode==='B',voiceProfiles:[]}),150000,'Prepare');
      s.prepareMs=clock()-began;if(!ready)throw Error('CallBridge prepare failed');
      if(cancel)return;
      s.started=clock();const inflight=new Set();
      for(let packet=0;packet<packets.length&&!cancel;packet++){
        const due=s.started+packet*100;await sleep(Math.max(0,due-clock()));if(cancel)break;
        s.schedulingMs.push(clock()-due);
        for(const channel of options.channels){
          const key=`${channel}:${packet}`;s.pending.set(key,clock());s.submitted++;s.maxOutstanding=Math.max(s.maxOutstanding,s.pending.size);
          // Intentionally do not await audio(): a serial producer would conceal overload.
          let job;job=Promise.resolve(root.CallBridge.audio(channel,packets[packet],rate,packet)).then(ok=>{if(!ok)s.rejected++;},error=>{s.rejected++;s.failures.push(String(error.message||error));cancel=true;}).finally(()=>inflight.delete(job));inflight.add(job);
        }
        if(packet%10===0)$('progress').textContent=`${index+1}/${report.sequence.length}: ${mode} — ${(packet/10).toFixed(0)} / ${report.durationSeconds} с, фраз ${s.finals.length}, пакетов в очереди ${s.pending.size}`;
      }
      if(!cancel)await sleep(Math.max(0,s.started+packets.length*100-clock()));s.replayWallMs=clock()-s.started;
      await bounded(Promise.all(inflight),45000,'Audio drain');
    }catch(error){s.failures.push(String(error.message||error));cancel=true;}
    finally{
      const stoppingAt=clock();
      try{await bounded(root.CallBridge.stop(),45000,'Stop');}catch(error){s.failures.push(String(error.message||error));cancel=true;fatal=true;}
      s.stopMs=clock()-stoppingAt;s.completed=!cancel&&!s.failures.length;
      report.runs.push(summarize(s));current=null;render();
    }
  }
  async function start(){
    if(running||fatal)return;running=true;cancel=false;$('run').disabled=true;$('stop').disabled=false;
    for(const id of ['audio','language','channels','sample-rate','duration','sequence'])$(id).disabled=true;
    try{
      const duration=Number($('duration').value),sequence=$('sequence').value;
      if(!Number.isInteger(duration)||duration<10||duration>120||!['ABBA','AB','A','B'].includes(sequence))throw Error('Некорректные параметры');
      $('progress').textContent='Готовлю одинаковые PCM-пакеты для всех прогонов…';
      const audio=await loadAudio(),packets=makePackets(audio,duration),channels=$('channels').value==='2'?['microphone','call']:['call'];
      report={schemaVersion:1,startedAt:new Date().toISOString(),sdkVersion:root.LocalSpeech?.version,
        browser:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency??null,deviceMemoryGiB:navigator.deviceMemory??null,
        sourceHashes:config.sourceHashes||null,crossOriginIsolated:root.crossOriginIsolated,sequence,durationSeconds:duration,language:$('language').value,channels,
        fixture:{name:audio.sourceName,sampleRate:audio.rate,durationSeconds:audio.sourceDurationSeconds,pcmSha256:audio.pcmSha256,repetitions:duration/audio.sourceDurationSeconds},
        asr:'Actual app CallBridge; allowLargeModels=false; local PCM; 100 ms producer; no model/device override',
        note:'No voice profiles: anonymous diarization workload. Processing_ms in streaming RU is finalization time, not full decoder CPU time. ACK/lag metrics cover the actual write path.',runs:[]};render();
      const options={language:report.language,channels,terms:[],cacheOnly:false,allowLargeModels:false};
      for(let index=0;index<sequence.length&&!cancel;index++){await runOnce(sequence[index],index,options,packets,audio.rate);if(index+1<sequence.length&&!cancel)await sleep(1500);}
      report.finishedAt=new Date().toISOString();report.cancelled=cancel;render();
      $('progress').textContent=fatal?'Таймаут очистки: перезагрузите страницу перед следующим тестом.':cancel?'Измерение остановлено; частичные результаты сохранены.':'Измерение завершено. Сравнение и ограничения — в отчёте.';
    }catch(error){$('progress').textContent=error.message||String(error);}
    finally{running=false;$('run').disabled=fatal;$('stop').disabled=true;for(const id of ['audio','language','channels','sample-rate','duration','sequence'])$(id).disabled=false;}
  }
  $('run').addEventListener('click',start);$('stop').addEventListener('click',()=>{cancel=true;$('stop').disabled=true;$('progress').textContent='Останавливаю подачу аудио и завершаю обработку…';});
  $('download').addEventListener('click',()=>{if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='diarization-browser-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  fetch('/benchmark-config').then(response=>response.json()).then(value=>{config=value;$('fixture').textContent=value.name?'Серверный тестовый файл: '+value.name:'Серверный файл не задан: выберите свой файл.';}).catch(()=>{$('fixture').textContent='Выберите локальный аудиофайл.';});
})(globalThis);
