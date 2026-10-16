# Local RU/EN recognition: research and experiment decisions

Research date: 2026-10-16. This is a targeted engineering review, not an exhaustive systematic review. Titles and dates were checked against arXiv landing pages; method details against their HTML papers. Six PDFs are cached with SHA256 in `validation/public-human-20261016/papers/manifest.json`. They are not republished with the SDK.

Question: can a small local recognizer deliver the initial transcript and selectively invoke a larger local model, reducing recognition errors and avoiding paid inference? Outcomes: held-out WER, terminology preservation, escalation by audio duration, compute time, and regressions.

| Evidence | Mechanism and applicability | Limits / decision |
| --- | --- | --- |
| [Adopting Whisper for Confidence Estimation (2025)](https://arxiv.org/abs/2502.13446) | C-Whisper learns word correctness from audio plus a hypothesized transcript. Supports using an acoustic confidence estimator rather than treating decoder softmax as correctness probability. | Requires trained confidence weights and suitable data. We have not reproduced it or verified a ready RU/EN checkpoint. Current experiment uses diagnostics, not calibrated word probabilities. |
| [Identifying and Calibrating Overconfidence in Noisy Speech Recognition (2025)](https://arxiv.org/abs/2509.07195) | Detects overconfident tokens and selectively calibrates scores. Motivation for testing routing on noisy human audio, not merely choosing a universal threshold. | Experiments use Whisper-medium.en and R-SPIN with constructed noise. Calibration improvements do not imply transcript/WER improvements or transfer to RU/EN. Paper filters obvious hallucinations; our benchmark retains all outputs. |
| [Aligning Speech to Languages to Enhance Code-switching Speech Recognition (2024)](https://arxiv.org/abs/2403.05887) | Adds language-alignment supervision and frame-level language evidence. Explains why local language evidence can help at switches. | Studied Mandarin-English; needs adaptation/training. Low Russian-word confidence is not an English-word posterior. Do not relabel words on that assumption. |
| [Turning Whisper into Real-Time Transcription System (2023)](https://arxiv.org/abs/2307.14743) | LocalAgreement commits a stable prefix across consecutive decodes and manages the audio buffer. Appropriate for incremental UI with revisable trailing text. | Repeated recognition increases compute; stability does not prove correctness. The present experiment measures completed audio, not this live streaming policy. Official [implementation](https://github.com/ufal/whisper_streaming) and MIT license inspected. |
| [Fast Context-Biasing for CTC and Transducer ASR models with CTC-based Word Spotter (2024)](https://arxiv.org/abs/2406.07096) | Matches acoustic CTC scores to a contextual vocabulary and replaces localized recognition candidates. Relevant to a future CTC/Zipformer branch with appropriate outputs. | Not a drop-in dictionary for Whisper's autoregressive decoder. Keep acoustic validation; unconditional text substitution can corrupt correct words. NeMo implementation is described by authors; not reproduced here. |
| [Adding Robust Code-Switching Capabilities to High Performance Multilingual ASR (2026)](https://arxiv.org/abs/2606.21990) | Bayesian factorized adaptation aims to add switching capability while preserving monolingual quality. Strong reason to retain RU-only and EN-only regression sets. | English-German experiments with synthetic adaptation data; not proof of Russian performance. Training direction after data/benchmark work, not a ready replacement. |

## Two different meanings of combining models

Our cascade uses small's final hypothesis and diagnostics to decide whether to re-recognize the audio with Codeswitch. It can change both errors and compute, and it can regress.

[Speculative decoding](https://huggingface.co/blog/whisper-speculative-decoding) instead drafts tokens with a smaller model and verifies them with the target model to preserve target-model output under the algorithm's assumptions. The documented Whisper implementation requires matching tokenizers. Our small and large-v3-derived models have different vocabularies; simply passing one as an assistant is not a validated implementation. MLX support and actual Mac acceleration must be established separately. The published CUDA speedup is not our Mac measurement.

## Implemented experiment

- All inference remains local on Metal. Two persistent workers prevent MLX's single-model cache from reloading weights on each route.
- Small diagnostics: token-count-weighted average log probability and compression ratio. Optional routing when the predicted text itself contains both Latin and Cyrillic. Reference text, annotated terms, and gold language labels never enter inference/routing.
- Fit only on development episodes; minimize edit count subject to at most 50% of audio duration going to Codeswitch and no development language-group regression. Freeze rule before holdout scoring.
- Compare small alone, Codeswitch alone, cached cascade replay, and an actual two-worker cascade. Cached compute sums are estimates, not measured cascade latency.
- Preserve the original transcript for comparing revisions; do not insert ungrounded LLM rewrites into the WER evaluation.

## Dataset screening

Downloaded all 87 unique Podlodka rows (train plus test) and both test/validation archives to check leakage. Test and validation are byte-identical. All episodes present in official test are reserved for holdout, including rows placed by the publisher in train. Hosts can recur across episodes; this is not proven speaker separation. Publisher transcription containing Latin tokens defines a diagnostic mixed/technical subset, not a full linguistic audit of code-switching.

Podlodka's inspected card does not specify a data license. Local diagnostic files are not redistributed, used for weight training, or included in the product; product training/redistribution requires rights clarification. Model exposure to this public benchmark cannot be excluded.

FLEURS supplies separately recorded human RU/EN controls (CC BY 4.0), not mixed-language conversation. Existing pinned audio is reused, with development/test separation retained.

SwitchLingua Audio was not downloaded: gated access with an additional agreement and noncommercial terms. CS-FLEURS is synthetic and noncommercial; it does not satisfy the request for natural speech. CoVoST translation pairs and text-only code-switch corpora do not satisfy the audio/transcription requirement. ADLIB DevTerm is Japanese-English, not RU/EN.

## Production decisions still requiring evidence

Do not promise zero errors or silently promote a routing policy on an aggregate gain. Check critical names, numbers and negations; human-listen to disagreements. Test background speakers, phone codecs and long calls separately. Add external topic vocabulary only from context available before the utterance, never from its reference transcript. A local larger-model fallback removes the per-minute API charge, but does not make compute or support free.
