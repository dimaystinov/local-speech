# Public ASR evaluation and paid-service replacement

Updated: 2026-10-16. Product objective: reduce paid transcription bills while preserving acceptable quality and latency on actual user audio. Model size is a constraint, not the objective itself.

## Public audio with reference transcripts

These are the speech equivalent of a ground-truth robotics benchmark. Dataset languages must not be confused with switching languages within one utterance.

| Corpus | Suitable test | Access and limitations |
| --- | --- | --- |
| [FLEURS](https://huggingface.co/datasets/google/fleurs) | Human-read Russian and English controls; multilingual regression | CC BY 4.0. Separate language subsets, not a mixed-speech benchmark. Already used in the pilot. |
| [LibriSpeech](https://www.openslr.org/12/) | English read speech, clean/other test partitions | CC BY 4.0. Useful control, not representative of calls or technical code-switching. |
| [AMI](https://groups.inf.ed.ac.uk/ami/corpus/) | Meetings, multiple speakers, close and far microphones, transcript alignment | 100 hours; signals and transcripts CC BY 4.0. Useful for meeting pipeline and speaker tests. Mostly elicited design-team meetings, with some natural meetings. |
| [Podlodka Speech](https://huggingface.co/datasets/bond005/podlodka_speech/blob/main/README.md) | Technical podcast audio with transcripts and episode identifiers | Downloaded for isolated local evaluation: 67 train plus 20 test rows. Validation and test are byte-identical. License is not specified in the inspected card; clarify rights before product training or redistribution. Only a subset has mixed-script technical references. |
| [Golos](https://openslr.org/114/) | Russian crowd and far-field speech | About 1240 hours; test archive 1.3 GB. Separate Sber license linked by publisher must be reviewed for intended use before import. |
| [SwitchLingua Audio](https://huggingface.co/datasets/Shelton1013/SwitchLingua_audio) | Code-switching, including Russian paired with English | 80+ hours across languages, 174 bilingual readers; generated scripts read by humans. Gated, CC BY-NC 4.0 and additional agreement. Not imported; commercial permission needed. |

First usable expansion: held-out FLEURS RU/EN + LibriSpeech test + AMI. Add technical mixed speech only with confirmed rights and manually checked references. Never use automatic ASR output as gold truth. Split by speaker/session and retain timestamps, audio hashes, reference normalization, and model revisions. Synthetic mixed speech is a diagnostic set, not proof of real-call quality.

## Cost and quality evaluation

Compare local small, local larger ready-made bilingual/multilingual model, and optionally the current paid baseline on identical audio. No paid API calls are enabled by this plan.

Record WER by language/condition, technical-term recall, number/name/negation errors, p50/p95 first-text and final-text latency, real-time factor, memory, and energy where measurable. Whole-file inference timing is not streaming latency.

For a proposed cascade, measure the fraction of audio minutes sent to each stage, not merely the fraction of clips. Route uncertain audio to a larger local model before considering a paid fallback. Confidence scores alone are not reliable error detectors: calibrate routing on a development set and evaluate missed errors and unnecessary escalation on a separate held-out set. Do not tune thresholds on the final test set.

At a constant API price P per audio hour, H input hours and paid fraction f:

- Baseline API bill = H × P.
- Cascade API bill = H × f × P (before provider minimum billing/rounding).
- API bill reduction = 1 − f; this is not total economic savings.
- Total cost must additionally include local/server compute, hosting, engineering and support. On-device compute has no per-minute API charge but consumes the user's resources.

Example scenario only: f = 0.10 would reduce billed API duration by 90%; this has not been demonstrated. Fully local operation keeps f = 0 and must surface uncertainty or request repetition instead of silently calling a remote service.

Acceptance requires measured quality relative to the current paid service on representative human audio, and a measured routing/cost curve. There is currently no verified percentage of bill savings or demonstrated parity with a paid service.
