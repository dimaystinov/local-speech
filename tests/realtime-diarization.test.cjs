const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

test('real-time harness preserves selected PCM rate, packet duration and report metadata',async()=>{
  for(const rate of [16000,48000]){
    const elements=new Map(),packets=[];let time=0,timerId=0,ctx;
    for(const id of ['audio','sample-rate','language','channels','duration','sequence','run','stop','download','progress','fixture','report','summary']){
      elements.set(id,{value:'',files:[],disabled:false,textContent:'',addEventListener(type,fn){this[type]=fn;}});
    }
    for(const [id,value] of Object.entries({'sample-rate':String(rate),language:'mixed',channels:'2',duration:'10',sequence:'B'}))elements.get(id).value=value;
    ctx={console,Float32Array,Uint8Array,Date,JSON,URL,Blob,crypto:require('node:crypto').webcrypto,
      performance:{now:()=>time},navigator:{},document:{getElementById:id=>elements.get(id)},
      btoa:value=>Buffer.from(value,'binary').toString('base64'),
      setTimeout(fn,ms){if(ms<2000)queueMicrotask(()=>{time+=ms;fn();});return ++timerId;},clearTimeout(){},
      fetch:async url=>({ok:true,json:async()=>({fixture:'/fixture',name:'generated.wav'}),arrayBuffer:async()=>new ArrayBuffer(4)}),
      AudioContext:class{async decodeAudioData(){return {length:1600,duration:.1};}async close(){}},
      OfflineAudioContext:class{constructor(channels,length,outputRate){assert.equal(outputRate,rate);this.length=length;}createBufferSource(){return {connect(){},start(){}};}async startRendering(){return {getChannelData:()=>new Float32Array(this.length).fill(.1)};}},
      LocalSpeech:{version:'test'},CallBridge:{prepare:async()=>true,stop:async()=>true,
        async audio(channel,encoded,sampleRate,packetId){
          packets.push({channel,sampleRate,frames:Buffer.from(encoded,'base64').length/4});
          ctx.webkit.messageHandlers.speech.postMessage({type:'ack',channel,packetId});return true;
        }}};
    vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('./realtime-diarization.js'),'utf8'),ctx);
    await new Promise(resolve=>setImmediate(resolve));
    await elements.get('run').click();
    assert.equal(packets.length,200);assert.ok(packets.every(p=>p.sampleRate===rate&&p.frames===rate/10));
    const report=JSON.parse(elements.get('report').textContent);
    assert.equal(report.fixture.sampleRate,rate);assert.equal(report.runs[0].acknowledgedPackets,200);
    assert.equal(report.runs[0].unacknowledgedPackets,0);assert.equal(report.runs[0].completed,true);
    assert.equal(elements.get('sample-rate').disabled,false);
  }
});
