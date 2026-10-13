# LocalSpeech

Self-hostable browser speech recognition SDK. Audio is decoded on the user's device, with continuous microphone capture, partial/final events, conservative language/resource selection, cached model weights and bounded recovery. This is an integration candidate, not a guarantee of error-free transcription or certified mobile support.

## Quick start

Requires Python 3.10+ and Node.js 20+. No npm dependencies are needed for this SDK.

```sh
python3 tools/download-models.py
node tools/build-sdk.cjs --models=small,whisper_tiny,whisper
python3 -m http.server 8766 --bind 127.0.0.1
```

Open <http://127.0.0.1:8766/examples/embedded.html>. The default model preparation downloads about 293 MB from the recorded upstream URLs; existing verified files are reused. A minimal Russian-only package can be prepared with `python3 tools/download-models.py --models small` and built with `node tools/build-sdk.cjs --models=small`.

Deploy **only `dist/local-speech/`** to your application's HTTPS origin. The SDK fetches selected models on demand and verifies size/SHA-256 before using its browser cache. It does not upload audio, add cloud fallback, register a global service worker, or install system language packs automatically.

```js
const speech = LocalSpeech.create({
  assetBaseURL: new URL('/assets/speech/', location.href).href,
  language: 'mixed',
  terms: ['Docker', 'Kubernetes'],
  cacheOnly: false
});
speech.on('partial', ({ text }) => showPreview(text));
speech.on('final', ({ rawText }) => appendTranscript(rawText));
speech.on('error', ({ message }) => showError(message));
await speech.start(); // invoke from a user action
// await speech.stop(); await speech.dispose();
```

Load `/assets/speech/local-speech.js` first. The host supplies the UI functions. See [SDK API](sdk/README.md), [browser example](examples/embedded.html), [server bot architecture](docs/server-bot.md), and [validation limits](docs/validation.md).

## macOS call transcription

The [native Mac test application](apps/mac/README.md) captures call audio and microphone into this SDK and displays continuous text. It includes a local file test, channel labels, saved transcripts and speed/quality selection. Requires macOS 26+. Build with `bash apps/mac/build.sh` after downloading the models.

## Models and boundaries

- Fixed RU/EN: system recognition is preferred only after an explicit on-device availability probe.
- Mixed RU/EN: Whisper base on confirmed capable desktops, tiny on limited/unknown devices; no Russian-only fallback for English.
- Russian: streaming Zipformer INT8, about 29 MB of weights.
- Whisper tiny/base: about 104/161 MB of weights, windowed recognition. Partial text is not guaranteed at subsecond latency.
- Context hints are conditional for system/Zipformer adapters. The current Whisper adapter does not apply supplied terms.
- Other languages are not yet validated by the selection policy. Diarization and enrolled-speaker filtering are not implemented.
- Cache-only is a model-loading policy, not proof that the whole host application works offline. Browsers can evict storage.
- A final segment does not mean a conversational turn is complete. Preserve raw text, check names/numbers/negations, and handle uncertainty explicitly.

## Tests

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

CI runs deterministic tests without microphone access or model downloads. Device benchmarks and real acoustic testing remain separate requirements.

## Distribution and licensing

This repository contains the generic SDK, runtime, example and deterministic tests. No user recordings, transcripts, private project documents, credentials, model weights or prior Git history are included. Weights are downloaded separately and checked against `evidence/model-manifest.json`.

Third-party components keep their licenses; see [notices](sdk/THIRD_PARTY_NOTICES.md). No open-source license has been assigned to original application code in this publication. Public visibility alone does not grant an unrestricted redistribution license.
