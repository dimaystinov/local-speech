'use strict';
const fs=require('node:fs'),{compareReference}=require('../resilience.js');
const report=JSON.parse(fs.readFileSync(process.argv[2]));
if(!report.complete)throw Error('Incomplete benchmark');
const groups={},regressions=[],improvements=[];let reruns=0,changes=0;
const latency=[];
for(const row of report.rows){
 const a=compareReference(row.reference,row.baseline),b=compareReference(row.reference,row.text);
 const g=groups[row.language]??={files:0,words:0,beforeErrors:0,afterErrors:0};g.files++;g.words+=a.referenceWords;g.beforeErrors+=a.wordErrors;g.afterErrors+=b.wordErrors;
 if(b.wordErrors>a.wordErrors)regressions.push(row.id);if(b.wordErrors<a.wordErrors)improvements.push(row.id);
 for(const p of row.parts){reruns+=Number(p.rechecked);changes+=p.changes.length;latency.push(p.elapsedSeconds);}
}
for(const g of Object.values(groups)){g.beforeWER=100*g.beforeErrors/g.words;g.afterWER=100*g.afterErrors/g.words;}
latency.sort((a,b)=>a-b);
console.log(JSON.stringify({files:report.rows.length,groups,regressions,improvements,reruns,changes,chunkSeconds:{median:latency[Math.floor(latency.length*.5)],p95:latency[Math.min(latency.length-1,Math.floor(latency.length*.95))]},gate:regressions.length===0&&improvements.length>0?'candidate-only-needs-independent-validation':'do-not-enable-automatic-replacement'},null,2));
