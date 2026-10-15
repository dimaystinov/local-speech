# Owner voice and contextual speaker names

Implemented in the macOS app, 2026-10-15. This is conservative speaker filtering, not secure voice authentication or a claim of production-level acoustic accuracy.

## First use

Press **Запомнить мой голос · 12 с** and speak alone into the microphone. The application creates **Мой голос** automatically; no file selection or manual profile name is needed. An unknown voice cannot establish who owns the computer, so this first recording must be initiated by the actual user. No owner profile has been enrolled during automated testing.

The bounded PCM recording stays in memory. Existing segmentation and clean-speech checks validate the sample; only the voice embedding and profile metadata are persisted locally. A successful replacement removes the former owner profile to avoid ambiguous duplicate identities. Cancellation or failed enrollment preserves the former profile.

## Commands and dictation

Owner filtering is on by default. Wake activation always requires the owner profile, even if ordinary dictation filtering is disabled. Missing enrollment blocks startup. Final ASR text is joined with asynchronous microphone diarization using session and segment IDs before it can reach rewriting, insertion, or the agent bridge. Partial text is withheld when filtering is active.

Only complete segments attributed to the owner are accepted, with at least two seconds of owner speech. Unknown speakers, another speaker, overlap, missing coverage, and timed-out analysis are rejected. Say “Роки” together with the command: the isolated wake word is too short for reliable identity verification. The bounded join queue expires after eight seconds; this is a deadline, not a guaranteed response latency. This conservative policy can reject legitimate speech in noise or interruptions. It cannot protect against recordings or convincing voice imitation.

Call transcription continues to show all participants. Anonymous speaker IDs cannot collide with saved profile IDs.

## Contextual names

An anonymous speaker's explicit “Меня зовут Анна” or “My name is Anna” can add **предположительно Анна** to that speaker's transcript label. This is a limited self-introduction heuristic, not general contextual understanding. Quoted speech, addressing someone else, overlap, and known profiles are not renamed. Conflicting names clear the suggestion. Suggestions stay within the channel and session, do not modify saved profiles, and never authorize commands.

## Validation and limits

- Swift suite: 122 tests executed, three opt-in tests skipped, zero failures.
- Node suite: 240 tests, 239 passed, one live opt-in test skipped, zero failures.
- Regression coverage includes unknown-owner startup, foreign and overlapping speech, asynchronous ordering, timeout, queue limits, cancellation-related sample validation, name conflicts, session isolation, and anonymous/saved ID collisions.
- The AMI replay on 2026-10-15 reused pinned neural inference results: **zero fresh inference calls**. Headset named coverage remained 20.68%, distant-microphone coverage 2.76%; wrong named single-speaker assignments were zero in that evaluated set. This does not establish a zero false-accept rate in deployment. No acoustic improvement or fresh latency measurement is claimed.

See [diarization-validation.md](diarization-validation.md) for acoustic benchmarks and the still-unmet production quality gate. Real owner recordings and representative calls remain necessary to measure false acceptance and rejection for this user.
