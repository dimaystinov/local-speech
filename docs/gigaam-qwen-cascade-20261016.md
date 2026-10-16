# GigaAM + Qwen selective correction experiment

Experimental, not enabled in the application. Both models run locally on Apple GPU.
GigaAM Multilingual CTC uses explicit attention (see round-two report). Qwen3-ASR
1.7B MLX 8-bit is a second acoustic recognizer, not a text-only rewriting LLM.

## Frozen experiment design

Use the existing 111-file public-human manifest: 42 development, 69 comparison
holdout. This holdout has been examined in prior experiments, so it is not an
untouched final evaluation. Audio, publisher transcripts and weights stay local.

1. Generate GigaAM character emissions, derive word scores as minimum emitted
   character probability. These are uncalibrated CTC scores, not word correctness
   or English-language probabilities. Draft decoding stays greedy.
2. Run Qwen on all development utterances, without references, annotated languages
   or term lists. Test thresholds 0, .3, .5, .7, .85, .95 and two patch modes:
   Latin-containing replacements only, or any uncertain replacement.
3. Route when a draft contains Latin characters or a score below threshold. Patch
   only aligned replacement blocks of at most three words, with all source words
   eligible. No insertion/deletion; reject more than three changed blocks. Preserve
   original spelling and punctuation outside accepted spans.
4. Fit on development only: <=50% audio routed; no aggregate language regression;
   no previously perfect utterance corrupted. Minimize WER, then regressions and
   routed audio. The no-correction baseline is always eligible.
5. Freeze policy, run holdout with both persistent workers resident. Report actual
   IPC-inclusive compute, GigaAM draft compute, per-language errors and utterance
   regressions. Development performance does not guarantee holdout safety.

This first experiment routes whole recordings for Qwen context and applies local
text patches; it does NOT yet crop audio or implement live streaming. Model loading
is excluded from warm compute. Per-request GigaAM memory counters are snapshots,
not peaks; MLX peak is reported by its allocator. Do not add allocator figures to
claim physical combined memory.

Reproduce with `tools/gigaam-qwen-cascade.py run --help`, first using
`--split development`; then `fit --input ... --output policy.json`; then run
`--split holdout --policy policy.json`. Use the two separate pinned environments
in the existing ASR requirements files. No runtime policy reads reference text.

## Measured results (Mac M3 Pro, 18 GB)

Development chose `mode=uncertain, threshold=0.3`, routing 32.12% audio.
Development WER: 19.04% → 17.85%; 8 improved, 0 regressed utterances.
The development runner decodes every file with both models for calibration;
its recorded total is not selective-cascade latency.

Frozen policy SHA-256:
`c212b8e4d84cbadce8161cb4774f00fa0b20ddaac814cfd8b79b9db7347102d6`.

Holdout: 69 recordings, 3,452 reference words, 1,370.47 seconds audio.

| Method | WER | Warm compute for all audio |
|---|---:|---:|
| GigaAM alone, previous matched baseline | 10.57% | 15.59 s |
| GigaAM → selective Qwen patches | 10.05% | 49.87 s |
| Qwen 1.7B alone, previous matched baseline | 8.69% | 159.11 s |

The cascade reduced 365 word edits to 347 (18 fewer, 4.9% relative reduction).
Eight recordings improved; none increased WER, and no perfect recording became
incorrect. A deterministic minimum-edit alignment also found zero previously
matched reference words lost; repeated-word alignment ambiguity still applies.
These are observed corpus results, not a guarantee for future audio.

| Language group | GigaAM edits | Cascade edits | Reference words |
|---|---:|---:|---:|
| Russian | 141 | 141 | 2098 |
| Mixed/technical | 207 | 202 | 1230 |
| English | 17 | 4 | 124 |

Fourteen recordings (19.23% of audio duration) were rechecked. Exact annotated
Latin-term matches rose from 2/60 to 6/60; Qwen alone achieves 31/60. Most of the
remaining gap is missed confident Cyrillic renderings of English terms. This
routing policy cannot reliably detect those from confidence alone.

Draft warm inference median/p95: 0.195/0.426 seconds. Final IPC-inclusive
median/p95: 0.222/3.663 seconds. These are **whole-file compute times after the audio
is available**, not microphone-to-text streaming delay. The earlier standalone
baselines and this cascade are separate runs; their ratio is an observed timing
comparison, not a controlled live-app speedup.

All 69 GigaAM drafts matched the prior stable baseline exactly; every routed Qwen
transcript matched the standalone Qwen result. The scoring tool verifies corpus
hash, ordered IDs, references, draft parity, routing, patch output and edit counts.

Conclusion: useful fast experimental tier with conservative corrections, but not
a replacement for full Qwen when maximum technical-term accuracy is required.
Keep the production default unchanged. Next work requires audio-span routing with
context, independently supplied domain vocabulary, a new speaker-disjoint corpus,
and real streaming/back-pressure measurements before app integration.

Independent process restart/repeat: all 69/69 final transcripts were identical;
WER remained 10.05%, total warm compute 48.50 s.
