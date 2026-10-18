# SDK 0.3.0 integration validation — 2026-10-18

- JS: 248 cases, 247 passed, one skipped. Includes independent ESM import,
  local-only voice selection, completion, cancellation, timeout and provider IPC.
- Python: 78 passed.
- Existing macOS app: 132 cases, three skipped, zero failures.
- Tauri 2 macOS Rust check and debug .app build passed with Rust 1.93.1.
- Packaged app launched at tauri://localhost and loaded SDK 0.3.0.
- Native macOS TTS: UI reported playback completion; a second long utterance was
  cancelled and the controls returned to their idle state. Web Speech local voices
  were unavailable in this WebView, so a native /usr/bin/say adapter was added.
- npm runtime archive approximately 4.4 MB, no model weights, recordings or build
  outputs from the demo. Installed archive's ASR/voice package exports imported.
- The demo .app includes models and is approximately 196 MiB in this debug build;
  it is not notarized and is not shipped as a signed desktop installer.

This does not validate a live call, packaged microphone permissions on other Macs,
Windows/Linux, phones, streaming WER, or Qwen TTS integration. Qwen remains a host
provider; browser ASR does not include the experimental GigaAM/Qwen cascade.
