# LocalSpeech MCP: drafts and Roki voice

The `local-speech` MCP server exposes five tools. The original two draft tools remain read-only and independently opt-in. Three explicit voice tools use the running macOS app and approved local Qwen profile; see [Roki voice MCP](roki-voice-mcp.md). Enabling voice does not enable draft sharing, recording, field access, or message sending.

## Draft tools

LocalSpeech can expose its current dictated text to a local MCP client such as Codex. Enable the bridge explicitly in the app. The server reads only the current shared snapshot; it does not inspect call archives, capture a microphone, transmit audio, execute commands, or send messages to another application.

The client invokes either `localspeech_get_status` or `localspeech_read_draft`. A spoken draft is returned as data: it is not authorization to run its contents or send them to someone. The client must follow the user's current request and its own permission rules.

**MCP does not wake Codex or start a new conversation.** This server is pull-only. Ask the client to read the LocalSpeech draft, or use the app's separate, explicit text-insertion action. Reading a draft does not press Send. No outbox, delivery receipt, automatic trigger, or background polling is implemented here.

## Setup

Node.js 20 or newer is required. No npm dependencies, network listener, API key, or cloud service is used by the server. Run it as an MCP stdio subprocess:

```json
{
  "mcpServers": {
    "localspeech": {
      "command": "node",
      "args": ["/absolute/path/to/local-speech/tools/localspeech-mcp.cjs"]
    }
  }
}
```

For a Codex TOML configuration, the equivalent entry is:

```toml
[mcp_servers.localspeech]
command = "node"
args = ["/absolute/path/to/local-speech/tools/localspeech-mcp.cjs"]
```

Use absolute paths to the installed Node executable and server if the desktop app does not inherit your shell PATH. These snippets are manual setup examples; the server never modifies client configuration. Restart or reconnect the client after installation, then invoke `localspeech_get_status`. Sharing is disabled until the app publishes an enabled snapshot.

The default bridge directory is `~/Library/Application Support/LocalSpeech/AgentBridge`. `LOCALSPEECH_BRIDGE_DIR` can override this with an absolute, canonical directory for tests or another installation. There is no tool argument for arbitrary file paths.

## App IPC contract, version 1

The app owns `dictation-bridge.json` and atomically replaces it within a private directory (mode `0700`). Each completed file must be owned by the current OS user, mode `0600`, a regular file with one hard link, and no symlink in its path. The app should set restrictive permissions on the temporary file **before** renaming it. The server never creates or changes these files.

```json
{
  "version": 1,
  "enabled": true,
  "sessionId": "12345678-1234-1234-1234-123456789abc",
  "status": "ready",
  "rawText": "recognized original",
  "text": "User-visible formatted draft.",
  "updatedAt": "2026-10-13T12:00:00.000Z"
}
```

Only the documented fields are accepted. `sessionId` is a UUID. `status` is at most 256 characters without control characters. Each text field is at most 32,000 UTF-16 code units; the entire file is at most 256 KiB. `updatedAt` is an ISO 8601 timestamp with a timezone. More than five seconds in the future is invalid.

While sharing is enabled, publish a heartbeat at most every 30 seconds and update the snapshot after draft changes. Snapshots older than 120 seconds are inaccessible. Delete the snapshot when the user disables sharing or the app exits, and clear stale snapshots at app startup. A crash can leave the file on disk; the lease limits MCP access but does not erase bytes from storage. The app owns cleanup. Data already read by an MCP client cannot be recalled by disabling sharing.

`localspeech_get_status` returns `enabled`, `state` and, only for a fresh enabled snapshot, `sessionId`, `status`, `updatedAt`, `hasDraft`. It never returns either text field. `localspeech_read_draft` returns only `sessionId`, `text`, `updatedAt`. `rawText` is validated but never exported. Missing or disabled files fail closed; stale, malformed, insecure, or concurrently replaced files return no draft. Reinvoke the read after a replacement race.

The tools have no arguments and no write actions. The server reads a fresh snapshot for every call; it keeps no draft cache. File identity, metadata and directory identity are checked before and after reading. Its stdio parser limits each request to 64 KiB and respects output backpressure. Logs never contain draft text or raw filesystem error details.

## Validation and limits

```sh
node --test tests/localspeech-mcp.test.cjs
```

Tests cover a real stdio subprocess handshake, lifecycle/version negotiation, listing/calls, opt-in/disable, expired snapshots, malformed JSON/UTF-8, size limits, permissions, symlinks and hard links, atomic-replacement and disable races, fragmented UTF-8 input, and output backpressure. They use synthetic temporary snapshots. Connecting this adapter to a running Codex installation is a separate integration check; passing these tests does not demonstrate automatic wake-up, message delivery, or voice activation.

The implementation exposes the small stdio/tool subset needed here, with no resources, prompts, subscriptions, sampling, tasks or transport extensions. It negotiates supported MCP versions and uses the standard initialization lifecycle. Protocol references: [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).
