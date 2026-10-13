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
