/* Pure policies shared by the UI and deterministic tests. */
class AudioReplayBuffer {
  constructor(maxSeconds=30){this.maxSeconds=maxSeconds;this.clear();}
  clear(){this.items=[];this.endMs=0;this.committedMs=0;this.lostMs=0;}
  push(samples,rate,isSpeech=true){
    const startMs=this.endMs;this.endMs+=samples.length/rate*1000;
    this.items.push({samples:samples.slice(),isSpeech,rate,startMs,endMs:this.endMs});
    while(this.items.length&&this.endMs-this.items[0].startMs>this.maxSeconds*1000){const old=this.items.shift();if(old.isSpeech&&old.endMs>this.committedMs)this.lostMs+=old.endMs-Math.max(old.startMs,this.committedMs);}
  }
  commit(endMs){this.committedMs=Math.max(this.committedMs,endMs);while(this.items.length&&this.items[0].endMs<=this.committedMs+.01)this.items.shift();}
  snapshot(){return this.items.filter(x=>x.endMs>this.committedMs+.01).map(x=>({...x,samples:x.samples.slice()}));}
}
function chooseFallback({current,attempted,lang,reason,largeAllowed=true}){
  // Russian-only assets must never silently replace an English recognizer.
  if(lang!=='ru-RU')return largeAllowed?['whisper_tiny',...(reason==='overload'?[]:['whisper'])].find(x=>x!==current&&!attempted.has(x))||null:null;
  const order=reason==='quality'?['tone','zipformer','whisper_tiny','whisper','small']:['small','zipformer','tone','whisper_tiny','whisper'];
  if(reason==='overload')return current==='small'?null:(!attempted.has('small')?'small':null);
  return order.find(x=>x!==current&&!attempted.has(x)&&(largeAllowed||x==='small'))||null;
}
function words(text){return (text||'').normalize('NFKC').toLocaleLowerCase().replace(/ё/g,'е').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)||[];}
function assessQuality({text,durationMs=0,voicedMs=0,clippedRatio=0}){
  const tokens=words(text),flags=[];
  if(!tokens.length)flags.push('Речь обнаружена, но текст не получен');
  if(voicedMs>=4500&&tokens.length<=1)flags.push('Слишком мало текста для длительной речи');
  if(tokens.length>=6){const counts=new Map();for(const t of tokens)counts.set(t,(counts.get(t)||0)+1);if(Math.max(...counts.values())/tokens.length>.6)flags.push('Подозрительное повторение одного слова');}
  if(durationMs>0&&tokens.length/(durationMs/1000)>7)flags.push('Необычно много слов для длительности фразы');
  if(clippedRatio>.01)flags.push('Перегрузка микрофона: возможны искажения');
  return {status:flags.length?'review':'unverified',flags,wordCount:tokens.length,accuracy:null,note:flags.length?'Требуется проверка текста':'Явных признаков сбоя нет; точность без эталона неизвестна'};
}
function compareReference(reference,hypothesis){
  const a=words(reference),b=words(hypothesis);
  if(!a.length)return {error:'Введите эталонную фразу.'};
  if(a.length>1000||b.length>1000)return {error:'Для сравнения выберите не более 1000 слов.'};
  const matrix=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
  for(let i=0;i<=a.length;i++)matrix[i][0]=i;
  for(let j=0;j<=b.length;j++)matrix[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)matrix[i][j]=Math.min(matrix[i-1][j]+1,matrix[i][j-1]+1,matrix[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  const edits=[];let i=a.length,j=b.length,substitutions=0,deletions=0,insertions=0;
  while(i||j){
    if(i&&j&&a[i-1]===b[j-1]&&matrix[i][j]===matrix[i-1][j-1]){i--;j--;}
    else if(i&&j&&matrix[i][j]===matrix[i-1][j-1]+1){edits.push({type:'substitution',reference:a[i-1],hypothesis:b[j-1],referenceIndex:--i,hypothesisIndex:--j});substitutions++;}
    else if(i&&matrix[i][j]===matrix[i-1][j]+1){edits.push({type:'deletion',reference:a[i-1],hypothesis:'',referenceIndex:--i,hypothesisIndex:j});deletions++;}
    else{edits.push({type:'insertion',reference:'',hypothesis:b[j-1],referenceIndex:i,hypothesisIndex:--j});insertions++;}
  }
  edits.reverse();
  const ac=[...a.join(' ')],bc=[...b.join(' ')];let characterErrors=null;
  if(ac.length<=5000&&bc.length<=5000){
    let prev=Uint16Array.from({length:bc.length+1},(_,n)=>n),next=new Uint16Array(bc.length+1);
    for(let x=1;x<=ac.length;x++){next[0]=x;for(let y=1;y<=bc.length;y++)next[y]=Math.min(prev[y]+1,next[y-1]+1,prev[y-1]+(ac[x-1]===bc[y-1]?0:1));[prev,next]=[next,prev];}
    characterErrors=prev[bc.length];
  }
  return {referenceWords:a.length,hypothesisWords:b.length,wordErrors:matrix[a.length][b.length],werPercent:Math.round(matrix[a.length][b.length]/a.length*1000)/10,
    substitutions,deletions,insertions,edits,characterErrors,referenceCharacters:ac.length,cerPercent:characterErrors===null?null:Math.round(characterErrors/ac.length*1000)/10,
    normalization:'Регистр, пунктуация и ё/е нормализованы; дефисы внутри слов сохранены; числовые записи не преобразуются. CER включает пробелы; рассчитан до 5000 символов.'};
}
if(typeof module!=='undefined')module.exports={AudioReplayBuffer,chooseFallback,assessQuality,compareReference};
