# Context glossary review: work in progress

A high CTC emission score does not rule out Cyrillic spellings of English terms.
`tools/term-review.py` uses a bounded caller-supplied glossary (maximum 64 terms,
8 pronunciations per term) to request independent Qwen acoustic recognition.
The glossary is NOT sent as an inference prompt and does not replace text alone.

`experiments/term-review/glossary.json` is a manually authored technical example,
not extracted from held-out reference transcripts. Production should enable only
terms relevant to the user's actual project. Homophones such as «редис», «питон»
and «докер» are intentional negative-test cases.

Patches require independent Latin term evidence from Qwen. Unique term occurrences
can be isolated inside a larger rewrite using nearby matching lexical anchors;
all neighbouring source words stay unchanged. Ambiguous repeated occurrences,
unknown translations and substring matches are rejected. Existing conservative
uncertainty patches remain a separate part of the cascade.

## Validation status

The first 52 new synthetic diagnostics (20 technical utterances each clean/noisy,
12 Russian controls, macOS Milena) exposed neighbouring-word rewrite rejection.
They are now a development/diagnostic set, NOT an untouched final benchmark.
The initial exact-block version improved one utterance and inherited one WER
regression from the old uncertainty path; none of the 12 Russian controls was
changed. These figures are not results for the subsequently refined anchor logic.

Tests cover confident Cyrillic routing, independent acoustic confirmation,
homophones, preservation of negation/neighbours, multiword aliases, substring
rejection, ambiguity and bounds. Full corpus and latency validation is pending.
Do not enable this experiment by default in the product.

New public corpus candidate: [CS-FLEURS Tagged](https://huggingface.co/datasets/YapayNet/cs-fleurs-tagged),
based on [CS-FLEURS](https://huggingface.co/datasets/byan/cs-fleurs).
The publisher marks it CC-BY-NC-4.0. Any isolated evaluation data stays outside Git;
no product training or redistribution is included. The source contains read and
synthetic subsets; source/speaker provenance must be retained and limitations
reported. Downloads encountered intermittent TLS timeouts during this checkpoint.
