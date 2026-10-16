# Mac GPU ASR comparison — 2026-10-16

Status: complete. Four models × two runs × 69 human recordings = 552 scored decodes, plus 72 short-prefix probes. Every model reproduced all 69 transcripts exactly in its repeat. No new candidate promoted to the application.

## Frozen protocol

- Apple M3 Pro, 18 GB unified RAM; MLX Metal GPU.
- Separate `.venv-asr-compare`; application and Roki environments unchanged.
- Frozen public-human corpus: 69 holdout recordings, 22.84 minutes. Same audio and reference normalization as previous Codeswitch evaluation.
- 18 mixed/technical clips (Latin words in published references), 45 Russian, 6 English. Mixed labels are not an independent linguistic audit.
- No transcript prompts, hotwords or forced language; greedy decoding. Qwen output capped at 2048 tokens, comfortably above expected transcripts for recordings up to 59.4 seconds. Investigate any cap hits.
- Each model runs in a fresh process, sequentially, with a one-second silence warm-up. Inference measured after audio read and GPU synchronization. Cold startup measured separately.
- Qwen MLX 8-bit 0.6B and 1.7B, Parakeet MLX default weights, Codeswitch existing FP16 MLX conversion. Comparing deployable artifacts, not equal precision architectures.
- Report micro WER overall and by language, exact Latin term recall, compute median/p95 and RTF, file size, MLX peak allocated memory and process peak RSS. Unified memory means RSS and MLX memory must NOT be added together.
- Additional fixed 2/4/8 second prefix probes on first three mixed clips measure short-window decode compute, not actual end-to-end streaming latency or word accuracy (prefix references are not aligned).
- Downloaded weights pinned to repository revision and SHA256 manifests. Audio, weights and raw results remain ignored local validation artifacts.

## Limitations

This holdout has already been inspected in prior experiments, so it is a common comparison benchmark, not an untouched final product test. Public training/evaluation exposure is unknown. Mostly podcast audio, not noisy overlapping calls; episode split is not a verified speaker split. Podlodka license is unspecified: local evaluation only, no redistribution or training. The same Mac is running other applications; timing is a local observation, not a hardware guarantee.

## Reproduction

`tools/benchmark-asr-alternatives.py` runs each backend. `tools/score-asr-alternatives.py` validates pairing and produces results. Local artifacts: `validation/asr-alternatives-20261016/`.

Pinned top-level dependencies: `tools/requirements-asr-alternatives.txt`; complete environment snapshot is saved with the local results. Download using `tools/download-asr-alternatives.py <experiment-directory>`. It checks the pinned Hugging Face LFS SHA256 and file sizes, retains weights locally, and never executes model repository code.

For a model run:

```sh
python tools/benchmark-asr-alternatives.py \
  --backend qwen \
  --model validation/asr-alternatives-20261016/Qwen3-ASR-0.6B-8bit \
  --corpus validation/public-human-20261016/corpus.json \
  --output validation/asr-alternatives-20261016/qwen06.json
```

Use a fresh output path for repeats. Backend `parakeet` uses the downloaded Parakeet directory; backend `whisper` uses the existing Codeswitch MLX conversion. The scorer expects `codeswitch.json`, `qwen06.json`, `qwen17.json`, `parakeet.json` and optionally their `-repeat.json` counterparts. All inputs must be complete and identically paired.

## Results and selection limits

All 69 recordings were transcribed by all four candidates on Metal. Codeswitch matched the prior experiment exactly. All available repeat runs match their first transcripts exactly.

| Artifact | WER overall | WER mixed | WER Russian | WER English | Exact Latin terms |
|---|---:|---:|---:|---:|---:|
| Codeswitch FP16 | 9.04% | 12.68% | 7.20% | 4.03% | 23/60 |
| Qwen3-ASR 0.6B 8bit | 13.01% | 17.24% | 11.06% | 4.03% | 27/60 |
| Qwen3-ASR 1.7B 8bit | 8.69% | 11.54% | 7.34% | 3.23% | 31/60 |
| Parakeet-TDT 0.6B v3 | 10.60% | 13.58% | 9.25% | 4.03% | 30/60 |

The term score uses distinct Latin strings from each published transcript, with the same normalization as WER. It is exact spelling recall, not semantic accuracy and not a curated list consisting exclusively of technical terms. The English subset has only 124 words; do not generalize its ranking.

Qwen 1.7B has 300 edits versus Codeswitch's 312 over 3452 reference words: a 0.35 percentage-point / 3.85% relative reduction. Mixed subset has 142 versus 156 edits. This is a modest point-estimate win, not established statistical superiority. Relative to Codeswitch, Qwen 1.7B improves 22 recordings, worsens 21 and ties 26; five previously perfect transcripts gain errors. Two podcast episode groups improve, two worsen. Automatic replacement is therefore not justified by a claim of universal superiority.

Qwen 0.6B improves 9 recordings but worsens 43; Parakeet improves 22 and worsens 28. All three can introduce errors where Codeswitch was correct. Do not combine outputs blindly or promise regression-free repair.

## Runtime interpretation

Parakeet's first pass had long outliers while system memory was under pressure. A captured observation reported roughly 21 GB used swap; this is **system-wide**, not Parakeet memory consumption. Other applications were not stopped. Metal kernel specialization/compilation and background load are additional potential confounders; the experiment does not isolate their contribution. Repeats are essential, but even two runs cannot establish production tail latency.

The default macOS process RSS statistic does not fully represent MLX GPU allocations. Report RSS and MLX allocated peak separately; neither is a complete measure of total system impact. The allocator cache is not included in MLX active allocation peak. These are not additive counters.

The first Codeswitch startup took 34 seconds in the newly installed environment; the second took 4.42 seconds. Do not interpret the first as ordinary model load time or compare it directly against already warmed framework imports.

## Recommendation

- For best measured mixed-Russian/English accuracy here: Qwen3-ASR 1.7B 8bit is the leading candidate, with ~4.1 GB peak MLX allocation. Keep Codeswitch as the tested reference/fallback, not a second model running constantly.
- For a fast preliminary transcript: Parakeet is promising, but its accuracy is below Codeswitch and tail latency needs an isolated real-time test under controlled memory pressure.
- For ~1 GB downloadable weights: Qwen3-ASR 0.6B is fast but materially less accurate on these recordings.
- Do not run every candidate continuously. A two-stage live system needs separate validation of stable prefixes, correction latency and routing decisions; this whole-recording comparison does not prove that such a cascade improves quality or cost.

No model was trained, no paid ASR requests were made, and no application model preference was changed.

## Final measured resources and timings

All GB below are decimal. Times exclude model startup and audio file loading. Range spans two fresh-process runs, with one silence warm-up each.

| Model | All 22.84 min audio, seconds | Median file, seconds | p95 file, seconds | Weights GB | MLX allocated peak GB | Process peak RSS GB |
|---|---:|---:|---:|---:|---:|---:|
| codeswitch | 132.38–135.58 | 1.78–1.80 | 3.02–3.19 | 1.61 | 2.50 | 1.19–1.54 |
| qwen06 | 71.40–77.29 | 0.96–1.03 | 2.21–2.49 | 1.01 | 2.57 | 1.43–1.43 |
| qwen17 | 146.85–159.11 | 1.97–2.15 | 4.66–4.84 | 2.47 | 4.11 | 1.64–3.00 |
| parakeet | 46.91–96.40 | 0.41–0.44 | 2.32–5.22 | 2.51 | 3.96 | 2.41–2.90 |

### Short-prefix probes

Median decode compute over 9 fixed prefixes per run. The model receives the entire prefix; this is not microphone-to-text latency, and it excludes the 2/4/8 seconds needed to acquire audio. No word-aligned prefix references were available, so no prefix WER is claimed.

- codeswitch: 1.447–1.736 seconds.
- qwen06: 0.291–0.321 seconds.
- qwen17: 0.579–0.586 seconds.
- parakeet: 0.081–0.400 seconds.

## Verification

- 16 relevant scoring/cascade/audio-integrity unit tests passed; Python compilation and git whitespace checks passed.
- Hugging Face LFS hashes and sizes verified for each new model; repository revisions and environment lock saved locally.
- All 8 runs complete and paired against the identical corpus digest; all repeats have 69/69 matching hypotheses.
- Existing Codeswitch outputs match the previous public-human experiment exactly.
- System memory pressure during Parakeet is explicitly recorded; do not claim isolated-hardware or production live-call latency.
