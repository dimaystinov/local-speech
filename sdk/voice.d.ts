export interface VoiceRequest {language:string;voiceURI?:string;rate:number;pitch:number;signal:AbortSignal;}
export interface VoiceProvider {speak(text:string, options:VoiceRequest):Promise<void>;cancel():void|Promise<void>;}
export interface VoiceOptions {provider?:VoiceProvider;language?:string;voiceURI?:string;rate?:number;pitch?:number;timeoutMs?:number;}
export interface VoiceClient {readonly speaking:boolean;voices():Array<{name:string;lang:string;voiceURI:string}>;speak(text:string):Promise<void>;cancel():void;dispose():void;}
export declare function createVoice(options?:VoiceOptions):VoiceClient;
export declare function createTauriVoiceProvider(invoke:(command:string,args?:Record<string,unknown>)=>Promise<unknown>, options?:{speakCommand?:string;cancelCommand?:string}):VoiceProvider;
