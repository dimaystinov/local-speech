# Changelog

## 0.3.0 — 2026-10-18

- Add opt-in local system TTS and custom/Tauri voice provider API with cancellation.
- Include a macOS native TTS adapter for WebViews without local Web Speech voices.
- Add a Tauri 2 / browser integration demo, versioned resource copying and integration guide.
- Export typed ESM speech and voice entry points; keep model downloads separate.
- Experimental GigaAM/Qwen review remains outside the default browser runtime.


Versions follow Semantic Versioning. Before 1.0, minor releases may change the API;
patch releases contain compatible fixes. Tags are immutable release snapshots.

## Unreleased

- Add an isolated GigaAM/Qwen cascade benchmark with development-only policy selection, conservative patches, paired regression checks and measured results.

- Expose nullable, uncalibrated word confidence metadata in the browser SDK.
- Add an optional local RU/EN confidence/recheck experiment and paired corpus scorer.
- Preserve primary transcripts; suggestions remain separate pending WER and latency gates.
- Prevent Russian-only native refinement from modifying mixed/auto sessions.

## 0.2.0 — 2026-10-15

- Add SDK versioned GitHub installation and runtime-only distribution with SHA-256 inventory.
- Add Mac dictation, owner voice gating, speaker context labels and Roki companion/voice bridge.
- Improve bounded recognition queues, speaker profiles and transcription handling.
- Add optional native Russian Whisper refinement, preserving original transcripts and rejecting unsafe changes. Experimental; not a guarantee of better accuracy on every recording.
- Add regression tests and document measured accuracy limitations.

## 0.1.0 — initial source distribution

- Local browser SDK, adaptive recognition policy, model integrity checks and Mac call transcription prototype.
