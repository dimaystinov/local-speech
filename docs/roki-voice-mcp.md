# Roki voice through MCP

The existing `local-speech` stdio server exposes the approved offline Qwen voice through the running LocalSpeech Calls macOS app. Qwen stays loaded and streams PCM to one AVAudioPlayerNode while later chunks are generated. It uses the same `RokiVoice` and sound-driven mouth envelope as the native Roki companion. The voice profile remains `roki-composed-01b`; no silent system-voice fallback is made.

## Start

1. Install/build and run LocalSpeech Calls. The existing local Qwen runtime and pinned model must be installed as described in [Roki companion](roki-companion.md).
2. Enable **Голос Роки через MCP** in the app. This is remembered across launches. Closing the app disables the endpoint until it is launched again. Disabling the switch cancels active MCP speech and removes pending commands and status.
3. Configure the MCP client with an absolute Node.js executable and the repository's `tools/localspeech-mcp.cjs`. See [configuration examples](local-mcp-bridge.md#setup).
4. Reconnect `local-speech` in the MCP client after updating this server; an existing stdio process still has the previous tool list loaded. Restarting the client also reconnects it.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `roki_speak` | `text` (1–600 Unicode scalar values), optional `emotion` | Acceptance and `request_id`; does not wait for synthesis/playback completion |
| `roki_voice_status` | Optional `request_id` | Current availability/playback metadata, or a particular request's state |
| `roki_stop` | None | Cancels speech initiated by MCP, including synthesis; leaves recording and other speech alone |

Emotions: `calm`, `attentive`, `thinking`, `happy`, `concerned`. These control the native avatar's expression; they do not change the selected Qwen voice or guarantee acoustic emotional delivery.

Example tool arguments:

```json
{"text":"Привет. Я Роки. Готова помочь.","emotion":"happy"}
```

Poll `roki_voice_status` with the returned `request_id` to observe `queued`, `preparing`, `speaking`, `completed`, `stopped`, `failed`, or `rejected`. `speaking` can overlap with generation; `completed` comes only after generation ends and all scheduled PCM buffers finish playback. Acknowledgement timeout reports an unknown outcome and its ID; inspect that ID before retrying to avoid duplicate speech.

For chat replies, submit the first complete sentence as soon as it is ready, then display that same text immediately without withholding it until playback finishes. Further sentences can be submitted while it is speaking, in order, using the same tool. Keep each fragment under 600 characters and no more than eight pending fragments. Poll status after submitting, but do not hold the chat's final text merely to await audio completion. Do not describe acceptance as completed playback. The MCP does not subscribe to Codex's token stream or read its window: the agent must explicitly send each text fragment. There is no automatic duplication of arbitrary messages from other chats or clients.

Availability status contains no spoken text. It includes engine, configured profile, Qwen runtime availability, recording exclusion, audio duration received so far, playback clock and current mouth amplitude. `warmReady` indicates the resident worker completed model/reference/kernel warmup; `warming` indicates startup. `generating`, `queued`, `underruns`, and `firstAudioMs` expose streaming progress. The latter measures app acceptance to scheduling the first PCM buffer, not physical speaker latency. The Qwen-available flag checks installation metadata; actual synthesis is verified by a successful request.

## Behavior and boundaries

- Local processing on this Mac; no network listener or cloud TTS. The app must stay running.
- The microphone and transcript-sharing switch are independent. Voice MCP does not capture, send messages, read field context, or execute spoken text.
- Recording/dictation and voice are mutually exclusive to prevent self-transcription. Recording or non-MCP speech causes explicit rejection. No voice command interrupts an active call.
- Only one utterance plays at a time. Up to eight subsequent MCP fragments wait in FIFO order. Stops cancel the active utterance and all queued fragments. Manual interruption, generation failure, disabling MCP or app shutdown also discards the queue.
- Enabling voice MCP prewarms Qwen, including reference conditioning and decoder kernels. The worker retains model memory while enabled. Audio arrives in approximately 0.64-second chunks; subsequent chunks are scheduled on the same audio node. First startup and restart after cancellation still need warmup. Cancellation terminates in-flight inference, closes playback immediately, then starts a fresh warm worker. Disabling the bridge or quitting releases the worker.
- Native Roki has sound-driven mouth movement. The separate Codex Pets sprite has no supported MCP lip-sync hook; this bridge does not claim to synchronize it.
- Disabling voice prevents future calls; it cannot recall responses already returned to a client.

## IPC and tests

Voice uses a separate private `~/Library/Application Support/LocalSpeech/RokiMCP` directory (0700), JSON files (0600), UUID session and request IDs, a ten-second availability lease, and ten-second command expiry. The app pins a directory descriptor, takes an exclusive lock, uses `openat`/`O_NOFOLLOW`, rejects non-regular/symlink/hardlinked or oversized input, and bounds the batch to 32 commands per poll. Replies retain the latest 32 request results without spoken text; expired/earlier-session requests are inaccessible. Normal polling is 200 ms; idle status heartbeat is two seconds. Pending text is removed after consumption, timeout, disable or startup. A crash can leave private pending bytes until restart; expiration prevents late playback.

```sh
node --test tests/localspeech-mcp.test.cjs tests/roki-voice-mcp.test.cjs
swift test --package-path apps/mac
# Audible live integration against the running app with voice MCP enabled:
ROKI_MCP_LIVE_TEST=1 node --test tests/roki-voice-live.test.cjs
```

The live test launches an actual stdio MCP session, speaks Russian and English through Qwen, requires playback before synthesis finishes, completion and a nonzero mouth envelope, verifies ordered fragments, then cancels inference and queued speech. No microphone recording is used in this test. It verifies the audio-player path, not the physical speaker volume or intelligibility from a loopback recording.

Streaming validation on the same development Mac, 2026-10-14: observed MCP-to-speaking latency was 1.032 s (Russian) and 0.874 s (English), compared with the original buffered measurements below. Both played while generation continued, completed successfully and had zero buffer underruns. Two queued fragments completed in order. Stop cancelled active and queued speech in 215 ms. Direct warm-worker measurements were 0.536/0.521 s to the first PCM chunk, with 4.48 s initial warmup. These measurements use the preserved Qwen model/reference; no voice substitution occurred.

Initial buffered-path validation on the development Mac, 2026-10-14: 19 Node tests passed; the full Swift suite executed 106 tests, with three unrelated opt-in skips and no failures. The separate audible MCP test passed using the installed release app: Russian first audio 11.36 s, clip 5.44 s; English first audio 9.76 s, clip 4.80 s; synthesis cancellation acknowledged in 208 ms. Both requests reached `completed`; peak mouth envelopes were 0.983 and 0.854. These are measurements of short synthetic phrases on this Mac, not latency guarantees for other text or hardware. A live-test-discovered atomic-status replacement race was fixed and covered by a regression test before the successful rerun.

Final streaming regression run, 2026-10-14: 110 Swift tests executed, two opt-in skips and zero failures, including audible Qwen streaming, pause/resume, completion, cancellation and bounded-queue/history stress tests. All 19 Node transport tests passed. The installed-app streaming MCP test above also passed. Queue results retain recently updated terminal states so overflow rejections cannot evict a just-completed active request.
