# Optional offline speaker identification assets

This add-on uses **WeSpeaker VoxCeleb ResNet34-LM**, distributed by the ONNX
Community as `onnx-community/wespeaker-voxceleb-resnet34-LM`, revision
`6a61a1833ff2583aabeba044f5c8221f00b67ceb`.

- Model source: https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM
- Upstream model and authors: https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM
- WeSpeaker project: https://github.com/wenet-e2e/wespeaker
- License: Creative Commons Attribution 4.0 International. Full text is included
  in `licenses/speaker-cc-by-4.0.txt`.
- The ONNX Community conversion and q8 quantization are upstream modifications.
  LocalSpeech redistributes those pinned model/configuration bytes unchanged.
  No endorsement by the original authors is implied.

**Transformers.js 3.8.1**, Hugging Face, is distributed under Apache-2.0.
Its complete license is included in `licenses/speaker-transformers-apache-2.0.txt`.
Source: https://github.com/huggingface/transformers.js/tree/3.8.1

The bundle includes **@huggingface/jinja**, Hugging Face, under the MIT license
included in `licenses/speaker-jinja-mit.txt`.

Its bundled **ONNX Runtime Web 1.22.0-dev.20250409-89f8206ba4**, Microsoft,
uses the MIT license included in `licenses/onnxruntime.txt`.
Source: https://github.com/microsoft/onnxruntime

All packaged runtime, model and license sizes and SHA-256 digests appear in
`speaker-assets-manifest.json`. Build-time download is optional and separate from
inference: `python3 tools/download-speaker-model.py` downloads only missing or
invalid model files, verifies their pinned hashes, then atomically publishes each
file. `node tools/build-speaker-assets.cjs` performs no downloads and fails on
missing or modified assets. Install the exact Transformers.js package locally
or supply `--transformers-dir=PATH` to its package directory. Run the add-on
builder after `node tools/build-sdk.cjs`.

## Speaker segmentation and overlap detection

Optional segmentation uses `onnx-community/pyannote-segmentation-3.0`, revision
`733a93b6473d019a773298e08cefa686894b1854`, q8 ONNX weights (1,542,308 bytes).
Source: https://huggingface.co/onnx-community/pyannote-segmentation-3.0/tree/733a93b6473d019a773298e08cefa686894b1854
Upstream: https://huggingface.co/pyannote/segmentation-3.0

The model is MIT licensed, Copyright (c) 2022 CNRS. Full text appears in
`licenses/segmentation-pyannote-mit.txt`. The upstream Hugging Face repository
requires accepting its download conditions; this package uses the independently
public ONNX Community conversion, without attempting to access gated weights.
License text was verified from the official sherpa-onnx redistribution:
https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
Archive SHA-256: `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488`.

These unchanged converted weights predict silence, one of three local speaker
slots, or pairwise overlap. Local slots are not persistent identities. Segmentation
runs only when requested, in the optional speaker worker; it is not part of ASR.
The model does not separate overlapping voices into isolated audio, and its
classification confidence is not an identity probability or accuracy guarantee.
