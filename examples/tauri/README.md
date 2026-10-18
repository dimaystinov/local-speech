# LocalSpeech SDK demo: Web + Tauri 2

Full installation, API, models, TTS, Qwen provider contract and upgrade instructions:
[Integration guide](../../docs/integration.md).

From the repository root: download models and `npm run build` first.
Then here: `npm ci`, `npm run assets`, `npm run dev` for browser,
or `npm run desktop` for Tauri. Requires Node 22+, Rust 1.90+ and platform tools.
`npm run tauri -- build --bundles app` builds a macOS app.

This host runs browser WASM ASR. Native macOS system TTS is included; Qwen requires
an external local provider. Windows/Linux native TTS and system-audio capture are
not supplied by this example. Never send untrusted text to a shell.

Keep the lockfiles. Runtime/models copied to public/ are generated and not
committed. Updating the SDK means copying a new versioned resource directory,
testing it, then switching between sessions. App auto-updating is not enabled.
