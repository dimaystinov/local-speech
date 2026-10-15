# Roki desktop companion

Roki keeps the approved Roki-2 mechanical body, graphite skirt, cable braids and optical eye. The 908 × 1732 transparent portrait in `apps/mac/Assets/roki-assistant.png` is bundled (about 2 MB), with no runtime image download. It was generated using the built-in image tool from the user's robot reference. The prompt retained the original skeleton, camera head, red lips, readable chest plate and broad shoes, and added two cable braids and a modest pleated skirt on a transparent background.

## Animation and attention

`RokiStage` uses a local SpriteKit 22 × 38 deformation grid. The feet remain planted while the head, torso and arms move. Separate weights move the skirt hem and braids; damped springs let the braids lag head motion. This is an animated **2D skin rig**, not a 3D model or a cloth collision simulation. Prepared gestures: greeting, nod and shrug; expressions: calm, attentive, thinking, happy and concerned. A pale alpha-contour follows the deformed silhouette to keep it readable on dark backgrounds. Procedural face textures preserve the red smile, animate the jaw, blink and direct the optical eye.

Context comes from actual application states, conservative assistant-reply text hints, or an explicit emotion supplied with a reply. It does not infer the user's emotions or understand an arbitrary conversation. The inspector exposes manual expression/gesture previews and light/dark backgrounds.

By the user's choice, attention means **cursor position only**. Every 4.5–8 seconds Roki samples `NSEvent.mouseLocation`, glances for 1.3–2.4 seconds and returns forward. No screen capture, OCR, accessibility read or event tap is involved. The user can disable this. Reduce Motion disables decorative movement and cursor following; sound-driven mouth motion remains functional. Hidden views release their SpriteKit scenes; visible scenes are capped at 30 fps.

## Voice and mouth synchronization

`RokiVoice.speak(text, emotion:, purpose:)` is the local response adapter. **eSpeak NG · женский f1** uses the installed eSpeak NG executable, with `en+f1` for English and `ru+f1` when the text contains Cyrillic. The previous male `m1` voice remains selectable. The variant is shared across languages; pronunciation follows the selected language. This simple language choice does not perform per-word code switching. The adapter sends plain text over stdin, receives WAV over stdout, and never invokes a shell. It accepts only the four ru/en × f1/m1 voice identifiers. eSpeak is detected at `/opt/homebrew/bin/espeak-ng` or `/usr/local/bin/espeak-ng`; it is an optional local dependency and is not bundled in the app. Missing eSpeak gives an explicit error and the user can select a system style. New preferences use configured Qwen first, then installed eSpeak; existing selections are preserved.

Other styles use an installed system AVSpeechSynthesisVoice, preferring a female voice for the text's language. No voice download or remote TTS service is used. On the development Mac the available Russian voice was Milena. **Roki · robot** lowers pitch and applies a modest 62 Hz modulation and 9 ms delay locally. Soft and unprocessed system styles are also selectable and persisted. These styles process a system voice; eSpeak uses its own synthesizer.

Speech uses bounded mono PCM (600 input characters, maximum 60 seconds, 20-second synthesis deadline for system/eSpeak or 90 seconds for Qwen). System/eSpeak buffer a clip and use AVAudioPlayer; Qwen streams chunks into one AVAudioPlayerNode while generation continues. Mouth opening reads a 20 ms RMS envelope from the **processed PCM at the player's playback time**. Silence, pause, stop and completion close the mouth. This is amplitude-based animation, not phoneme-perfect lip reading. Stale synthesis/player callbacks cannot restart a cancelled response. Audio is kept in memory and never saved by the voice component.

Speech and capture are mutually excluded to avoid recognizing Roki's own voice. Calls/dictation must finish before voice playback; queued schedule reminders wait while capture or another utterance is active. Text supplied to the voice adapter is spoken as data, never executed.

## Saved Qwen voice

The selected voice is **Роки · Qwen · собранная**, profile ID `roki-composed-01b`. `apps/mac/Assets/RokiVoice/profile.json` preserves its VoiceDesign prompt, seed, source model revision, reference transcript, SHA-256 and inference settings. `reference.wav` is the exact user-approved synthetic 01b audition (gain-normalized PCM16). The app bundles both and `synthesize.py`. This is an original designed voice, not a recording of a person.

New phrases use `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit` at revision `e7dd0585652209fa0d7783659aad4e8a324de11c`, conditioned on the selected reference and its transcript. This anchors identity more directly than designing a new speaker on every call; generated phrasing and intonation can still vary. Temperature is 0.8, seed 41. No pitch shift or metallic effect is applied. Only gain is adjusted with safe peak headroom. Reference SHA-256 is checked before loading the model.

Current Mac setup: a dedicated Python 3.11 environment with mlx-audio 0.5.9, local HF model cache, and `~/Library/Application Support/LocalSpeech/RokiVoice/runtime.json` containing absolute `python` and pinned snapshot `model` paths. These machine-specific paths are not bundled or committed. To reproduce on another Mac, install the runtime and cache the pinned Base model, then create that settings file with those two keys. The existing audition runtime lock lists the packages used on the development Mac. The model and Python environment are optional external dependencies; the application alone is not a portable Qwen distribution.

Qwen now uses a resident background Python process with isolated imports and bounded JSON lines on stdin/stdout. Enabling voice MCP prewarms weights, reference conditioning and decoder kernels. Libraries run in HF/Transformers offline mode with telemetry disabled; text and generated audio are never uploaded. PCM16 chunks of approximately 0.64 seconds arrive incrementally. Fixed gain and bounded clipping avoid chunk-wise loudness pumping. The model remains resident for subsequent utterances; disabling voice MCP or quitting releases it. Cancelling inference invalidates callbacks, terminates the worker and starts a fresh warmup. `RokiQwenJob` and `synthesize.py` retain the original buffered worker for tests, but normal Qwen playback uses `RokiQwenStream` and `stream.py`. Failure is explicit: the app does not silently replace the chosen voice with another one. See [MCP streaming behavior and measured latency](roki-voice-mcp.md).

Validation: full Swift suite passed with 101 tests, 3 opt-in skips, zero failures. An additional actual Qwen synthesis/playback test passed with `LOCALSPEECH_TEST_SYSTEM_VOICE=1 LOCALSPEECH_TEST_QWEN_VOICE=1 swift test --package-path apps/mac --filter RokiVoiceIntegrationTests`, including nonzero mouth envelope during sound, closed mouth and frozen audio clock on pause, resume, completion and cancelled-response protection.

## Schedule

See [schedule behavior and privacy](roki-schedule.md). Roki has a caring, composed presentation: reminders, acknowledgement and a ten-minute snooze, without claiming to police the user's behavior. Calendar integration is opt-in and only reads event titles/times. Personal tasks are local. **The app must remain running for reminders.** No background daemon or OS notifications are installed.

The nonactivating floating panel cannot become the key/main window. Appearance does not enable the microphone. Close hides the companion; the sidebar toggle restores it. Active reminders can show the companion again. The existing ASR-based wake phrase and field insertion retain their documented limitations; this character work is not a production certification of speech recognition.

## References

Validation on the development Mac (2026-10-13): 96 Swift tests, 95 passed and one unrelated opt-in local-rewriter test skipped. Enabled actual eSpeak synthesis for all four language/variant combinations and audible female-voice playback with mouth envelope, pause/resume, completion and cancellation checks. Command: `ROKI_ESPEAK_TEST=1 LOCALSPEECH_TEST_SYSTEM_VOICE=1 LOCALSPEECH_TEST_ESPEAK_VOICE=1 swift test --package-path apps/mac`. This validates this installed engine and audio path, not voice preferences on every Mac.

- [Apple speech synthesis](https://developer.apple.com/documentation/avfaudio/speech-synthesis)
- [eSpeak NG voice variants](https://github.com/espeak-ng/espeak-ng/blob/master/docs/voices.md)
- [SpriteKit warp grid](https://developer.apple.com/documentation/spritekit/skwarpgeometrygrid)
