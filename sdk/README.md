# LocalSpeech browser SDK — integration candidate

[Web/Tauri setup, local TTS and updates (Russian)](../docs/integration.md). Voice is a separate ESM entry `local-speech-sdk/voice`; ASR API remains unchanged.

Headless continuous local recognition for an existing web application. Models and runtime are self-hosted, audio is processed on the client. This is a browser integration candidate, not a claim of paid-ASR parity or certified phone support. Native iOS is a separate deferred adapter.

Build from the project root:

```sh
node tools/build-sdk.cjs --models=small,whisper_tiny,whisper
```

Serve the resulting `dist/local-speech/` on your application's origin over HTTPS (localhost is allowed for development). Preserve subdirectories. Do not upload the repository, fixtures, recordings or experiments as your production distribution. The model manifest determines the actual selected assets. Missing models fail explicitly; the SDK never redirects audio to cloud ASR. Default package includes RU small, multilingual tiny and base; model downloads are on demand, not all at startup.

```html
<script src="/assets/speech/local-speech.js"></script>
<script>
const speech = LocalSpeech.create({
  assetBaseURL: new URL('/assets/speech/', location.href).href,
  language: 'mixed', // RU+EN in the same phrase
  terms: ['Docker', 'Kubernetes', 'майндмэп'],
  allowLargeModels: true,
  cacheOnly: false,
  pauseSeconds: 0.7,
  maxSegmentSeconds: 12 // offline window cap; 3..20 seconds
});
speech.on('partial', event => showPreview(event.text));
speech.on('final', event => saveSegment(event.sessionId, event.segmentId, event.rawText));
speech.on('error', event => showError(event.message));
startButton.onclick = () => speech.start().catch(showError);
stopButton.onclick = () => speech.stop();
// On application unmount:
// await speech.dispose();
</script>
```

The host supplies the UI functions in this example. `final` ends an audio segment, not the user's conversation turn: `turnComplete:false` is always preserved. Do not dispatch an assistant response on every pause. Keep partial/final types separate when deduplicating sessionId+segmentId. Input transcripts are untrusted user content.

A module entry and TypeScript definitions are included when built. SDK does not need a framework and does not register a service worker or replace host UI. Workers/worklets require same-origin resources and appropriate CSP; permit the served script/worker URLs and WebAssembly compilation under your actual browser policy. Test your HTTPS/CSP embedding, not only localhost.

## Language and resources

Supported policy values: ru/ru-RU, en/en-US/en-GB, mixed, auto. Other languages are rejected explicitly, not silently routed to Russian. Models may support more languages, but those routes are not validated by this SDK.

System local-only is probed first for a fixed RU or EN locale. Missing API/language pack falls back locally; language pack installation is not silently initiated. Mixed/auto bypass single-locale Web Speech. PCM input always bypasses Web Speech, which cannot consume the supplied PCM.

On confirmed desktop >=8GB and >=4 logical cores, multilingual base is tried first, then tiny. Unknown/mobile/limited devices use tiny. RU uses Zipformer small first; larger RU alternatives are permitted only for confirmed resources and only if their files are actually supplied. Runtime queue overflow switches only to a lower resource rank; retries are bounded to distinct candidates. Save Data forces cache-only weights. `allowLargeModels:false` disables larger alternatives; multilingual tiny is still ~104MB, not a zero-download path.

`deviceHints:{memoryGB,cores,mobile,saveData}` optionally overrides browser hints for a native embedding. Supply a conservative per-client resource budget; values do not measure inference speed or authorize remote processing.

These are conservative launch heuristics, not measured phone certification. ResourceRank orders allowed fallback routes, not quality. Exact quality is never inferred from RAM, model size or API confidence.

Terms: at most32 strings of80 characters; controls/blank/nonstring terms rejected. They are hints, not reference transcripts. System/Zipformer capability is conditional; inspect actual `context` / `load.context` status. Current Whisper adapter does not apply these hints. Use mixed for English speech/terms that must be recognized as English; RU Zipformer cannot gain English-language coverage from a dictionary. No LLM text cleanup is performed.

## Lifecycle, audio and events

`maxSegmentSeconds` bounds offline recognition windows (default12, range3..20 seconds). Shorter windows reduce buffering latency but may reduce context and increase inference frequency; they do not guarantee real-time speed. Streaming RU segmentation is unchanged.

`prepare()` optional; `start()` also prepares. `start({input:'pcm'})` permits externally captured normalized Float32 PCM via `await write(samples, rate)`. Use <=1 second packets, 8–96kHz, fixed rate per session; SDK splits into100ms packets and preserves caller buffers. Await write for bounded producer backpressure. If your capture adapter already has a bounded queue before that call, pass `write(samples, rate, {pendingPackets: queuedPackets})`, including the current packet. The optional hint must be an integer from 0 to 150; it suppresses speculative previews during backlog and never increases queue capacity or replaces producer backpressure. Direct PCM input is suitable for test files or your own capture adapter, not a Node/native ASR backend.

`state` notifications are queued as microtasks to prevent reentrant observers corrupting lifecycle operations. Other events include backend, context, progress, warning, recovered, partial, final, interrupted, error. Host listener exceptions are isolated. Call the unsubscribe function returned by on() when appropriate.

Stop flushes the microphone tail before local finalization. Dispose is terminal. Cancellation and generation guards suppress stale callbacks. Recovery retains up to30 seconds of uncommitted PCM; overflow is explicitly reported. `exportPendingAudio()` returns copies for host-controlled recovery/export, never automatic upload. Timestamps from system recognition are unreliable; recovered text can overlap earlier native results and carries a review flag. No guessed text deduplication deletes repeated words.

If all permitted fallbacks fail, the terminal error retains the last concrete backend failure. Runtime error events include the backend and available decode-stage/queue diagnostics. A missing alternative must not hide a timeout or corrupt-model error behind a generic resource-policy message.

Without a reference `quality.accuracy` stays null; flags are diagnostics, not confidence calibration. Caller-written text should not be replaced automatically. This SDK wraps the primary recognition/recovery path; experimental second-pass WebGPU refinement remains in the research application, not automatically enabled here.

## Cache and offline scope

Model files are SHA/size verified and cached. Manifest is cached under the configured asset URL, independently of a service worker. cacheOnly forbids new weight downloads. The host must separately cache the SDK, worker, WASM, worklet and shell for a completely offline installed application. Browser storage can be evicted. We do not claim a successful cache-only model repeat proves full app operation with networking disabled.

The public export includes deterministic adapter, policy and packaging tests. Recorded-audio fixtures and private benchmark evidence are excluded. Main release gates remain independent human recordings, real-time soak, physical phones and paired paid-ASR comparison. See ../docs/validation.md.


## Optional speaker embeddings and profiles

`tools/download-speaker-model.py` downloads the pinned, hash-verified WeSpeaker q8 weights. Install `@huggingface/transformers@3.8.1` and run `node tools/build-speaker-assets.cjs --transformers-dir=/path/to/@huggingface/transformers` **after** the ordinary SDK build. Serve the generated files under the same origin. See `SPEAKER_THIRD_PARTY_NOTICES.md` for licenses. This add-on is not loaded by ordinary ASR clients.

```html
<script src="/local-speech/speaker-identity.js"></script>
<script src="/local-speech/speaker-profiles.js"></script>
<script>
const speaker = LocalSpeechSpeakers.create({assetBaseURL:'/local-speech/'});
await speaker.prepare();
// Float32 normalized mono PCM, 8–96 kHz, 1–15 seconds; silence is rejected.
const embedding = await speaker.embed(samples, sampleRate);
// LocalSpeechVoiceProfiles.Session matches validated profiles and labels unknowns.
// The host owns enrollment, storage, UI, capture and segment timing.
await speaker.dispose();
</script>
```

The worker produces 256-dimensional normalized embeddings locally using WASM. A profile must use the exact `LocalSpeechSpeakers.modelId`; do not silently migrate embeddings across models. The pure `speaker-profiles.js` helper validates vectors, bounds audio rings and conservatively matches profiles/anonymous clusters. Similarity is not a calibrated probability and does not authenticate people.

The optional `speaker.segment(samples, sampleRate)` API lazily loads pinned pyannote segmentation weights and returns local speaker/overlap intervals. Load `speaker-diarization.js` to combine segmentation with clean-speech matching through `LocalSpeechDiarization.analyze`. Segmenter speaker slots are local to each window; saved profiles provide cross-session matching. The Mac example implements bounded background attribution, enrollment and private local persistence. Measured accuracy and release limitations are documented in `docs/diarization-validation.md` and `apps/mac/README.md`.

## Versions and updates

See [release and update instructions](../docs/releases.md). `LocalSpeech.version` and `diagnostics().version` report the built SDK version.

## Word confidence (unreleased)

Final events include `wordConfidence`: one entry per textual word. Scores are
uncalibrated model probabilities, not accuracy or language probabilities. A backend
without aligned word evidence returns null scores (including the current sherpa
Whisper build). `LocalSpeech.assessWords(text, evidence)` also validates externally
supplied aligned `{word, probability}` evidence. This adds no model or decode.
See [mixed-language confidence](../docs/mixed-language-confidence.md) for the
optional Mac experiment, which stores suggestions separately and is not enabled
by an SDK download.
