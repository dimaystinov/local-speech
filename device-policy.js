/* Hints are approximate and often absent (Safari); runtime measurements override them. */
function readDeviceHints(nav=globalThis.navigator){
  const positive=value=>Number.isFinite(value)&&value>0?value:null;
  return {cores:positive(nav?.hardwareConcurrency),memoryGB:positive(nav?.deviceMemory),mobile:/Android|iPhone|iPad|Mobile/i.test(nav?.userAgent||'')||(/Mac/.test(nav?.platform||'')&&(nav?.maxTouchPoints||0)>1),saveData:nav?.connection?.saveData===true};
}
function selectDevicePlan(hints,{language='ru-RU',largeAllowed=true,refine=true}={}){
  const ru=language==='ru-RU',limited=(hints.cores!==null&&hints.cores<=2)||(hints.memoryGB!==null&&hints.memoryGB<=4)||hints.mobile;
  const unknown=hints.cores===null||hints.memoryGB===null;
  const primary=ru?'small':largeAllowed?'whisper_tiny':null;
  let second=null,reason='Уточнение отключено';
  if(refine&&largeAllowed){
    if(limited)reason='Экономный режим: мобильное устройство, мало памяти или ядер';
    else if(unknown)reason='Память или процессор скрыты браузером: тяжёлое уточнение автоматически не загружается';
    else if(hints.memoryGB>=8&&hints.cores>=4){second=ru?'large':'whisper';reason='Уточнение разрешено после измерения скорости первого прохода';}
    else reason='Недостаточно подтверждённых ресурсов для двух моделей одновременно';
  }
  return {preferred:'system',primary,refiner:second,reason,tier:limited?'light':unknown?'unknown':second?'capable':'balanced',avoidAutomaticDownload:hints.saveData};
}
function allowRefinement(plan,metrics={}){
  if(!plan.refiner)return false;
  // At least two seconds of real work, with headroom for capture and the other worker.
  return metrics.audioMs>=2000&&metrics.processingMs/metrics.audioMs<.35&&(metrics.recentQueueMs||0)<250;
}
if(typeof module!=='undefined')module.exports={readDeviceHints,selectDevicePlan,allowRefinement};
