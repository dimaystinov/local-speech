# Validation scope

The exported source is retested after generic naming changes. Included tests exercise lifecycle cancellation, late/stale events, microphone cleanup, bounded recovery, language/resource policy, manifest integrity and package isolation. The GitHub CI repeats those deterministic tests without downloading weights.

Before publication, the selected real model files are independently size/SHA-checked and the package builder is run. The source project previously exercised real packaged RU/EN/mixed inference, cache repeats and injected-failure recovery on desktop Chromium. Private evidence and recordings are deliberately not published here; those historical runs are not a public reproducible accuracy claim for this exported snapshot.

Remaining release gates include independent human mixed-language terminology data, clean acoustic testing, long real-time sessions, physical iPhone/Android verification, host HTTPS/CSP integration and a paired paid-ASR baseline. Diarization and target-speaker filtering are planned capabilities, not implemented features.

Publication check (2026-10-09): 109/109 Node tests and 5/5 Python tests passed. The sanitized WASM passed WebAssembly validation. Six real browser cases (RU, EN, mixed; normal and cache-only) completed on the exported package, with identical transcripts on cache repeats. These are integration checks, not zero-WER accuracy claims. Audio fixtures and transcript reports remain excluded from this repository.
