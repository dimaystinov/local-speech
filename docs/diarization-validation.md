# Local diarization validation — 2026-10-13

## Release decision

**Experimental; the production diarization accuracy gate is not passed.** The implementation is local, bounded and integrated into the real SDK/Mac app. It is not an error-free speaker identifier. In particular, unknown output is common on distant microphones and short utterances, and overlap detection still misses most overlapping speech in a natural meeting.

The feature uses a separate optional worker: pyannote segmentation q8 (1.54 MB weights) and WeSpeaker q8 (6.7 MB weights). The complete add-on including runtime is about 30.8 MB. Model revisions, hashes and licenses are pinned in the speaker asset manifest. Audio is never sent to a recognition service. Persisted profiles contain the user-supplied name and embedding, not the source recording.

## Acoustic tests

The synthetic/human control suite contains 474 waveform cases: six macOS voices, separate enrollment and reading passages, unknown voices, 1/2/4/6-second speech, noise at 20/10/0 dB SNR, changing speakers, overlaps, silence, clipping, echo and telephone-band audio. It includes 24 natural FLEURS recordings with disjoint enrollment/evaluation halves. FLEURS halves have no cross-call identity guarantee; they are acoustic controls only.

The final policy was rerun against all 474 frozen waveforms with a fresh cache: 1,389 actual embedding and 381 segmentation inferences, using native CPU ONNX Runtime. Its helper hash matches the shipped source.

Final policy: strict clean single-speaker frames, at least two seconds of clean speech, RMS >= .0005, less than 1% clipped samples, known cosine >= .75 and runner-up margin >= .08. Four seconds or more use disjoint half embeddings with cosine >= .55; the mean of normalized halves is classified. Overlap can be marked at .5 segmentation confidence, but identity pooling still requires .6. These thresholds are pilot settings, not calibrated probabilities.

| Control | Observed result |
| --- | ---: |
| Known cases correctly named | 42 / 207 |
| Known cases given another saved name | 0 / 207 |
| Unknown cases given a saved name | 0 / 207 |
| Overlap mixtures given one saved name | 0 / 27 |
| Speaker-change cases given one saved name | 0 / 24 |
| Nonspeech cases given a saved name | 0 / 9 |
| Overlap mixtures detected | 26 / 27 |
| False overlap on single-voice cases | 2 / 288 |

Zero observed errors in these controls is not a zero-error-rate claim. Coverage drops with short speech, noise and channel changes. Baseline whole/four-second embeddings named three overlap mixtures incorrectly; the new conservative policy avoids these cases at a substantial cost to coverage.

## Natural cross-meeting test

Four people were enrolled from the first 120 seconds of AMI IS1009a, using reference annotations to select candidates and the actual enrollment gate to accept them. Evaluation uses the first 300 seconds of a different meeting, IS1009b. Headset mix and distant room microphone are paired recordings of the same conversation, not independent meetings.

| Metric | Headset mix | Distant microphone |
| --- | ---: | ---: |
| Correct saved-name coverage of single-speaker speech | 20.68% | 2.76% |
| Wrong person named during single-speaker speech | 0 seconds | 0 seconds |
| Overlap recall | 22.55% | 30.94% |
| Overlap precision | 73.14% | 60.55% |

Withholding the dominant participant's profile produced no false saved name over 191.23 seconds of that person's single-speaker speech. Two of the four participants speak for less than a second in this excerpt; this is weak evidence about their recognition. Evaluation is English only, uses 10 ms frame midpoints and zero collar, and uses word-only reference boundaries. AMI is related to the segmentation model's training corpus. No standard DER or multilingual production accuracy is claimed.

[AMI corpus](https://groups.inf.ed.ac.uk/ami/corpus/) provides the CC-BY 4.0 audio. Reference annotations come from the [pinned AMI diarization setup](https://github.com/pyannote/AMI-diarization-setup/tree/67c2d539286e89f68952d5dcf83912bd9f01dfae). The runner pins audio prefixes and annotation hashes. Audio, raw profiles, transcripts and detailed outputs remain in ignored validation directories.

A causal 10-second-context experiment improved named coverage to 42.29% / 13.22%, but increased named true overlap to .84 / .27 seconds. It is **not enabled in the app**. Gain normalization also failed to improve the overall tradeoff. These exploratory results must not be presented as independent validation.

## Real-time scheduling

ASR writes and acknowledgements never await voice identification. Speaker work yields between model calls when ASR is busy; there is no artificial cooldown between completed voice jobs. The queue holds at most four jobs. A five-second deadline begins at enqueue, so queued results cannot accumulate indefinitely. Expired results are explicitly unknown. A stuck speaker worker is terminated independently of ASR; later phrases retain text and receive unknown labels. Stop drains bounded work and clears capture buffers.

The initial two-channel browser ABBA run exposed an artificial-delay regression: speaker p95 exceeded 12 seconds. That run did not pass the diarization latency requirement, even though ASR was unaffected. The regression led to removal of cooldown and the redundant third embedding inference. The paired benchmark records each arm separately; concurrent user applications can change available CPU and must be reported alongside any latency claim.

### Paired browser result

Four 60-second arms (ABBA), two independently fed audio channels, actual multilingual Whisper tiny and WASM speaker models. Each arm produced 20 final phrases, no dropped packets and no ASR failures. Both diarization arms returned all 20 voice results, with no timeout/status errors.

| Measurement | Result |
| --- | ---: |
| ASR processing p95, pooled A | 2,754.54 ms |
| ASR processing p95, pooled B | 3,185.71 ms |
| Observed ASR p95 overhead | **15.65%** |
| Voice label after text, pooled B p95 | **2,872.16 ms** |
| Acceptance | **Failed: overhead exceeds 15% limit** |

The voice deadline/queue requirement passed; the total latency gate did not. A separate browser process was observed consuming over five CPU cores during this run. This uncontrolled concurrent load limits causal attribution, but is not a reason to turn a failing measurement into a pass. An earlier run had voice p95 above 12 seconds; the artificial queue delay is removed in the final implementation. Browser measurements are not WKWebView or physical-device guarantees.

### Additional 48 kHz stress smoke test

A separate 60-second B-only run used two 48 kHz PCM channels and the 39.6-second four-voice synthetic fixture repeated 1.52 times. All 1,200 submitted packets were acknowledged: no rejected/lost packets, no warnings, no failures and no missing speaker results. The run produced 20 final phrases. ASR processing p95 was 1,707.64 ms; speaker-after-text p95 was 1,630.27 ms. The labels were six anonymous, ten uncertain and four overlap. Without an A arm this is not an overhead comparison and does not replace the failed ABBA gate above. Processing time excludes the audio window accumulation.

An initial attempt at this additional test was discarded: the harness resampled to 48 kHz but still declared 16 kHz to the bridge. The corrected harness propagates the selected rate into both packetization and bridge calls, records it in the report, and has a transport regression test for both rates. The discarded attempt is not included in any metrics above.

## Reproduce

Install the exact runtime and prepare verified assets as described in the Mac README. The fixture generator additionally requires NumPy, SciPy and the listed installed macOS voices. Optional FLEURS inputs must be provided separately; synthetic fixtures alone do not reproduce the combined 474-case total. Then:

```sh
python3 tools/benchmark-diarization-fixtures.py --out validation/diarization-fixtures
node tools/benchmark-diarization.mjs --fixtures=validation/diarization-fixtures --enrollment=clean --transformers-dir=.speaker-deps/node_modules/@huggingface/transformers
node tools/benchmark-meeting-diarization.mjs --transformers-dir=.speaker-deps/node_modules/@huggingface/transformers
python3 tools/serve-diarization-benchmark.py --audio=/absolute/path/to/fixture.wav
```

Open the printed loopback URL and run two-channel ABBA, 60 seconds per arm. Packets are produced every 100 ms without awaiting the previous acknowledgement. This uses the actual Mac bridge, SDK and WASM models; it does not use mocked recognition. The test checks ASR p95 overhead <=15%, speaker p95 <=5 seconds, no speaker timeout/status failure, no missing labels, no audio loss and matching ASR backends. It does not test microphone capture, hour-long calls, speaker accuracy or WER.

Model inference caches are fingerprinted by assets/runtime. Cached policy replays reuse actual neural outputs but are not fresh latency measurements. Natural-meeting exploratory variants require the exact preserved baseline helper; the default current-policy runner does not.

## Native background execution

An actual WKWebView enrollment check exposed process suspension while the hidden SDK view was occluded. The host now keeps WebKit scheduling active during boot, calls, final draining and enrollment, and restores suspension when idle. This uses the public [WKPreferences.inactiveSchedulingPolicy API](https://developer.apple.com/documentation/webkit/wkpreferences/inactiveschedulingpolicy-swift.property), rather than private WebKit preferences. Enrollment reports its current stage and has a 90-second deadline. Addressed cancellation terminates its worker and suppresses late profiles; a retry obtains a fresh worker. The native host allows 105 seconds and bounds cancellation dispatch to five more seconds.

## Final native smoke test and automated checks

The release-mode app was rebuilt with verified assets and its ad-hoc signature passed `codesign --verify --deep --strict`. All 212 Node tests, 19 Swift tests and five Python tests passed. They cover implementation behavior, not statistical recognition accuracy. The follow-up SDK regression tests preserve original backend/decode errors when no eligible fallback remains, including failures during replay.

In the actual native UI, Daniel and Samantha synthetic profiles were registered successfully; Milena, Daniel and Samantha persisted across app restarts. A 39.6-second four-voice WAV containing unknown Karen, noisy Milena and Daniel/Milena overlap completed through the actual bundled SDK. The UI showed Milena on clean speech, Daniel at 7.1–11.8 seconds and Samantha at 13.2–18.0 seconds inside the interval details, an anonymous voice for the unknown participant, and overlap labels on the final mixed windows. Boundary uncertainty remained visible. The tiny ASR transcript contained terminology and ordinary-word errors; this is integration evidence, not an accuracy pass. File replay uses backpressure and cannot establish live-capture latency.

The subsequent whole-system live attempt stopped with a generic exhausted-fallback error. Its original failure was hidden, and unrelated audio was present in that channel. This remains an unresolved failure, not evidence of a specific root cause. The SDK now preserves the originating backend error and available processing/queue diagnostics.

A controlled live retest selected **QuickTime Player only**, disabled microphone capture, and played the same 39.6-second synthetic recording through ScreenCaptureKit at 48 kHz into the actual SDK. It completed and stopped normally, with text, a clean Milena label and overlap labels. Observed individual final-decode times were about 1.4–1.8 seconds; these observations are not a p95 or end-to-end latency claim. This successful single-channel smoke test does not erase the earlier failure or establish stability for long/two-channel calls. The harness now offers both 16 and 48 kHz inputs for subsequent paired tests.

## Remaining production gates

- Independently annotated Russian/English real calls with balanced participant speaking time; clean, noisy, distant, compressed and overlapping conditions.
- Better recognition coverage and overlap recall without transferring a previous speaker's name to an interruption. Use held-out data for acceptance, not the tuning excerpts.
- Multiple clean enrollment samples across microphones, with explicit enrollment quality and profile update rules.
- Word alignment or separate overlap transcription before claiming each person's exact words.
- Hour-long two-channel capture tests covering sleep/wake, permission denial, device changes, memory bounds and overload.
- Stable Developer ID signing and notarization for Mac distribution; physical iPhone/Android/browser checks remain separate gates.

Until these pass, use the continuous transcript as the primary output and treat speaker names as optional, editable suggestions.


## Follow-up model experiments

Additional enrollment variants did not justify a production change. Multiple clean same-person samples increased headset coverage from 20.68% to 22.72%; pooling up to 15 seconds of oracle-grouped clean speech reached 24.87%. Distant-microphone coverage stayed 2.76%. These are exploratory uses of the same evaluation excerpt, not held-out improvements.

An actual alternative embedding A/B used official WeSpeaker ECAPA512-LM, 24,861,931 bytes, CC-BY-4.0, revision `a2f3dcb1c8702caccc7a55ceb57f5e8d1842112b`, SHA-256 `d71b85d9b48058ef68004f04f1b78acebefb9dfcf542e19b976a12a5ad1f10b0`. Its 161 native single-thread inferences had median 37.9 ms and p95 50.8 ms; these are not browser timings. The new embedding space requires separate calibration. At exploratory cosine .65, coverage was 68.85% / 27.71%, but named true overlap increased to 3.51 seconds on the headset recording. Requiring both query halves to identify the same person reduced coverage to 26.01% / 1.23%, with .01 / 0 seconds of named overlap. Lower thresholds already produced wrong identities. **The candidate is not shipped:** there is no demonstrated safe improvement for noisy and overlapping speech together.


## Backpressure correction and repeat ABBA

The native bridge serialized PCM writes, so the worker saw one in-flight packet even when the upstream native queue contained many packets. The SDK now accepts a validated optional `pendingPackets` hint and propagates it into the existing interim-decoding pressure control, including fallback replay. Stopping also bounds queue draining to eight seconds and flushes independent channels concurrently; an unprocessed tail produces an explicit failure rather than an indefinite wait.

A new four-arm, two-channel, 16 kHz ABBA run of the same fixture completed after these changes: 80 final phrases, 4,800/4,800 acknowledged packets, no loss/rejection/failure. Pooled ASR processing p95 was 1,784.74 ms without diarization and 1,825.48 ms with it (+2.28%); speaker-after-text p95 was 1,417.40 ms. This run passed the predefined 15% overhead/5-second speaker gates. One Swift build and uncontrolled background applications overlapped the broader experiment, so the measurements do not isolate the causal contribution of the code change or establish production/device guarantees. The earlier failing run remains in this report. Recognition accuracy gates and hour-long system-capture validation remain open.

A microphone-only native dictation smoke test during the same work exposed a bounded stop failure: its audio tail did not drain within eight seconds, so unfinished audio was explicitly cancelled. This was not a successful lossless native stop; competing playback/inference was present. The bridge timeout now includes per-channel pending-packet count and client state for the next reproduction. Browser ABBA success must not be used to hide this remaining native/load issue.
