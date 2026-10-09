const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const {prepareLocalContext,composeContextTerms,formatContextTerms}=require('../context.js');
const tokens=fs.readFileSync(require('node:path').join(__dirname,'../assets/context/ru-tokens.txt'),'utf8');
test('local RU context rejects English and syntax injection rather than silently claiming support',()=>{
 const x=prepareLocalContext(['Docker','кубернетес','API','слово :9','ещё','<unk>'],tokens);
 assert.deepEqual(x.accepted,['кубернетес','еще']);assert.deepEqual(x.rejected,['Docker','API','слово :9','<unk>']);
});
test('domain context does not bias ordinary nouns and preserves custom term priority',()=>{
 assert.deepEqual(composeContextTerms('study',['Майндмэп',' докер ']),['Майндмэп','докер','флеш карточки']);
 assert.deepEqual(composeContextTerms('unknown',['конспект']),['конспект']);
 assert.equal(composeContextTerms('study',Array.from({length:150},(_,i)=>'термин '+i)).length,100);
});
test('orthography retains raw text, negation, quantities and unrelated words',()=>{
 const text='Не удаляй три флеш карточки, а не тридцать. Флеш карточки.';
 const result=formatContextTerms(text,'study');
 assert.equal(result.rawText,text);assert.equal(result.displayText,'Не удаляй три флеш-карточки, а не тридцать. Флеш-карточки.');
 assert.equal(result.changes.length,2);
 assert.equal(formatContextTerms(text,'none').displayText,text);
 assert.equal(formatContextTerms('флишкорточки суперфлеш карточки флеш карточкины','study').changes.length,0);
});
test('local context bounds and normalizes vocabulary',()=>{
 assert.deepEqual(prepareLocalContext([' Докер ','докер','  нейронная   сеть '],tokens).accepted,['докер','нейронная сеть']);
 assert.equal(prepareLocalContext(['а'.repeat(81)],tokens).rejected.length,1);
});
