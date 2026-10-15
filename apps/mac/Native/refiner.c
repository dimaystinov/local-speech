/* LocalSpeech optional offline refiner. stdin is bounded float32 PCM; stdout is ASR JSON. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "sherpa-onnx/c-api/c-api.h"
int main(int argc,char **argv){
 if(argc!=3)return 2;
 char *end;long rate=strtol(argv[2],&end,10);if(*end||rate<8000||rate>96000)return 2;
 size_t capacity=(size_t)rate*20;float *samples=calloc(capacity+1,sizeof(float));if(!samples)return 3;
 size_t n=fread(samples,sizeof(float),capacity+1,stdin);if(n==0||n>capacity||ferror(stdin)){free(samples);return 2;}
 for(size_t i=0;i<n;i++)if(!isfinite(samples[i])||fabsf(samples[i])>1){free(samples);return 2;}
 char encoder[4096],decoder[4096],tokens[4096];
 if(snprintf(encoder,sizeof encoder,"%s/small-encoder.int8.onnx",argv[1])>=sizeof encoder||snprintf(decoder,sizeof decoder,"%s/small-decoder.int8.onnx",argv[1])>=sizeof decoder||snprintf(tokens,sizeof tokens,"%s/small-tokens.txt",argv[1])>=sizeof tokens){free(samples);return 2;}
 SherpaOnnxOfflineRecognizerConfig config={0};config.feat_config.sample_rate=16000;config.feat_config.feature_dim=80;
 config.model_config.whisper.encoder=encoder;config.model_config.whisper.decoder=decoder;config.model_config.whisper.language="ru";config.model_config.whisper.task="transcribe";config.model_config.whisper.tail_paddings=-1;
 config.model_config.tokens=tokens;config.model_config.num_threads=2;config.model_config.provider="cpu";config.decoding_method="greedy_search";
 const SherpaOnnxOfflineRecognizer *rec=SherpaOnnxCreateOfflineRecognizer(&config);if(!rec){free(samples);return 3;}
 const SherpaOnnxOfflineStream *stream=SherpaOnnxCreateOfflineStream(rec);if(!stream){SherpaOnnxDestroyOfflineRecognizer(rec);free(samples);return 3;}
 SherpaOnnxAcceptWaveformOffline(stream,(int)rate,samples,(int)n);free(samples);SherpaOnnxDecodeOfflineStream(rec,stream);
 const SherpaOnnxOfflineRecognizerResult *r=SherpaOnnxGetOfflineStreamResult(stream);int status=4;
 if(r&&r->json&&strlen(r->json)<65536){puts(r->json);status=0;}
 if(r)SherpaOnnxDestroyOfflineRecognizerResult(r);SherpaOnnxDestroyOfflineStream(stream);SherpaOnnxDestroyOfflineRecognizer(rec);return status;
}
