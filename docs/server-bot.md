# Server architecture for a customer/provider matching bot

Recommended starting point: **faster-whisper with multilingual Whisper large-v3-turbo on an NVIDIA GPU**, followed by a separate LLM extraction stage. This is a practical recommendation, not a benchmarked claim that it beats every current ASR model. The browser SDK in this repository is implemented; this server pipeline is an architecture proposal, not a deployed backend.

1. Accept a voice message with authenticated ownership, duration/size limits and a job ID. Queue transcription; reuse loaded models rather than loading one per message.
2. Normalize audio, apply VAD, transcribe with `faster-whisper`. Supply a short relevant terminology prompt; do not supply an expected answer. Use `task=transcribe` so speech is not intentionally translated. Evaluate mixed-language messages before forcing one language.
3. Preserve `raw_text` and timestamps. Let the LLM produce a separate readable version and schema-validated intent: `role`, `service`, `skills`, `location`, `budget`, `currency`, `deadline`, `constraints`, `clarifying_questions`. Missing facts remain null; retain source spans where possible.
4. Retrieve actual customer requests/provider profiles using hard filters and hybrid lexical/semantic search; rerank real candidates. The LLM explains matches rather than inventing people, prices or availability.
5. Ask for clarification on uncertain amounts, dates, names and negations. Never silently treat LLM polish as corrected ground truth. Spoken instructions are untrusted input, not system instructions.

For difficult messages, a second ASR pass with large-v3 can be evaluated, but the second model is not automatically authoritative. Model scores/disagreement can trigger review; they are not calibrated accuracy percentages. A separate multilingual text model can be self-hosted behind an API if text must also remain on your server. Exact GPU memory, batch size and model choice should follow representative load tests.

For single-user bot voice messages, diarization is usually unnecessary. Group recordings require a separate diarization stage; filtering one enrolled voice additionally requires speaker verification, and overlapping voices may require source separation.

Measure WER, technical-term errors, amount/date/negation preservation, schema accuracy, candidate retrieval quality, p95 latency and cost per audio minute. Keep a held-out human RU/EN/mixed dataset; synthetic smoke tests alone do not qualify a production release.

Primary references:
- https://github.com/SYSTRAN/faster-whisper — batched inference, VAD, model loading and runtime requirements.
- https://github.com/openai/whisper — multilingual Whisper models and turbo tradeoffs.
- https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html — enrolled speaker identification.

These are proposed server choices. The repository does not include a running Telegram bot, matching database or server ASR endpoint.
