# Local recognition: noise, overlap and owner commands

Research and implementation review, 2026-10-15. No single model is established as best for this product without a paired Russian/English evaluation on the target device.

## What currently limits the app

The app recognizes audio before asynchronously identifying the speaker. The command gate therefore rejects an entire mixed/overlapping segment. Passing that transcript because the owner dominates the segment would also pass another person's words. Diarization labels alone cannot recover the owner's command from a mixture.

Known-voice coverage of the existing 474-case control set is low (42/207). Lowering the cosine threshold is not a safe fix. Enrollment uses a whole clean sample whereas long inference segments use an average of two embeddings; a whole-clean-window comparison is being evaluated independently, retaining temporal consistency and existing thresholds.

## Candidate mechanisms and release criteria

| Mechanism | Purpose | Integration and measurement |
| --- | --- | --- |
| Quality-aware speaker scoring and multiple clean enrollment conditions | Reduce microphone/noise mismatch without blindly lowering the threshold | WeSpeaker supports quality-aware score calibration. Fit on development speakers and evaluate unseen people/recordings; measure false accepts and false rejects separately. Do not learn a new owner from unverified live speech. |
| Target-speaker extraction / target-speaker ASR | Recover the owner's words during overlap | Requires a voice-conditioned model, not merely generic denoising. Retain original audio for independent verification; reject extraction leakage. Measure target-speaker WER and foreign-command acceptance under several overlap levels. |
| Echo cancellation and optional denoising | Suppress playback echo and non-speech noise | Compare original and processed audio. DeepFilterNet is a real-time noise-suppression candidate, not proof of speaker separation. Evaluate speaker-score degradation as well as WER; processing can alter identity features. |
| Decoder contextual biasing | Improve technical terms and wake words | Existing sherpa transducer integration uses hotwords with modified beam search. Keep the vocabulary small and relevant; test ordinary-word substitutions. Do not claim that the current Whisper path uses those hints. |
| Native accelerated ASR plus bounded second pass | Improve difficult final phrases without delaying all partials | Compare whisper.cpp on Metal/Core ML with Qwen3-ASR 0.6B/1.7B on an actually supported local runtime. Official Qwen supports RU/EN and streaming, but reported server throughput is not Mac latency. Measure model/RAM size, sustained real-time factor, mixed-language WER and term recall. |
| Separate action gate from transcript | Preserve useful transcription while declining uncertain commands | Never infer command authority from a contextual name, language-model rewrite, or the majority speaker. Overlap recovery needs new audio/transcription evidence before action. |

## Primary sources

- [WeSpeaker toolkit](https://github.com/wenet-e2e/wespeaker): quality-aware calibration and alternative speaker encoders, including uncertainty-aware scoring. These are research candidates, not installed replacements for the pinned q8 model.
- [Target-speaker ASR with noisy enrollment, 2025](https://arxiv.org/abs/2501.15466): context-aware target-speaker recognition under difficult enrollment conditions.
- [Lightweight target-speaker overlap transcription, 2025](https://arxiv.org/abs/2506.20288): a streaming extension for overlapping speech. A paper result is not a ready multilingual browser integration.
- [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet): local real-time noise suppression.
- [Sherpa hotword documentation](https://k2-fsa.github.io/sherpa/onnx/hotwords/): supported model/decoding combinations and contextual biasing.
- [Qwen3-ASR official repository](https://github.com/QwenLM/Qwen3-ASR): 0.6B/1.7B models, Russian and English, streaming/offline modes.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp): local runtime and Apple acceleration.

## Validation order

1. Freeze baseline, waveform hashes and held-out partitions. Separate fresh inference from cached replays.
2. Try one acoustic change at a time. Reject any variant that adds false known identities, mixed-speaker authorization or unacceptable latency.
3. Evaluate natural cross-meeting audio in addition to synthetic controls. Do not tune and claim success on the same test set.
4. Test owner enrollment and commands on this user's microphone; synthetic voices are not the user's voice. Test unknown nearby speakers, quiet/normal/noisy conditions and interruptions.
5. Run live two-channel ASR/diarization latency and long-session tests before enabling additional inference on the action path.

The first shipped improvement in this iteration is explicit rejection diagnostics (timeout, queue overflow, overlap, another speaker, uncertain identity, incomplete timing, short speech), including the voice-before-text ordering case. Deadline accounting uses monotonic uptime so wall-clock corrections cannot prematurely expire commands. These are reliability/diagnostic changes, not a claim of better acoustic accuracy.

## Completed pooling experiment

Baseline replay used pinned cached inference; the full-clean-window candidate performed 1,484 fresh embedding inferences on all 474 frozen waveforms. The half-consistency check and matching thresholds were unchanged. Aggregate known recognition stayed **42/207**. At 10 dB SNR it rose from 3/48 to 4/48, but at 20 dB fell from 14/48 to 13/48. Both variants gave no saved name to 207 unknown-voice cases, 27 overlap mixtures or 24 speaker-change cases. These finite controls do not establish a zero false-accept rate.

Decision: **do not ship the full-window replacement**. It adds inference without aggregate improvement. This comparison measures speaker identity, not ASR WER, and contains no recording of the user's own voice. Report artifacts are `validation/owner-baseline-20261015.json` and `validation/owner-full-pool-20261015.json`; the exact candidate helper is archived alongside them, with its SHA-256 verified against the report.

The application tests after the diagnostic change executed 123 Swift tests (three opt-in skips) and 240 Node tests (one opt-in skip), with zero failures.
