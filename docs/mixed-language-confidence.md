# RU/EN word confidence and targeted review

The SDK exposes `LocalSpeech.assessWords(text, evidence)` and `final.wordConfidence`.
`probability` is an uncalibrated backend word score, not accuracy and not a language
probability. Missing/nonfinite/out-of-range/misaligned evidence stays null. The
existing sherpa Whisper build does not return word probabilities. This limitation
is explicit instead of synthesizing confidence from word frequency or script.

The optional Mac adapter `tools/word-confidence.py` uses local faster-whisper
1.2.1 / CTranslate2 with word timestamps and scores. It never downloads at inference.
It first aligns its hypotheses to the original SDK transcript; mismatched words
remain unknown. A second decode (beam 3, term prompt) only runs if a low-scored
word exists and the first decode fits its budget. One model instance is used.
Only up to two substitutions to explicitly supplied Latin-script terms qualify;
low original score (<0.5), new score >=0.85 and a margin >=0.35 are required.
Digits and negations are protected; insertions/deletions and unknown evidence
cannot trigger replacement. These experimental thresholds are not calibrated.

In the app, review is separate from primary recognition: mixed/auto only, terms
required, <=12 seconds, 8–96 kHz PCM (resampled locally), >=12 GiB RAM, at most one background process,
no job queue, skip if primary SDK has backlog, kill at 6 seconds. Failure preserves
all original text. Native Russian-only refinement is bypassed in mixed/auto mode.
Results are stored in the local transcript archive as `wordReview`, with original
scores and suggested text. **Suggestions do not automatically replace text** until
independent WER/latency regression gates establish a benefit. There is no new UI
setting and no default download. This is an optional Mac experiment, not an iOS
or browser Python dependency.

To reproduce, install faster-whisper==1.2.1 in a dedicated Python environment and
download a pinned Systran model. Configure local paths in
`~/Library/Application Support/LocalSpeech Calls/WordConfidence/runtime.json`:
`{"python":"/absolute/path/to/python","model":"/absolute/path/to/model"}`.
Build the Mac app to bundle the script. No runtime configuration is committed.
`tools/benchmark-word-confidence.py` accepts a frozen corpus manifest containing
file, sha256, reference, language and terms. References are used only by the scorer,
never passed to the recognizer. Synthetic mixed speech is not a substitute for
independent real conversations.

## Google comparison (2026-10-16)

Google Cloud STT v2 offers Chirp 3 (`chirp_3`): multilingual recognition,
streaming, automatic language detection and term adaptation. The documentation
states that the returned word confidence value is not a true confidence score.
Dominant-language detection is not per-word language identification. This public
Cloud API model must not be assumed to power every Google product; local weights
are not offered by this API documentation.

- https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3
- https://github.com/SYSTRAN/faster-whisper
- https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/offline-recognizer-whisper-impl.h

## Zipformer adaptation / own model

A hotword list biases paths the existing model can represent; it does not teach
English acoustics to a Russian-only model. Do not append tokens to tokens.txt:
token IDs and decoder/joiner dimensions must match the trained checkpoint.
For a small streaming RU/EN model, first benchmark a compatible multilingual
checkpoint, then fine-tune with RU, EN and genuinely code-switched speech, retaining
monolingual replay data to limit forgetting. Check training checkpoint access and
licenses before selecting an ONNX-only distribution as a starting point.

Use icefall recipes; train a shared tokenizer or carefully expand the checkpoint
with the associated decoder/joiner changes. Separate train/validation/test by
speaker and source, include accented English terms, noise, overlap, negations and
confusable ordinary Russian words. Hold out human recordings; synthesized speech
is augmentation. Compare WER by language, term error rate, false corrections,
streaming first-token/final latency and peak RAM. Quantize/export to ONNX only
after the float model passes, then rerun the same tests on the target hardware.
Training from scratch is a separate data/compute project; no quality or cost claim
is justified before a pilot. No remote training or paid GPUs have been started.

- https://github.com/k2-fsa/icefall
- https://k2-fsa.github.io/sherpa/onnx/hotwords/

A search found a multilingual-named moeru-ai Zipformer repository, but its card
also says "Single language"; its RU/EN code-switching ability is unverified. Do not
recommend it solely from its name.

## Measured gate — 2026-10-16

Frozen evaluation: 32 synthetic mixed RU/EN recordings with terms (quiet/noise,
8 categories) plus 12 previously held-out human FLEURS clips (6 RU, 6 EN).
Six-second chunks, CPU int8, two threads. Reference text never reaches inference.
Base model revision: `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66`.

| Group | Files | Reference words | Baseline errors | Selected errors | WER before/after |
|---|---:|---:|---:|---:|---:|
| Synthetic mixed |32|432|237|237|54.86% / 54.86%|
| Human RU |6|96|26|26|27.08% / 27.08%|
| Human EN |6|123|12|12|9.76% / 9.76%|

56 second decodes, zero accepted changes, zero improvements, zero regressions.
Median chunk inference 1.96 s, p95 2.88 s; warm-model measurements, some overlap
with compilation, not end-to-end or isolated production latency. No lower-WER
claim is warranted. **Automatic replacement gate failed: do not enable.**
The unchanged human controls had no term prompts, so they do not validate
resistance to misleading term hints. Real human mixed speech is still required.

Small model on the first 16 synthetic quiet clips: 54/212 errors (25.47%), no
second decodes under the 2.5-second first-pass budget and no accepted changes.
This is a different subset and must not be compared to the full base set as a
model-ranking experiment. Synthetic accents, Cyrillic transliterations of English
and cuts at six-second boundaries affect strict WER.

Implementation checks: 241 JS tests passed, 1 opt-in skip; 129 Swift passed,
3 opt-in skips; 13 Python passed; Swift release build passed. Browser SDK scores
remain nullable; Mac adapter remains opt-in and suggestions-only. No runtime
configuration or installed app was changed. Local detailed reports and model
hashes are in ignored `validation/word-confidence-20261016/`.
