# Confident Cyrillic English-word review: experimental results

The cascade can now request Qwen even when GigaAM's CTC emission score is high.
An optional Russian morphological dictionary flags unknown Cyrillic tokens.
Unknown does **not** mean English and the score is not a language probability.
The independent Qwen acoustic transcript must contain a lowercase Latin word
with similar pronunciation, a nearby unchanged lexical anchor, and bounded
position drift. Ambiguous candidates, repeated source words and apparent proper
names abstain. Existing glossary review remains available for technical names.
Only accepted word spans change; neighbouring text is retained.

`foreignReview: true`, `phoneticThreshold: 0.55`, `maxForeignWords: 4`
enables the evaluated extension. `maxForeignWords: 0` permits corrections only
when the existing confidence/glossary route already invokes Qwen. The default
policy is unchanged. This is research tooling, not an enabled app feature.

Dependencies: `tools/requirements-foreign-review.txt` and espeak-ng (tested
1.52.0). espeak is used silently as a phonemizer, not as the ASR or test speaker.
Phonetic distance is heuristic; it is not a calibrated probability. Known Russian
homophones, transliterations retained by Qwen, names and many acronyms remain
unresolved. Missing espeak causes abstention. Morphological resources are required
when this optional policy is enabled.

## Protocol

Calibration uses 42 original development recordings and the 48 previously
inspected CS-FLEURS recordings. `fit-foreign-review.py` searches thresholds
0.55/0.65/0.75 and unknown-word limits 2/4/8; selection requires no utterance WER
regressions, no previously matched reference words lost, at most 65% routed audio,
and better aggregate WER. The selected policy improves development WER from
25.30% to 25.16%. Cached replay timing is not inference latency.

The frozen policy was evaluated on the next 48 Russian rows (offset 48) of
[CS-FLEURS Tagged](https://huggingface.co/datasets/YapayNet/cs-fleurs-tagged):
474.90 seconds and 973 reference words. Exact audio hashes, IDs and reference
strings are disjoint from the previous 48 recordings. These are public mixed
language readings, **not spontaneous technical calls**. Speaker independence and
exclusion from model pretraining are unverified. No references or reference term
lists are sent to either recognizer.

Models: ai-sage/GigaAM-Multilingual CTC revision
`2f8a57144e6ec3adfd32fe0484d9ea9913305bc8`, and
mlx-community/Qwen3-ASR-1.7B-8bit revision
`a8379a2e2f9e313c9292cdf1af4055ab56d50d55`. Hardware: M3 Pro, 18 GB.
Both workers stay resident. Scores compare old and new policies using the same
acoustic hypotheses and verify exact replay against recorded output.

## Results

| Policy | Errors / 973 words | WER | Improved / regressed files |
|---|---:|---:|---:|
| Existing confidence + glossary | 419 | 43.06% | baseline |
| Unknown-word review, limit 4 | 409 | 42.03% | 6 / 0 |
| Unknown-word review, limit 2 | 414 | 42.55% | 3 / 0 |
| Reuse existing Qwen calls only | 414 | 42.55% | 3 / 0 |

No previously matched reference words were lost. With limit 4, three improved
files were outside the old routing rule: the extension corrects some confident
Cyrillic output. The limit-2 policy spent additional compute but improved no
newly routed files. These small gains are not evidence of universal safety.
The previous 69-file corpus replays at 10.05% → 9.97% with zero regressions;
this is a regression check, not new independent evaluation.

After the device initialization guard described below, two independent limit-4
runs produced identical GigaAM, Qwen and final texts on all 48 files. Warm total
compute was 47.09 and 48.30 seconds; draft compute 7.65 and 8.02 seconds.
Median final per-file processing was 1.06/1.12 seconds, p95 2.17/2.08 seconds.
56.17% of audio was routed. Newly routed Qwen inference cost 23.35 seconds in
each run. These are whole-file compute measurements, exclude model startup,
and are **not streaming first-text or finalization latency**. Therefore the
larger routing policy does not satisfy a claim of improvement without extra delay.

The reuse-only option was added **after inspecting these results** and is an
exploratory ablation, not a fresh untouched holdout claim. Its guarded actual run
retained all 48 reference-run GigaAM drafts and fixed five errors without new
Qwen calls or matched-word losses. Total warm compute: 22.51 seconds; draft 6.95
seconds; median/p95 0.164/1.788 seconds; routed audio 25.21%. This avoids additional
model inference but still incurs dictionary/phonetic work. It does not establish
zero additional end-to-end latency. It is the preferable next candidate for a
new independent low-latency evaluation, not a reason to enable broad review now.

## Stability issue and containment

One earlier fresh-process reuse-only run produced different GigaAM drafts on
46/48 identical recordings and 60.74% draft WER. It already used manual attention;
the previous SDPA mitigation was insufficient. This run is retained locally as
a failed diagnostic, not silently removed or compared as a routing improvement.
Its root cause is not conclusively established.

`gigaam-device-check.py` materializes positional buffers on CPU before transferring
the encoder/head to MPS, compares CPU/MPS logits and exact argmax on a deterministic
1.6-second startup probe, and falls back to CPU on numerical mismatch. Both full
guarded runs passed and had exact text parity. A startup probe cannot guarantee
every subsequent real-audio kernel is correct; two repeats cannot establish
production reliability. The guard is not a general recovery mechanism for all
MPS runtime failures.

`check-cascade-repeat.py` rejects incompatible corpora/policies and fails when
draft, Qwen or final text changes between repeated runs. It catches draft drift
even if later corrections hide it in the final output.

## Reproduce and release gates

1. Prepare a fresh corpus with `prepare-cs-fleurs-eval.py --offset 48 --count 48`;
   retain the viewer snapshot and audio hashes locally.
2. Fit only on designated development reports using `fit-foreign-review.py`.
3. Bind the frozen policy to the evaluation corpus SHA256 and model paths, then
   run `gigaam-qwen-cascade.py run` twice in fresh worker processes.
4. Score each using `score-term-review.py --without foreign`; compare repeats
   using `check-cascade-repeat.py FIRST SECOND --output CHECK`.

CS-FLEURS is marked CC-BY-NC-4.0. Audio, references, predictions, model weights
and snapshots are excluded from Git; this experiment does not authorize their
commercial redistribution or product training.

**Not promoted to production.** Remaining gates: independently referenced
natural technical calls across speakers; short acoustic windows instead of full
clips; bounded asynchronous review and cancellation; long-session numerical
stability; measured streaming latency and memory. WER remains high on this
challenging corpus. No claim of paid-service parity or perfect recognition.
