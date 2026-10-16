export type SpeechLanguage = 'ru' | 'ru-RU' | 'en' | 'en-US' | 'en-GB' | 'mixed' | 'auto';
export interface SpeechOptions { assetBaseURL?: string; language?: SpeechLanguage; allowLargeModels?: boolean; cacheOnly?: boolean; terms?: string[]; pauseSeconds?: number; maxSegmentSeconds?: number; deviceHints?: {cores?:number|null;memoryGB?:number|null;mobile?:boolean;saveData?:boolean}; }
export interface SpeechEvent { type: string; schemaVersion: 1; sessionId?: string; segmentId?: number; text?: string; rawText?: string; turnComplete?: false; backend?: string; state?: string; message?: string; code?: string; wordConfidence?: WordConfidence[]; quality?: {accuracy: null; status: string; flags: string[]}; [key: string]: unknown; }
export interface SpeechClient {
 readonly state: string;
 on(type: string, listener: (event: SpeechEvent) => void): () => void;
 prepare(options?: {input?: 'microphone' | 'pcm'}): Promise<Record<string, unknown>>;
 start(options?: {input?: 'microphone' | 'pcm'}): Promise<Record<string, unknown>>;
 write(samples: Float32Array, sampleRate: number, hints?: {pendingPackets?: number}): Promise<void>;
 stop(): Promise<unknown>;
 dispose(): Promise<void>;
 diagnostics(): Record<string, unknown>;
 exportPendingAudio(): Array<{samples: Float32Array; rate: number; startMs: number; endMs: number; isSpeech: boolean}>;
}
export declare const version: string;
export declare function create(options?: SpeechOptions): SpeechClient;

export interface WordConfidence { word:string; probability:number|null; calibrated:false; languageProbability:null; }
export declare function assessWords(text:string, evidence?:Array<{word:string;probability:number|null}>):WordConfidence[];
