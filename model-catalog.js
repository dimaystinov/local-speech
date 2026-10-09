const SPEECH_MODELS = {
 giga_multi: {label:'GigaAM Multilingual CTC INT8 · 225 МБ · эксперимент',files:['model.int8.onnx','tokens.txt'],online:false,multilingual:true,rate:16000,featureDim:64,field:'nemoCtc',model:'model.int8.onnx',experimental:true},
 whisper_small: {label:'Whisper small INT8 · 375 МБ · эксперимент',files:['small-encoder.int8.onnx','small-decoder.int8.onnx','small-tokens.txt'],online:false,preview:true,multilingual:true,rate:16000,whisper:'small',experimental:true},
 whisper_tiny: {label:"Whisper tiny INT8 · 104 МБ",files:["tiny-encoder.int8.onnx","tiny-decoder.int8.onnx","tiny-tokens.txt"],online:false,preview:true,multilingual:true,rate:16000,whisper:"tiny"},
 whisper: {label:'Whisper base INT8 · 161 МБ',files:['base-encoder.int8.onnx','base-decoder.int8.onnx','base-tokens.txt'],online:false,preview:true,multilingual:true,rate:16000,whisper:"base"},
 small: {label:'Zipformer INT8 · 29 МБ',files:['encoder.int8.onnx','decoder.onnx','joiner.int8.onnx','tokens.txt'],online:true,rate:16000,type:'zipformer2',encoder:'encoder.int8.onnx',joiner:'joiner.int8.onnx'},
 zipformer: {label:'Zipformer FP32 · 94 МБ',files:['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt'],online:true,rate:16000,type:'zipformer2',encoder:'encoder.onnx',joiner:'joiner.onnx'},
 large: {label:'GigaAM v3 RNNT INT8 · 232 МБ',files:['encoder.int8.onnx','decoder.onnx','joiner.onnx','tokens.txt'],online:false,rate:16000,type:'nemo_transducer',encoder:'encoder.int8.onnx',joiner:'joiner.onnx'},
 giga_ctc: {label:'GigaAM v3 CTC INT8 · 225 МБ',files:['model.int8.onnx','tokens.txt'],online:false,rate:16000,field:'nemoCtc',model:'model.int8.onnx'},
 tone: {label:'T-one CTC · 144 МБ',files:['model.onnx','tokens.txt'],online:true,rate:8000,field:'toneCtc',model:'model.onnx'}
};
