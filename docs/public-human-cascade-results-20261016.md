# Human speech: small, Codeswitch, and a fully local cascade

2026-10-16. Mac M3 Pro, 18 GB unified memory, MLX Metal FP16. No paid ASR or LLM inference. Model weights are the same pinned artifacts as [the earlier GPU experiment](gpu-ruen-results-20261016.md).

## Verdict

Codeswitch alone has the lowest held-out WER. The small → selective Codeswitch cascade reduces errors relative to small, but does not match Codeswitch's accuracy and does not meet its development-time 50% refinement budget on held-out audio. Exact technical-token spelling also fails to improve. The cascade is a working, tested experiment, not an approved production default.

## Data and isolation

Downloaded Podlodka's public train, test and validation parquet files. Test and validation are byte-identical (SHA256 recorded by the importer). Deduplicated corpus: 87 actual human podcast clips, about 33 minutes; add 24 previously pinned human FLEURS controls, yielding 111 clips / 36.73 minutes. No TTS, stitched languages or artificial noise in this experiment.

Development: 42 clips. Held-out evaluation: 69 clips / 22.84 minutes / 3452 reference words. Holdout contains 18 podcast clips with Latin tokens in their published Russian transcripts, 45 Russian-only clips, and six English clips. This mixed/technical subset contains 1230 reference words and 60 unique-within-utterance Latin token/term instances. Some tokens are product names or borrowings, not full English clauses. It is not a comprehensive code-switching corpus.

All four episodes in official Podlodka test (132, 275, 292, 306) were held out, including their rows placed in official train. Other episodes formed development. File hashes, transcript strings and episode groups do not cross the partition. Recurring hosts may cross episodes; speaker independence is not established. Public benchmark exposure during model development/pretraining cannot be excluded. These are mainly podcast recordings, not noisy telephony or overlapping calls.

Podlodka's inspected card does not state a data license. Local audio and transcripts remain ignored validation artifacts; they are not redistributed with the SDK or used to train weights. Further product training/redistribution requires rights clarification. FLEURS is CC BY 4.0.

## Accuracy on held-out audio

| Mode | Overall WER | RU + Latin technical tokens | Russian-only | English-only |
| --- | ---: | ---: | ---: | ---: |
| Small | 16.51% (570 edits) | 16.10% | 17.30% | 7.26% |
| Codeswitch | **9.04% (312 edits)** | **12.68%** | **7.20%** | **4.03%** |
| Actual cascade | 9.53% (329 edits) | 12.76% | 7.96% | 4.03% |

Cascade versus small: 42.3% fewer edits overall, 20.7% fewer on the mixed/technical subset. These are descriptive relative reductions on this corpus, not a population guarantee. It improves 29 clips, worsens seven, and ties 33. None of small's zero-edit clips becomes erroneous, but already imperfect clips can regress.

Exact canonical Latin-term recall: small 24/60 (40.0%); Codeswitch and cascade 23/60 (38.3%). Phonetic Cyrillic rendering is scored as a mismatch. Aggregate WER improvement does not establish better technical spelling.

The cascade reduces aggregate edits in every held-out podcast episode: 88→74, 246→92, 141→111 and 81→45. A sizeable portion of the overall gain comes from difficult long clips, so do not infer a uniform per-utterance improvement.

## Routing and actual execution

Selected on development only from a fixed grid: re-recognize when small's token-weighted average log probability is below −0.15, or its compression ratio exceeds 2.4, or its output/confidence is missing. A competing Latin+Cyrillic text heuristic was considered on development and was not selected. The threshold is a decoder diagnostic, not a calibrated word-correctness probability.

Development selection minimized edit count under a ≤50% audio-minute refinement budget and no language-group regression. Rule was saved before held-out scoring. Development refinement was 49.77%; holdout was 62.07% (39/69 clips). There is no hard runtime quota; this is a distribution shift in the rate at which a fixed rule fires.

Both models then ran as separate persistent local workers with offline Hugging Face/Transformers settings. Only audio paths and audio hashes enter workers. References, reference terms and gold language labels are excluded from routing and recognition. All 69 actual cascade outputs and routing decisions exactly match the frozen prediction replay.

| Timing scope | Total compute for 22.84 minutes of audio | Median per clip | p95 per clip |
| --- | ---: | ---: | ---: |
| Small baseline, inference only | 49.48 s | 0.667 s | 1.488 s |
| Codeswitch baseline, inference only | 136.88 s | 1.830 s | 3.049 s |
| Codeswitch matched worker control, including IPC and WAV reading | **134.83 s** | **1.787 s** | **2.994 s** |
| Actual cascade, including worker IPC and WAV reading | 146.40 s | 2.429 s | 4.660 s |

Cascade model startup/warmup: 7.00 seconds, excluded from the table. Whole-file utterance processing is measured; these numbers are not time to first text during live speech. The matched single-worker control uses the same IPC, WAV reading and timing boundary as the cascade; all 69 outputs match the Codeswitch baseline. The cascade is about 8.6% slower in these measured runs. These are single sequential passes with uncontrolled background load/thermals, not a statistical latency guarantee. Different timing scopes in the baseline rows must not be treated as controlled speed ratios.

Cached stage timings would have predicted 129.49 seconds for the cascade; actual execution took 146.40 seconds. This is why the result is based on executing the cascade, not only simulating its decisions.

## Reproduction and checks

Artifacts: `validation/public-human-20261016/`: pinned downloads and source hashes, converted PCM16 audio, frozen corpus, per-model hypotheses/diagnostics, policy/grid, cached replay, actual cascade and direct-control reports, aggregate results, package lock, downloaded papers and paper hashes. These are local ignored artifacts.

Commands use `.venv-asr-gpu/bin/python` from the workspace:

1. `tools/prepare-public-human-asr.py --output ... --fleurs-corpus ...` downloads/verifies archives, rejects partition overlap and freezes the manifest.
2. `tools/benchmark-ruen-gpu.py --backend mlx --model ... --corpus ... --output ...` runs each model with identical greedy, auto-language, no-context settings.
3. `tools/asr-cascade.py fit --small .../small.json --large .../codeswitch.json --output .../policy.json` freezes development-only routing.
4. `tools/asr-cascade.py run --small MODEL --large MODEL --corpus ... --policy ... --output ...` executes the cascade. `--direct-large` runs the matched single-model timing control.
5. `tools/score-public-cascade.py DIRECTORY` rejects incomplete or mismatched reports and checks actual-inference parity before scoring.

20 unit tests passed across audio integrity/format, split and WER scoring, and routing safeguards. Python compilation and `git diff --check` passed. No app model setting was changed by this experiment.

## Recommendation

Use Codeswitch as the leading local final-transcription candidate on this Mac. Keep small as a possible preview stage only if live responsiveness justifies the additional compute. Do not enable the tested selective cascade as a speed optimization or claim it protects every term. Next gates: licensed natural RU/EN recordings from new speakers, critical-term audit, calibrated word-error detection, and end-to-end streaming timing. See [the research review](local-asr-methods-20261016.md) for acoustic contextual biasing, confidence estimation and streaming methods.
