# Third-party components in LocalSpeech

Sherpa-onnx: Apache-2.0, see vendor/LICENSE-sherpa-onnx. ONNX Runtime: MIT, see licenses/onnxruntime.txt. Whisper tiny/base weights: MIT, see licenses/whisper.txt; ONNX exports are pinned in the evidence/model-manifest.json. Silero VAD: MIT, see licenses/silero-vad.txt. Selected Zipformer weights and BPE vocabulary: retain assets/licenses/zipformer.txt (copied to models/small/LICENSE during preparation) and model provenance. Other selected model licenses must be reviewed before redistribution; this file is not a license grant for application source.

Runtime/source assets are supplied by the project; package-manifest.json pins the exact copied files. SDK source has no newly assigned open-source license. Models are selected explicitly and hashes checked against evidence/model-manifest.json. This notice inventory covers the included top-level components; a reproducible minimal native/WASM rebuild must retain all transitive upstream notices.

License source records (retrieved 2026-10-09):

[
  {
    "component": "whisper",
    "source": "https://raw.githubusercontent.com/openai/whisper/main/LICENSE",
    "sha256": "b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d",
    "retrieved": "2026-10-09"
  },
  {
    "component": "silero-vad",
    "source": "https://raw.githubusercontent.com/snakers4/silero-vad/master/LICENSE",
    "sha256": "2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b",
    "retrieved": "2026-10-09"
  },
  {
    "component": "onnxruntime",
    "source": "https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE",
    "sha256": "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c",
    "retrieved": "2026-10-09"
  }
]

The Silero VAD JavaScript wrapper originates from k2-fsa/sherpa-onnx commit 99ddefaa92129858b80a71a426903dd4215c83fa, wasm/vad/sherpa-onnx-vad.js. Its freeConfig function was renamed freeVadConfig to avoid colliding with the ASR wrapper. The vendored runtime is the tested binary; exact file hashes are listed in assets/runtime-manifest.json. A full source-level reproducible runtime build recipe is not included.

Public export modification: build-machine directory strings in the WASM data section were replaced with an equal-length generic build path. Code sections and binary length are unchanged. Browser inference is rechecked after this sanitization.
