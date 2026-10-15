# Changelog

Versions follow Semantic Versioning. Before 1.0, minor releases may change the API;
patch releases contain compatible fixes. Tags are immutable release snapshots.

## 0.2.0 — 2026-10-15

- Add SDK versioned GitHub installation and runtime-only distribution with SHA-256 inventory.
- Add Mac dictation, owner voice gating, speaker context labels and Roki companion/voice bridge.
- Improve bounded recognition queues, speaker profiles and transcription handling.
- Add optional native Russian Whisper refinement, preserving original transcripts and rejecting unsafe changes. Experimental; not a guarantee of better accuracy on every recording.
- Add regression tests and document measured accuracy limitations.

## 0.1.0 — initial source distribution

- Local browser SDK, adaptive recognition policy, model integrity checks and Mac call transcription prototype.
