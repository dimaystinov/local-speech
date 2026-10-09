/* No cloud fallback. The presence of SpeechRecognition alone is insufficient. */
function parseContextTerms(input) {
  return [...new Set(String(input).split(/[,;\n]/).map(s=>s.trim()).filter(Boolean))].slice(0,100).map(s=>[...s].slice(0,80).join(''));
}
class SystemRecognizer {
  constructor(API, emit, state, Phrase=globalThis.SpeechRecognitionPhrase) { this.API=API; this.Phrase=Phrase; this.emit=(...args)=>this.notify(emit,...args); this.state=(...args)=>this.notify(state,...args); this.active=false; this.generation=0; this.contextInfo={status:'not-requested',count:0}; }
  notify(callback,...args) {
    try{const result=callback?.(...args);if(result&&typeof result.catch==='function')result.catch(error=>{this.callbackError=error;});}
    catch(error){this.callbackError=error;}
  }
  async check(lang) {
    if(lang==='auto')return {status:'unsupported',message:'Для смешанной RU/EN речи используется многоязычная локальная модель. Включите микрофон для автоматического выбора резерва.'};
    if (!this.API || !('processLocally' in this.API.prototype) || typeof this.API.available!=='function')
      return {status:'unsupported',message:'Браузер не предоставляет подтверждённое локальное распознавание. Выберите локальную RU-модель.'};
    try {
      let timer;const status=await Promise.race([this.API.available({langs:[lang],processLocally:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Проверка заняла больше 5 секунд')),5000);})]).finally(()=>clearTimeout(timer));
      const messages={available:'Браузер сообщает о локальной поддержке. Работа проверится на первой фразе.',downloadable:'Нужно установить системный языковой пакет.',downloading:'Браузер загружает языковой пакет. Повторите проверку позже.',unavailable:'Локальный пакет этого языка недоступен. Выберите другой язык или RU-модель.'};
      return {status,message:messages[status]||'Неизвестный статус системного движка.'};
    } catch(e) { return {status:'error',message:'Проверка локального движка: '+e.message}; }
  }
  async install(lang) {
    if(typeof this.API?.install!=='function')throw Error('Браузер не поддерживает установку языковых пакетов.');
    if(!await this.API.install({langs:[lang],processLocally:true}))throw Error('Языковой пакет не установлен.');
    return this.check(lang);
  }
  start(lang, sessionId, terms=[]) {
    if(!this.API || !('processLocally' in this.API.prototype))throw Error('Локальный режим недоступен.');
    // Structured hints are already phrases: UI delimiters must not split names.
    if(!Array.isArray(terms))throw new TypeError('terms must be an array');
    if(terms.length>100)throw new RangeError('At most 100 terms are supported');
    const preservedTerms=terms.map(term=>{
      if(typeof term!=='string'||!term.trim())throw new TypeError('Each term must be a nonempty string');
      if(term.length>80)throw new RangeError('Each term must contain at most 80 characters');
      if(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(term))throw new TypeError('Terms cannot contain control characters or line separators');
      return term;
    });
    this.dispose();
    this.active=true; this.sessionId=sessionId; this.lang=lang; this.segment=0; this.failures=0; this.hasInterim=false; this.lastResultAt=0;
    this.terms=preservedTerms;this.contextRejected=false;
    const generation=++this.generation;
    try{this.open(generation);}catch(error){this.dispose();throw error;}
  }
  open(generation) {
    if(!this.active||generation!==this.generation)return;
    clearTimeout(this.timer);this.timer=undefined;
    const previous=this.recognition;this.recognition=null;try{previous?.abort();}catch{}
    const r=new this.API(); this.recognition=r;this.nativeEnded=false; const ids=new Map(), finalized=new Set(), interim=new Map(); let hadResult=false;
    let interruptedReported=false, ended=false;
    const owns=()=>generation===this.generation&&this.recognition===r;
    const current=()=>owns()&&!ended;
    const ownSessionId=this.sessionId;
    const reportInterrupted=reason=>{
      if(interruptedReported)return;interruptedReported=true;
      for(const fragment of interim.values()){if(!owns())break;this.emit({type:'interrupted',sessionId:ownSessionId,...fragment,backend:'system',timingReliable:false,reason,turnComplete:false});}
    };
    this.reportInterrupted=reason=>{if(current())reportInterrupted(reason);};
    r.processLocally=true; r.continuous=true; r.interimResults=true; r.lang=this.lang;
    this.contextInfo={status:this.terms.length?'unsupported':'not-requested',count:0};
    if(this.terms.length&&!this.contextRejected&&'phrases' in r&&typeof this.Phrase==='function'){
      try{r.phrases=this.terms.map(term=>new this.Phrase(term,3));this.contextInfo={status:'applied',count:this.terms.length};}
      catch{this.contextInfo={status:'rejected',count:0};}
    }
    if(this.contextRejected)this.contextInfo={status:'rejected',count:0};
    this.state('context',this.contextInfo);
    r.onstart=()=>{if(current())this.state('listening');};
    r.onaudiostart=()=>{if(current())this.state('audio-started');};
    r.onspeechstart=()=>{if(current())this.state('speech-detected');};
    r.onresult=e=>{
      if(!current())return;
      for(let i=e.resultIndex;i<e.results.length;i++){
        if(!current())return;
        if(finalized.has(i))continue;
        const text=e.results[i][0].transcript.trim();
        if(!ids.has(i))ids.set(i,++this.segment);
        hadResult=true; this.failures=0; this.lastResultAt=Date.now();
        if(e.results[i].isFinal){finalized.add(i);interim.delete(i);}else interim.set(i,{segmentId:ids.get(i),text});
        this.hasInterim=interim.size>0;
        this.emit({type:e.results[i].isFinal?'final':'partial',sessionId:this.sessionId,segmentId:ids.get(i),text,backend:'system',timingReliable:false,reason:'recognizer',turnComplete:false,context:{...this.contextInfo}});
      }
    };
    r.onerror=e=>{
      if(!current())return;
      if(e.error==='no-speech')return;
      if(e.error==='phrases-not-supported'&&!this.contextRejected&&this.contextInfo.status==='applied'){
        this.contextRejected=true;this.contextInfo={status:'rejected',count:0};this.state('context',this.contextInfo);try{r.abort();}catch{r.onend();}return;
      }
      reportInterrupted(e.error);
      if(!current())return;
      this.active=false; ++this.generation; this.state('error','Системный движок: '+e.error+'. Облачный режим не включён.');
      try{r.abort();}catch{}
    };
    r.onend=()=>{
      if(!current())return;
      ended=true;this.nativeEnded=true;
      reportInterrupted('ended-before-final');
      if(!owns())return;
      this.emit({type:'clear-partial'});
      if(!owns())return;
      if(!this.active){this.state(interim.size?'stopped-incomplete':'stopped',interim.size?'Последняя фраза не подтверждена движком. Скачайте сохранённое аудио и проверьте незавершённый текст в отчёте.':undefined);return;}
      if(interim.size){this.active=false;++this.generation;this.state('error','Системный движок завершился без окончательного текста. Незавершённая речь передаётся локальному резерву.');return;}
      if(!hadResult&&++this.failures>3){this.active=false;this.state('error','Системный движок завершает сеанс без результатов. Проверьте язык и микрофон.');return;}
      this.state('restarting');
      if(!owns()||!this.active)return;
      this.timer=setTimeout(()=>{try{this.open(generation);}catch(e){this.dispose();this.state('error',e.message);}},350);
    };
    if(current())r.start();
  }
  endPhrase() { if(this.active&&this.hasInterim){this.hasInterim=false;try{this.recognition?.stop();}catch{}} }
  stop() { this.active=false; clearTimeout(this.timer);this.timer=undefined;if(this.nativeEnded){this.state('stopped');return;}try{this.recognition?.stop();}catch{} }
  stopTimedOut() { this.reportInterrupted?.('stop-timeout');this.dispose();this.state('stopped-incomplete','Движок не подтвердил завершение. Скачайте сохранённое аудио и проверьте незавершённый текст в отчёте.'); }
  dispose() { this.active=false; ++this.generation; this.reportInterrupted=null;clearTimeout(this.timer);this.timer=undefined;const recognition=this.recognition;this.recognition=null;try{recognition?.abort();}catch{} }
}
if(typeof module!=='undefined')module.exports={SystemRecognizer,parseContextTerms};
