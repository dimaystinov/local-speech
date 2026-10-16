# RU/EN technical speech: local fine-tuning pilot

Date: 2026-10-16. Experimental; does not replace the application's model.

## Frozen first experiment

Hypothesis: decoder adaptation of multilingual Whisper tiny can improve the spelling
of English terms embedded in Russian without changing its acoustic encoder or tokenizer.
This is specialization, not removal of other languages and not model compression.

1. Pin `openai/whisper-tiny` to `169d4a4341b33bc18d8881c4b69c2e104e1cc0af`.
2. Train on the existing development partition of synthetic technical speech
   (clean/quiet/noise, excluding long splices), plus development human FLEURS RU/EN.
   Freeze disjoint evaluation IDs, base utterances, file hashes and normalized references.
   The prepared pilot contains 132 training recordings and 28 evaluation recordings.
3. Freeze encoder, token and position embeddings. Update decoder layers with AdamW,
   learning rate 2e-5, batch 2, 96 steps, seed 1701, gradient clipping 1.0.
   Cache encoder states and train on local Apple MPS. Select the final checkpoint
   by fixed step count, not by test performance.
4. Convert both tiny checkpoints to CTranslate2 int8. Compare original tiny, adapted
   tiny, existing base and small in the same faster-whisper CPU runtime, two threads,
   beam 1, automatic language detection, without term prompts or textual corrections.
5. Measure normalized micro-WER separately for mixed, Russian and English speech;
   exact Latin term recall; model bundle bytes; warmed chunk processing time and RTF.
   Six-second independent windows match the previous experimental benchmark's window
   size, but are not an end-to-end test of the application's native sherpa pipeline.
6. Deployment gate: mixed WER improves by at least 10% relative, neither RU nor EN
   error count rises, term recall does not decrease, and p95 chunk time rises by no
   more than 10% against original tiny. Passing is only eligibility for a larger test.
   Require independent human mixed-speech, noise, silence and device tests before shipping.

Training loss alone is not evidence of improved recognition. The mixed fixtures use
synthetic speech; human controls are monolingual. This is a small feasibility experiment,
not evidence of Google parity. No speaker-disjoint claim is made. Evaluation runs must
be serial and outside training to avoid resource-contention bias.
All 16 evaluation term types occur in the training set's 40 term types. Sentences are
disjoint, but this evaluates known-term reuse, not unseen-term generalization. Templates
also come from the same authored corpus, so an independent corpus remains necessary.

Fixture clarification: `quiet` means speech attenuated by **24 dB**, not clean speech
in a quiet room. `noise` adds deterministic Gaussian noise at **12 dB SNR**. Thus the
primary 16 mixed clips are stress tests, not a representative natural-speech WER.
After the initial tiny results, a secondary diagnostic was frozen: the same held-out
base phrases in their original clean form, recognized as whole utterances, plus the
same human controls. It changes both audio condition and segmentation; it cannot
isolate their individual causal effects. It does not select a new training checkpoint.

## Reproduction

Use an isolated Python 3.11 environment with torch 2.8.0, transformers 4.57.1,
faster-whisper 1.2.1 and CTranslate2 4.6.0. Store model weights, audio, split manifest,
package lock and results in ignored `validation/ruen-finetune-20261016/`.
`tools/ruen-pilot.py --help` exposes prepare, train, convert and evaluate commands.
The prepare command verifies source audio hashes and refuses to overwrite a split.
Use local model snapshot paths for training and evaluation; inference downloads nothing.

Example commands (paths supplied by the operator; the output must be a fresh directory):

```sh
python tools/ruen-pilot.py prepare --production "$PRODUCTION_MANIFEST" --human "$HUMAN_MANIFEST" --output "$PILOT_DIR"
python tools/ruen-pilot.py train --model "$TINY_SNAPSHOT" --output "$PILOT_DIR"
python tools/ruen-pilot.py convert --model "$TINY_SNAPSHOT" --output "$PILOT_DIR/tiny-ct2"
python tools/ruen-pilot.py convert --model "$PILOT_DIR/checkpoint" --output "$PILOT_DIR/tuned-ct2"
python tools/ruen-pilot.py evaluate --model "$PILOT_DIR/tiny-ct2" --output "$PILOT_DIR" --report tiny.json
python tools/ruen-pilot.py evaluate --model "$PILOT_DIR/tuned-ct2" --output "$PILOT_DIR" --report tuned.json
python tools/score-ruen-pilot.py "$PILOT_DIR" tiny.json tuned.json
```

Install `tools/requirements-ruen-pilot.txt` in a separate virtual environment. These
training dependencies are not application dependencies. Original audio manifests
and models are separate local artifacts, not embedded in the SDK package.

## Better-matched open alternatives

These are research candidates; publisher scores are not our measurements.

| Candidate | Evidence and role | Limitation |
|---|---|---|
| [coriollon/whisper-large-v3-turbo-russian-codeswitch](https://huggingface.co/coriollon/whisper-large-v3-turbo-russian-codeswitch) | Specifically RU sentences with EN technical terms; author reports mixed WER 24.64% → 9.08% on 540 sentences. Ready CT2 quantization. | ~809M parameters; CT2 model.bin 814,054,531 bytes. Training uses synthetic mixed speech, 53 terms; author reports pure-RU regression. Card's Apache inheritance statement conflicts with upstream Whisper's MIT license; verify provenance before redistribution. |
| [bond005/whisper-podlodka-turbo](https://huggingface.co/bond005/whisper-podlodka-turbo) | RU/EN training, Russian technical podcasts, noise augmentation. Useful quality baseline/teacher. | ~809M; card explicitly says within-utterance code-switching has not been specifically evaluated. |
| [Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | Modern multilingual ASR including RU/EN; candidate quality teacher. | 600M is not tiny; official streaming support through vLLM is not an out-of-box Apple/browser implementation. |
| [GigaAM Multilingual](https://huggingface.co/ai-sage/GigaAM-Multilingual) | New 220M/600M Conformer CTC family, MIT card; unlike earlier RU-only GigaAM, includes English. | Authors describe English as moderate; mixed technical utterances need independent testing. |
| [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | Multilingual RU/EN candidate with efficient decoding. | 600M; multilingual coverage alone does not establish intra-sentence term accuracy. |
| [Nemotron 3.5 ASR Streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) | Cache-aware FastConformer RNNT; RU/EN supported; configurable 80–1120 ms audio chunks, preserving encoder state. Official card links a native C++/GGUF runtime. | 600M, OpenMDW-1.1; published throughput is NVIDIA H100, not Mac/browser measurements. Chunk size is not total user-visible latency; RU/EN intra-sentence terms still need testing. |
| [Whisper tiny Russian 16K vocabulary](https://huggingface.co/alphaedge-ai/whisper-tiny-rus-16384) | 24.1M parameters versus 37.8M original: demonstrates real vocabulary compression. | Russian-mined vocabulary, no demonstrated RU/EN mixed-quality guarantee. Do not replace a bilingual tokenizer with it untested. |

The previously found landco11 code-switch model is a duplicate of the coriollon model,
not independent corroboration. No verified ready-made small RU/EN Zipformer with
published mixed technical speech results was found in this search. This is not proof
that none exists.

[HoldSpeak](https://github.com/timmal/HoldSpeak) is a closely related macOS implementation:
WhisperKit, preferred-language restriction, and a terminology replacement dictionary.
It is useful as an implementation reference, not evidence of a new bilingual acoustic
model. Dictionary replacements need ambiguity tests before reuse.
[Echo](https://github.com/master5d/Echo) is another RU/EN Whisper/Parakeet desktop wrapper;
its repository is archived. A search also surfaced `d3vastated/whisper-small-ru-en-finetuned`,
but its card could not be retrieved/verified in this run; the name alone is insufficient
to recommend or execute it.

## Data and next experiments

[SwitchLingua Audio](https://huggingface.co/datasets/Shelton1013/SwitchLingua_audio)
provides actual bilingual speaker recordings including RU/EN. Its text was generated,
but its audio is human-recorded according to the dataset card. Keep a pinned independent
RU/EN subset for external evaluation after access is agreed. Access is gated and the
card specifies CC-BY-NC-4.0 plus a separate agreement; it is excluded from this local
pilot and is not suitable as an automatically accepted commercial training source.
Do not confuse it with synthetic SwitchLingua 2.0.

If tiny adaptation passes: expand human code-switch data and anti-forgetting replay,
then compare distillation from a stronger specialist teacher. Only afterwards test
RU+EN vocabulary trimming while retaining byte fallback, special tokens, timestamps
and unseen English technical terms. Re-run the same runtime and quality gates for every
compression step. Changing vocabulary and weights together would hide the source of a regression.

### Follow-up order after this pilot

1. Establish an independent human RU/EN technical evaluation corpus with clear usage
   rights, speaker/session separation, unseen terms, numbers and negations. A larger
   replay corpus must cover ordinary RU and EN; 12 human training clips are insufficient.
2. Benchmark specialist Whisper and Nemotron's streaming architecture on an accelerated
   Mac runtime. CPU-only CTranslate2 results cannot predict Metal/CoreML performance.
3. Pre-register a new tiny/base experiment with a larger human replay proportion and
   teacher-logit preservation on ordinary speech. Compare decoder adaptation against
   encoder adapters; choose hyperparameters on a separate development set.
4. Test bilingual vocabulary trimming only after quality passes. Verify byte fallback,
   token ID remapping, language/task/timestamp tokens and target runtime compatibility.
5. Promote through the SDK only after independent WER, term accuracy, latency, silence,
   noise, overlapping speech and device-memory gates. Keep the prior model available
   for rollback. This pilot changes no application defaults.

## Research checks

[Encoding Refining and Language-Aware Decoding (ICASSP 2025)](https://arxiv.org/abs/2412.16507)
studies separate language-aware adapters and encoder refinement on SEAME. It supports
testing language-aware adaptation, not a claim of RU/EN performance.
[Improving Code Switching with SFT and GELU Adapters](https://arxiv.org/abs/2506.00291)
was withdrawn with the reason “Incorrect results”; its scores must not be used as
support for an implementation decision.
