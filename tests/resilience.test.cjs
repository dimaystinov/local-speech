const {test}=require('node:test');const assert=require('node:assert/strict');
const {AudioReplayBuffer,chooseFallback,assessQuality,compareReference}=require('../resilience.js');
test('fallback does not route English into RU model or loop',()=>{assert.equal(chooseFallback({current:'system',attempted:new Set(),lang:'en-US'}),'whisper_tiny');assert.equal(chooseFallback({current:'system',attempted:new Set(),lang:'ru-RU'}),'small');assert.equal(chooseFallback({current:'small',attempted:new Set(['small','zipformer','tone','whisper_tiny','whisper']),lang:'ru-RU'}),null);});
test('overload chooses a lighter engine and respects download budget',()=>{assert.equal(chooseFallback({current:'tone',attempted:new Set(['tone']),lang:'ru-RU',reason:'overload'}),'small');assert.equal(chooseFallback({current:'small',attempted:new Set(['small']),lang:'ru-RU',reason:'overload'}),null);assert.equal(chooseFallback({current:'small',attempted:new Set(['small']),lang:'ru-RU',largeAllowed:false}),null);});
test('audio replay excludes committed packets and copies transferable input',()=>{const b=new AudioReplayBuffer();const x=new Float32Array(1600).fill(.1);b.push(x,16000);x.fill(0);b.push(x,16000);b.commit(100);assert.equal(b.snapshot().length,1);assert.equal(b.snapshot()[0].startMs,100);b.commit(200);assert.equal(b.snapshot().length,0);});
test('bounded replay reports lost uncommitted audio',()=>{const b=new AudioReplayBuffer(.2);for(let i=0;i<5;i++)b.push(new Float32Array(1600),16000);assert.ok(b.snapshot().length<=2);assert.ok(b.lostMs>=300);});
test('quality is not a fabricated accuracy score',()=>{const good=assessQuality({text:'Это обычная фраза',durationMs:3000});assert.equal(good.accuracy,null);assert.equal(good.status,'unverified');assert.equal(assessQuality({text:'да да да да да да',durationMs:4000}).status,'review');assert.equal(assessQuality({text:'',voicedMs:3000}).status,'review');});
test('WER handles substitution, insertion, deletion and can exceed 100%',()=>{assert.equal(compareReference('Привет, мир!','привет мир').werPercent,0);assert.equal(compareReference('один два три','один четыре три').wordErrors,1);assert.equal(compareReference('один два','один').werPercent,50);assert.equal(compareReference('да','нет один два').werPercent,300);assert.ok(compareReference('','x').error);});

test('English overload moves base to tiny, never a heavier or RU model',()=>{assert.equal(chooseFallback({current:'whisper',attempted:new Set(['whisper']),lang:'en-US',reason:'overload'}),'whisper_tiny');assert.equal(chooseFallback({current:'whisper_tiny',attempted:new Set(['whisper_tiny']),lang:'en-US',reason:'overload'}),null);});

test('discarded silence is not reported as lost speech',()=>{const b=new AudioReplayBuffer(.2);for(let i=0;i<10;i++)b.push(new Float32Array(1600),16000,false);assert.equal(b.lostMs,0);});
test('alignment exposes lost negation and changed quantities without semantic normalization',()=>{
 const q=compareReference('не удаляй три карточки','удаляй тридцать карточки пожалуйста');
 assert.equal(q.deletions,1);assert.equal(q.substitutions,1);assert.equal(q.insertions,1);
 assert.ok(q.edits.some(x=>x.type==='deletion'&&x.reference==='не'));
 assert.ok(q.edits.some(x=>x.reference==='три'&&x.hypothesis==='тридцать'));
 assert.equal(compareReference('тридцать','30').werPercent,100);
});
test('CER and edit counts are bounded and agree with WER',()=>{
 const q=compareReference('кот','кит');assert.equal(q.characterErrors,1);assert.equal(q.cerPercent,33.3);
 for(const [a,b] of [['да да нет','да нет нет да'],['раз два',''],['текст','лишний текст тут']]){
  const q=compareReference(a,b);assert.equal(q.wordErrors,q.substitutions+q.deletions+q.insertions);assert.equal(q.edits.length,q.wordErrors);
 }
 assert.equal(compareReference('а'.repeat(5001),'а').cerPercent,null);
 assert.ok(compareReference('слово '.repeat(1001),'слово').error);
});
