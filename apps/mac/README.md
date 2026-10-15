# LocalSpeech Calls — macOS integration test app

Native continuous call transcription, using **this repository's actual LocalSpeech SDK**. ScreenCaptureKit captures audio; a bundled WKWebView runs the same JavaScript SDK, WASM runtime and verified model weights as the browser product. Apple Speech, remote ASR and LLM cleanup are not substituted.

## Build and run

Requires macOS 26+, Apple Silicon, Xcode Command Line Tools with the macOS 26 SDK, Node.js 20+, and downloaded model assets. From the repository root:

```sh
python3 tools/download-models.py
python3 tools/download-speaker-model.py
npm install --prefix .speaker-deps --no-package-lock @huggingface/transformers@3.8.1
bash apps/mac/build.sh --transformers-dir="$PWD/.speaker-deps/node_modules/@huggingface/transformers"
swift test --package-path apps/mac
```

Open `apps/mac/dist/LocalSpeech Calls.app` in Finder. This development build is locally ad-hoc signed; it is not a notarized distribution release. Keep a stable app path when granting macOS permissions. Rebuilding an ad-hoc-signed binary changes its code identity: macOS may retain an enabled permission for the previous hash but reject the new build. Remove only LocalSpeech Calls from Screen & System Audio Recording, add the current app file again, and relaunch. A release needs a stable Developer ID signature and notarization; this build does not weaken code-signing requirements.

1. Choose **Весь звук Mac**, or refresh the application list and select the calling app/browser.
2. Enable **Мой микрофон** to include yourself. Headphones avoid feeding the other side's voice into both channels.
3. Choose language and priority. Press **Начать созвон** once; phrases are transcribed continuously, including across pauses. Stop flushes the final buffered phrase.
4. Copy or export TXT. Final text is automatically saved locally and the latest transcript is restored at launch.

ScreenCaptureKit needs macOS screen/system-audio permission; microphone capture also needs microphone permission. No screen images are registered, read or saved. A denied permission is reported explicitly. **Проверить файл** sends a selected local WAV/MP3/M4A through the same SDK and context configuration without microphone/system-audio permission. It runs with producer backpressure, so it is not a substitute for a real-time capture soak test.

## Speed, language and resources

- **Скорость** is the default: multilingual Whisper tiny for mixed RU/EN and English; streaming Russian Zipformer INT8 for RU.
- **Точность · медленнее** permits Whisper base only when per-channel RAM/CPU hints meet SDK thresholds; otherwise tiny. The priority is a model-selection preference, not a guarantee of better accuracy on every phrase.
- Resource hints come from the native host, with 2 GB reserved for the OS and remaining RAM/cores divided between active channels. Browser clients still use browser-reported hints.
- Offline model windows are capped at 6 seconds, or finalized earlier by a pause. Actual text latency includes inference and any queued audio. Shorter windows trade context for latency and can cut a word at a boundary.
- The UI reports measured finalization time and segment duration; those are not an accuracy score or full end-to-end latency.
- RU Zipformer does not become a multilingual model through hotwords. The current Whisper adapter does not apply context terms.
- SDK fallback remains local and bounded. The native bridge buffers at most 150 × 100 ms packets per channel. A sustained overload stops explicitly; it must not silently drop audio or grow memory indefinitely.

The labels **Я** and **Собеседники** indicate microphone and captured-app channels. All remote participants share one channel. System audio from unrelated applications is included when capturing the whole Mac.

## Local voice profiles

Enable **Определять собеседников**. Enter a name and choose **Добавить голос из файла** with 4–15 seconds of clean speech from one person. Alternatively, after stopping a call, use **Запомнить голос из этой реплики** on a recent suitable phrase. Up to eight recent excerpts remain in memory for enrollment. Restarting clears those excerpts, but saved profiles persist. Use the trash button next to a profile to remove it.

A separate optional WeSpeaker ResNet34 q8 worker compares normalized voice embeddings against saved profiles. Model weights are 6.7 MB; the complete optional runtime/assets add about 30.8 MB, including the 1.54 MB pyannote segmentation model. Pinned revision, hashes and attribution are in `sdk/speaker-assets-manifest.json` and `sdk/SPEAKER_THIRD_PARTY_NOTICES.md`. Models are bundled once; audio stays local. Profiles store a name and embedding in `~/Library/Application Support/LocalSpeech Calls/voices.json` with private file permissions. They do not store the recording.

The name is supplied by you. Unknown voices receive session labels such as **Голос 1**; ambiguous or missing evidence stays **Голос не определён**. A match is not a verified real-world identity or an authentication mechanism. Thresholds have not been calibrated on a representative call corpus.

Speaker work runs in a separate worker after text becomes available. Pyannote segmentation marks local voice turns, silence and two-voice overlap; WeSpeaker compares only clean single-speaker audio. For at least four seconds of clean evidence, two disjoint embeddings must agree before their normalized mean can receive a name. Short or inconsistent speech remains uncertain. The UI and TXT export expose timed voice intervals, but words are not aligned to individual speakers and overlapping voices are not separated into independent transcripts.

ASR has scheduling priority. At most four speaker jobs wait; each label has a five-second deadline from arrival, including queue time. A slow queue skips the label. A stuck speaker model is terminated and disables voice analysis until the next call, with explicit unknown labels; text continues. Recent enrollment audio is bounded to eight excerpts in RAM and is never written to disk.

Voice registration reports progress and stops after 90 seconds if processing stalls. Cancellation terminates that registration's worker, rejects late results and allows a clean retry. The host keeps the hidden SDK view running during active work, then restores normal idle scheduling.

This is an **experimental diarization feature**, not validated production speaker identification. Tests found low recall on real meetings, especially distant microphones and interruptions. See [the measured release gates](../../docs/diarization-validation.md). Larger past-audio context improved coverage in an experiment but increased names during overlap, so it was not enabled.

## Local storage and packaging

The app embeds SDK assets and selected weights once. A loopback-only static server serves the bundle at an ephemeral port. No external network access is required for model loading after build. WKWebView uses a nonpersistent store to avoid duplicate disk caches for changing loopback origins; the durable model copy is the app bundle. Size/SHA-256 validation is retained.

Transcripts live under `~/Library/Application Support/LocalSpeech Calls/Sessions/` as atomic JSON files, with private directory/file permissions. Raw captured audio is not written to disk. Starting a new call preserves previous JSON files, although the current UI restores only the latest session. Renaming is saved on finalization/quit. Transcript content is never included in this repository.

## Validation boundary

Deterministic tests cover bridge isolation, queue bounds, malformed PCM, cancellation, stop/final flushing, loopback HTTP containment, archive roundtrips, transcript ordering and audio packetization. Actual model runs, end-to-end capture, permission handling and long-call performance must be tested separately on target hardware.

This is a working integration test application, not a claim of error-free transcription, ChatGPT accuracy parity, validated individual-speaker identity, or certification across Zoom/Telegram/Meet versions. iPhone testing remains a separate planned deliverable.

## Optional native Russian refinement

A build can bundle a pinned sherpa-onnx C runtime and Whisper small INT8 as a second pass. Build with `LOCALSPEECH_SHERPA_DIR` pointing to the sherpa-onnx 1.13.8 wheel package directory and `LOCALSPEECH_MODELS_ROOT` pointing to verified model folders. `tools/build-native-refiner.py` checks runtime/header and model SHA256 before compilation. No Python runtime or network service is required by the installed application.

The primary SDK still produces text and owns capture segmentation. On Macs with at least 12 GiB RAM, sufficiently long Russian-only Whisper base results may be refined after the primary PCM queue drains. English/mixed-script text, changed explicit digits/negations, language drift and large deletions are excluded. One utility-priority helper runs at a time; overload, missing assets, failed decoding or the five-second deadline keep the original. No unbounded refinement queue is created. This is a limited quality route, not a guarantee of no errors on unseen speech.

The host retains at most 30 seconds of Float32 PCM per channel in RAM for slicing the exact SDK segment, and clears it at stop/new session. Refinement passes PCM through stdin, never a temporary audio file. The archive retains `originalText` when text changes. Detected overlap restores the original; contextual speaker-name suggestions use the original. This path does not modify dictation or voice-command verification/execution.
