/* Reject unrepresentable words rather than pretending a RU vocabulary supports English. */
function prepareLocalContext(terms, tokensText) {
  const symbols=new Set();
  for(const line of tokensText.split('\n')){
    const token=line.replace(/\s+\d+\s*$/,'');
    if(token.startsWith('<'))continue;
    for(const char of token)if(char!=='▁')symbols.add(char);
  }
  const accepted=[],rejected=[],seen=new Set();
  for(const original of terms.slice(0,100)){
    const term=String(original).normalize('NFKC').toLowerCase().replace(/ё/g,'е').trim().replace(/\s+/g,' ');
    if(!term||seen.has(term))continue;seen.add(term);
    if([...term].length>80||[...term].some(c=>c!==' '&&!symbols.has(c)))rejected.push(String(original));
    else accepted.push(term);
  }
  return {accepted,rejected};
}
// Only distinctive product terminology: ordinary nouns can bias grammatical endings.
const SPEECH_CONTEXT_PROFILES={none:[],study:['флеш карточки','майндмэп']};
function composeContextTerms(profile,custom=[]){
  const terms=[],seen=new Set();
  for(const value of [...custom,...(SPEECH_CONTEXT_PROFILES[profile]||[])]){
    const term=String(value).normalize('NFKC').trim().replace(/\s+/g,' '),key=term.toLowerCase().replace(/ё/g,'е');
    if(!term||[...term].length>80||seen.has(key))continue;
    seen.add(key);terms.push(term);if(terms.length===100)break;
  }
  return terms;
}
function formatContextTerms(text,profile){
  // Exact orthography only, never phonetic/fuzzy correction or rewriting a sentence.
  const changes=[];
  const displayText=profile==='study'?text.replace(/(?<![\p{L}\p{N}])флеш\s+карточки(?![\p{L}\p{N}])/giu,(match,offset)=>{
    const replacement=match.replace(/\s+/u,'-');changes.push({offset,original:match,replacement,kind:'orthography'});return replacement;
  }):text;
  return {rawText:text,displayText,changes};
}
if(typeof module!=='undefined')module.exports={prepareLocalContext,composeContextTerms,formatContextTerms,SPEECH_CONTEXT_PROFILES};
