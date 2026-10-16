# Ready-made RU/EN models on Apple GPU

2026-10-16. Mac M3 Pro, 18 GB unified memory. Objective: replace paid recognition locally while measuring quality and processing time. No training or paid inference in this experiment.

## Results

Each model completed two sequential runs of the same 44 audio cases. Transcripts were identical between repeats for every model. Warmed compute times varied, especially for Codeswitch; ranges below retain that variation.

| Model / execution | Mixed WER | RU WER | EN WER | Median compute per utterance, runs 1–2 | p95 compute, runs 1–2 | Model files |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Whisper small, MLX FP16 | 24.53% | 5.10% | 7.26% | 0.469–0.491 s | 0.541–0.561 s | 481 MB |
| Whisper large-v3-turbo Russian Codeswitch, MLX FP16 | 10.28% | 5.10% | 4.03% | 1.502–1.987 s | 1.706–2.211 s | 1614 MB |
| Nemotron 3.5 ASR streaming 0.6B, native Metal Q8 | 29.44% | 13.27% | 10.48% | 0.552–0.632 s | 0.821–0.989 s | 742 MB |

These are compute times for complete recorded utterances, NOT microphone-to-first-text latency. Nemotron receives accelerated 320 ms chunks; Whisper receives complete utterances. Nemotron's streaming capability is not represented by the full-utterance timing column.

Real-time factors (compute/audio duration): small 0.061–0.064, Codeswitch 0.202–0.259, Nemotron 0.077–0.088. All are below one on this machine and corpus. This does not establish real-time operation on weaker computers or under concurrent application load.

MLX peak allocated memory: small 1.45 GB; Codeswitch 2.47 GB. This is not total process/system memory. Native peak memory was not measured.

## Conditions and limitations

The corpus has 16 clean mixed synthetic utterances, 16 derivatives of those utterances (eight at −24 dB, eight with Gaussian noise at SNR 12 dB), and 12 human FLEURS controls (six RU, six EN). There are 28 independent source utterances, not 44. Mixed WER uses 428 reference words including derivatives. RU and EN contain only 98 and 124 reference words respectively. Mixed-speech quality on natural calls remains unproven.

| Mixed condition | Small | Codeswitch | Nemotron |
| --- | ---: | ---: | ---: |
| Clean | 19.63% | 7.01% | 24.30% |
| Quiet | 22.43% | 6.54% | 30.84% |
| Noise | 36.45% | 20.56% | 38.32% |

Exact canonical technical-term recall across 32 annotated term instances: small 31.25%, Codeswitch 59.38%, Nemotron 9.38%. This metric requires canonical Latin spelling; phonetic Cyrillic renderings do not count. It is deliberately stricter than semantic intelligibility and does not cover every technical token in a sentence.

Codeswitch improves word-error counts on 32 of 44 cases, worsens four, and ties eight. Aggregate improvement does not mean no regressions. No model was promoted into the app by this experiment.

## Reproduction

Local artifacts: `validation/gpu-ruen-20261016/`: frozen audio manifest/hashes, six complete per-case JSON reports, aggregate `summary.json`, native logs, environment lock, converted Codeswitch weights and native benchmark binary. Large validation/model files remain outside source control.

- Small: `mlx-community/whisper-small-mlx`, revision `45f3915923c7a79a5a5b5a7d909d39aeb0e5630e`.
- Codeswitch: [coriollon/whisper-large-v3-turbo-russian-codeswitch](https://huggingface.co/coriollon/whisper-large-v3-turbo-russian-codeswitch), revision `bf64d2a976a268e35041f74233f889f951f0f676`, converted from original safetensors to FP16 MLX with strict key/shape validation.
- Nemotron GGUF SHA256: `3fc991d3badad7277c11030a7519832cddaf2057aafed6d4b25147e953a070b1`; pinned NeMo-Speech.cpp v0.2.0 macOS arm64 Metal runtime. Both runs explicitly log `backend=MTL0`, RNNT right context 3, 320 ms step. Initial harness startup failed because CTC geometry was zero even for RNNT; fixed to positive default geometry before both complete runs.
- MLX 0.32.4 / mlx-whisper 0.4.3; language auto, transcription task, greedy temperature 0, no previous-text conditioning, no reference/term prompts. No word timestamps requested.
- Each model loads once per run; one second of silence warms it before measured cases. Each case resets transcription/stream state. Runs are sequential to avoid competition between these benchmark models. System-wide load and thermal conditions were not controlled.
- WER uses the same normalization and micro-averaging for all models. Audio hash, format, and scoring guards have automated tests.
- A separate official CLI invocation on the first mixed clip produced exactly the same transcript as the C ABI worker; saved as `cli-parity.json` with its log. This is a single-case integration check, not full corpus parity validation.

Tools: `tools/benchmark-ruen-gpu.py`, `tools/convert-whisper-mlx.py`, `tools/nemotron-gpu-bench.cpp`, `tools/score-ruen-pilot.py`.

## Decision for reducing API bills

Codeswitch is the strongest measured candidate for local final transcription on this small corpus. Small is faster and smaller, so a small → selective Codeswitch cascade deserves evaluation. Nemotron did not beat small on quality here, despite native streaming support.

The cascade itself has not been evaluated or deployed. First measure routing on representative human recordings, including errors that a confidence score misses, then compare against the actual paid baseline. Do not claim a savings percentage or commercial quality parity from these results. See [public datasets and cost plan](public-asr-corpora-and-cost-plan.md).
