# Native call transcriber roadmap

## Current baseline

macOS26 application captures system/application audio and microphone into the existing LocalSpeech SDK. Mixed/English mode offers tiny/base selection and six-second offline windows. Russian streaming mode emits interim text while speaking. File/live smoke tests and deterministic suites are separate validation gates.

## Speaker identity (implemented; production gate remains open)

Implemented: optional local WeSpeaker embeddings, persistent named profiles, bounded background attribution and enrollment from files/recent phrases. App relaunch and same-voice/new-text matching were exercised in WKWebView. Unknown-voice rejection was exercised separately. This is a smoke test, not calibrated identity accuracy.

Implemented since the baseline: a 1.54 MB local turn/overlap segmenter, clean-speech pooling, temporal consistency checks, interval metadata, five-second bounded scheduling, a 474-case acoustic benchmark, and an AMI cross-meeting benchmark. See [measured results and release gates](diarization-validation.md).

Remaining: calibrated speaker recognition across microphones/codecs/languages, better overlap recall, independent held-out natural calls, and long-call performance measurement. The measured real-meeting recall is insufficient for a production identity claim. A causal ten-second context experiment improves coverage but also increases named overlapping speech; do not enable it without resolving that regression.

- A separate speaker embedding model, with verified model identity, local persistent profiles and explicit unknown rejection.
- Enrollment from a clean voice example; a human supplies the name. A voice does not reveal a person's real-world name by itself.
- Background speaker analysis must not block ASR audio delivery. Bounded queues and explicit skipped/uncertain attribution.
- Diarization separates time intervals; identification compares those intervals with enrolled profiles. A transcript spanning multiple voices must not be assigned wholly to a guessed person.
- No automatic learning from uncertain matches. No cloud audio upload. Profiles can be deleted locally.
- Validation: same-speaker/different-speaker examples, unknown voice, silence, short/overlapping speech, profile persistence, model incompatibility, worker failure, and ASR latency under concurrent load.
- Cross-language identity and long multi-speaker meetings require independent acoustic testing; no guaranteed-identification claim.

## Distribution

Use stable Developer ID signing and notarization for a distributable Mac build. Ad-hoc development rebuilds can invalidate prior macOS capture permission.

## Later: iPhone evaluation app

Present a reference reading passage, record live speech, transcribe using the same SDK/eligible local native adapter, and score normalized WER/CER and terminology errors. Keep raw and corrected text separate; test RU, EN and mixed terminology. Device testing remains deferred until requested.
