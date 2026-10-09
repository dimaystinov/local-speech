const {test}=require('node:test');const assert=require('node:assert/strict');
const {readDeviceHints,selectDevicePlan,allowRefinement}=require('../device-policy.js');
test('unknown hardware and mobile devices do not automatically allocate a heavy model',()=>{
 for(const h of [{cores:null,memoryGB:null},{cores:8,memoryGB:null},{cores:8,memoryGB:8,mobile:true},{cores:2,memoryGB:8},{cores:8,memoryGB:4}]){
  const p=selectDevicePlan(h);assert.equal(p.preferred,'system');assert.equal(p.primary,'small');assert.equal(p.refiner,null);
 }
});
test('capable device still needs actual fast processing before refinement',()=>{
 const p=selectDevicePlan({cores:8,memoryGB:8});assert.equal(p.refiner,'large');assert.equal(allowRefinement(p,{}),false);
 assert.equal(allowRefinement(p,{audioMs:5000,processingMs:500,recentQueueMs:50}),true);
 assert.equal(allowRefinement(p,{audioMs:5000,processingMs:2000,recentQueueMs:50}),false);
 assert.equal(allowRefinement(p,{audioMs:5000,processingMs:500,recentQueueMs:600}),false);
});
test('language, budget and data-saving constrain automatic selection',()=>{
 const h={cores:8,memoryGB:8,saveData:true};const p=selectDevicePlan(h,{language:'en-US'});
 assert.equal(p.primary,'whisper_tiny');assert.equal(p.refiner,'whisper');assert.equal(p.avoidAutomaticDownload,true);
 assert.equal(selectDevicePlan(h,{largeAllowed:false}).refiner,null);
 assert.equal(selectDevicePlan(h,{language:'auto',largeAllowed:false}).primary,null);
 assert.equal(readDeviceHints({platform:'MacIntel',maxTouchPoints:5}).mobile,true);
});
