# Context glossary acoustic review: measured experiment

Follow-up: [unknown-word phonetic review and repeatability checks](foreign-review-20261016.md)
tests confident Cyrillic English words beyond this fixed glossary.

A high CTC emission score does not rule out Cyrillic spellings of English terms.
`tools/term-review.py` uses a caller-supplied glossary (maximum 64 terms, eight
pronunciations per term) to request independent Qwen recognition. The glossary is
not an inference prompt and never replaces text without second-model evidence.

The example glossary is manually authored, not extracted from held-out references.
Only enable terms relevant to the user's actual project. «Редис», «питон» and
«докер» are intentional negative controls. Exact token aliases avoid substring
matches and speculative broad fuzzy matching.

A patch needs independent Latin term evidence from Qwen. Unique term occurrences
are isolated inside larger rewrites using nearby matching lexical anchors and
bounded positional drift. Source neighbours and negations are retained. Ambiguous
repeated term occurrences are rejected by the glossary path. Already-Latin
spacing can be canonicalized (Git Hub → GitHub). Existing uncertainty corrections
remain separate and may have their own regressions.

## Experiment protocol

- The initial 52 synthetic files became development diagnostics after exposing
  neighbouring-word rejection. They are not final validation.
- Freeze the glossary and anchor rules before evaluating 40 additional synthetic
  files: 16 new technical sentences clean and with 15 dB white noise, plus eight
  Russian controls. Spoken phonetic terms and intended canonical spellings are
  explicitly paired in `experiments/term-review/heldout-script.json`. These are
  controlled term-orthography diagnostics, not human-call WER evidence.
- Evaluate 48 new public Russian/English readings, first 48 Russian rows of
  [CS-FLEURS Tagged](https://huggingface.co/datasets/YapayNet/cs-fleurs-tagged).
  Source snapshots and audio hashes are frozen locally. Exact references and audio
  hashes do not overlap the earlier public corpus. Speaker independence and model
  pretraining exclusion are not established. This is read general code-switching,
  not a technical-call dataset.
- Both GPU workers remain resident. The scorer reconstructs the old policy from
  the same acoustic hypotheses, verifies exact replay of the actual new output,
  and reports losses of previously matched reference words. Repeated-word alignment
  can be ambiguous. Old-policy timing is not measured by this replay.

## Results: M3 Pro, 18 GB

| New evaluation | Old confidence-only cascade WER | With glossary WER | Improved / regressed |
|---|---:|---:|---:|
| 40 synthetic technical/control files | 21.66% | 18.43% | 5 / 0 |
| 24 clean synthetic files | 17.29% | 12.03% | 5 / 0 |
| 16 noisy synthetic files | 28.57% | 28.57% | 0 / 0 |
| 48 public mixed-language readings | 39.16% | 39.16% | 0 / 0 |

The synthetic holdout drops from 47 to 40 edits over 217 reference words.
All five additionally improved files were outside the old confidence route:
the extension demonstrates correction despite confident Cyrillic output.
No previously matched reference words were lost. None of the eight new Russian
controls changed. Clean/noisy versions share the same utterances and are not
independent samples. No tuning was performed on these holdout predictions.

The 94.60 seconds of synthetic audio took 12.98 seconds total warm processing;
draft compute was 3.22 seconds. Final median/p95: 0.144/0.714 seconds. Additional
Qwen inference on newly routed clips totalled 8.04 seconds. This is additional
compute, not a matched wall-time delta or live speech latency. Routed audio was
42.79%. Exact aliases miss distorted pronunciations, especially under noise.

The public set contains 491.70 seconds and 996 reference words. The cascade took
14.80 seconds, but **did not improve** its 390 errors. A full Qwen 1.7B run achieved
31.93% WER (318 errors), taking 67.04 seconds. The technical glossary does not cover
arbitrary embedded English words, and GigaAM confidence fails to identify many.
The earlier 69-file podcast/FLEURS benchmark replays unchanged at 10.05% WER.

After evaluation, a unit-test-found duplicate-term fallback was removed; exact
replay confirms this safety fix changes none of the measured outputs. It is not
an additional quality improvement claimed from the holdout.

## Reproduction and production gate

- `prepare-term-review-fixtures.py --output ...` makes development diagnostics.
- Add `--script experiments/term-review/heldout-script.json` for new term controls.
- `prepare-cs-fleurs-eval.py --output ...` obtains the public viewer snapshot;
  `--metadata ...` reuses a saved snapshot while signed audio URLs remain valid.
- Add the example `glossary` array to a frozen cascade policy and bind the corpus
  SHA256/model paths before running `gigaam-qwen-cascade.py`.
- `score-term-review.py --input actual-run.json --output summary.json` verifies
  actual-output parity and scores the extension separately from the old policy.

CS-FLEURS is marked CC-BY-NC-4.0 by its publisher. Audio, transcripts, snapshots,
weights and per-recording predictions stay outside Git. No product training or
redistribution is included. The original corpus contains read and synthetic
subsets; preserve provenance rather than treating the entire source as live calls.

**Not promoted to production or enabled by default.** The next acceptance work is:
new natural technical calls with checked references and different speakers;
unknown-Cyrillic/English routing beyond a closed glossary; short acoustic crops
with context; bounded asynchronous queue/cancellation; real first-text and final
latency. A narrow synthetic improvement cannot justify claiming general reliable
English-term correction or zero regressions.
