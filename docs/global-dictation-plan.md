# Local dictation into other Mac applications

Status: integrated Mac prototype, 2026-10-13. The app now shares one SDK between call transcription and microphone-only dictation, with reciprocal model-level exclusion and modal file-panel reservation. Current implementation includes bounded capture, cancellation-aware permission wait, delayed undo, optional wake phrases, local rewriting, and an opt-in MCP snapshot. Compatibility and real audio acceptance remain separate gates; “any field” is a goal, not a demonstrated capability.

User choices: contextual paraphrasing is desired; **«Роки» and «Роки два» activate the same dictation mode**, never send a message. Optional recognition spellings include «Рокки» and “Rocky”; common «руки» is deliberately not accepted. Wake matching applies only to an anchored completed recognition result while the user has explicitly armed listening. Background utterances are not added to the draft or agent snapshot before activation. This is an ASR-based prototype, not a calibrated dedicated wake-word detector.

The local rewriter prefers Apple Foundation Models only when available and supporting the required locales, then an installed local Ollama model. On the development Mac Apple Intelligence is disabled and its framework does not support Russian; Qwen2.5 1.5B (about 986 MB) is therefore an optional cached local fallback. Rewrites have a two-second caller budget and conservative lexical checks. They can still change meaning: the original draft remains available, and sending is a separate action. No cloud rewriting is used.

The MCP adapter provides status and the explicitly shared revised draft on request. It does not itself wake Codex, inject a new turn, or send messages. See [local MCP bridge](local-mcp-bridge.md). Sharing is off by default.

## Product behavior

An explicit dictation session listens to the user's microphone through LocalSpeech SDK. A global start/stop shortcut lets the destination retain focus. The application panel shows the destination application, listening state, live draft, and errors. The first version previews partial hypotheses and commits completed utterances to a supported field. The next version may revise only the current session's owned text span while the field and surrounding text remain unchanged.

Changing destination, moving the caret, typing manually, losing permission, or receiving an unsupported editor response pauses insertion. Recognition may retain its pending draft for the user to review; late results must never follow focus into a different field. Selecting another destination requires an explicit resume. Stopping cancels pending rewrite work before draining the final recognition result to the original validated destination or the draft panel.

Default editing should preserve meaning: conservative whitespace, capitalization where justified, and punctuation. Preserve names, numbers, negation, URLs, technical identifiers, and RU/EN code-switching. Term preferences must not silently rewrite acoustically unsupported words. A local language model is a later, separately benchmarked option for more substantial rewriting; its rewrite must be visible and reversible. The user selected contextual rephrasing; the UI exposes a separate local-rewrite toggle and raw draft.

## Existing integration points

| Existing component | Reuse or required change |
| --- | --- |
| `SDKHost.swift` | Already accepts a channel list. Dictation uses `[.microphone]`, `speakerEnabled: false`, existing resource adaptation, cancellation, backpressure, and hidden-WebKit keepalive. One session owns the SDK at a time initially. |
| `CallModel.swift` | Currently owns SDK, capture, archive, and event callbacks. The dictation coordinator reserves access at model boundaries, temporarily routes callbacks, and restores them after capture, SDK and edits drain. Call transcription and dictation should be mutually exclusive in the first release. |
| `MacCallCapture.swift` | Always creates a ScreenCaptureKit system-audio stream. Do not reuse that stream for microphone-only dictation: a separate input source avoids unnecessary screen/audio permission and accidental transcription of another speaker or media. |
| `AudioPacketizer.swift` | Reuse owned PCM conversion/100 ms packet delivery into SDK. Audio callback must not block on Accessibility or text rewriting. |
| `CallScribeApp.swift` | Add mode entry, dictation status panel, and global shortcut lifecycle. Current last-window-close termination policy must be intentionally revised if a menu-bar session remains active. |
| `TranscriptArchive` | Do not automatically store unrelated external-field text or context in the call archive. Dictation drafts should be volatile by default. |

## Proposed components

1. **`DictationCoordinator`**: serial state machine (`idle`, `preparing`, `listening`, `paused`, `stopping`), session generation, SDK ownership, utterance deduplication, and explicit output routing. A final segment is committed at most once. Models warm before capture starts; preparation failure preserves the draft.
2. **`MicrophoneCapture`**: AVAudioEngine input tap, microphone authorization, device-change recovery, native-rate PCM into the existing packetizer. No system audio or speaker-identification work. Reuse the capture lifecycle and cancellation tests' patterns without changing the call capture implementation.
3. **`FocusedTextInsertion` actor**: Accessibility requests off the main actor, permission check, process/element identity, editable capabilities, role/subrole, selection, nearby text, and supported write mechanism. A 200 ms messaging timeout bounds individual AX operations, not the entire transaction. The initial adapter prefers an explicitly writable selected-text attribute. Its whole-value fallback accepts native text fields only and rejects web ancestors; text areas without a writable selected-text attribute stay preview-only. Invalid references and unsupported attributes produce an explicit unsupported state.
4. **`DictationEditTransaction`**: session/utterance IDs, original selection, before/after context, owned span, committed text, and inverse patch held in memory. Validate immediately before writing and read back afterward. Undo only if the exact owned span and surrounding context still match; never issue an unqualified global Undo command. Ambiguous write outcomes are not retried automatically.
5. **`LocalTextFormatter`**: deterministic, locale-aware minimal changes with raw recognition retained in the draft. Do not parse arbitrary dictated content as commands. An explicit command mode may later support scoped instructions such as replacing selected text or removing the last dictated utterance.
6. **`ContextRewriter`**, later: local-only optional inference using the current draft, explicit selection, bounded surrounding text, app identity, and user-selected style. Cancel by generation; enforce a latency budget; use the raw final utterance if rewriting times out. Field contents are data, never instructions to perform tools or send messages.
7. **`GlobalDictationHotKey` / status UI**: registered Cmd+Shift+D toggle without taking destination focus; unregister on shutdown. It uses Carbon `RegisterEventHotKey`, not global keyboard monitoring. A conflict returns a visible error. A configurable shortcut, clear listening indicator, Escape/cancel, and error recovery belong to the integration stage.

## Accessibility contract and limits

Apple supplies [AXUIElement attribute access](https://developer.apple.com/documentation/applicationservices/axuielement_h), [settable capability checks](https://developer.apple.com/documentation/applicationservices/1459972-axuielementisattributesettable), and [attribute writes](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue). Actual supported operations vary by application. These APIs establish feasibility; they do not prove compatibility with every editor.

The installed Apple SDK specifically documents `kAXSelectedTextAttribute` as **read-only** and `kAXSelectedTextRangeAttribute` as writable. Do not assume setting selected text inserts text. Query capabilities and test an adapter's actual behavior. Whole-value replacement is acceptable only in verified plain-text adapters that preserve text outside the selection; it must not silently flatten rich text. Accessibility does not expose a universal atomic compare-and-swap edit. Preflight validation and notifications reduce races but cannot eliminate them; concurrent mutation requires pausing and a draft fallback.

Block `AXSecureTextField` before requesting its value or context. Unknown roles, unknown secure state, read-only controls, and unsupported editors remain preview-only until a compatible adapter is verified. Neither clipboard copying nor synthetic keystrokes is an automatic escape hatch around an unreadable or protected field. Unsupported controls get a clear draft/manual-copy path. Never press Return/Send, submit a form, or invoke a terminal command as a side effect of dictation; terminals and executable command surfaces require a separately reviewed mode.

Use [AXIsProcessTrustedWithOptions](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions) for the Accessibility state and the normal OS permission flow only after the user enables this feature. Existing microphone or system-audio permission does not imply Accessibility access. Read only the active target during an explicit session, cap surrounding context, keep it in memory, and do not log it. [NSEvent global monitors](https://developer.apple.com/documentation/appkit/nsevent/addglobalmonitorforevents(matching:handler:)) only observe events and do not suppress the shortcut in the destination; a local monitor is additionally needed for events delivered to this app if that approach is used.

## Delivery stages and evidence

### 1. Working local draft mode

Implement microphone-only capture, shared SDK ownership, nonactivating live draft, explicit start/stop, and unit tests. This stage does not write to another application. Prove that call audio never enters dictation, SDK errors preserve the draft, late callbacks are ignored after stop, and a competing call cannot start.

### 2. Verified external-field insertion

Implement a native plain-text fixture first, then validate TextEdit plain text and browser `input`/`textarea` in Safari and Chromium. Test supported AX operations and native undo behavior rather than assuming them. Record app/OS versions and the adapter used. Add real editors (for example Electron chat composers) individually; unsupported contenteditable/rich-text fields remain preview-only. Test final insertion, explicit selection replacement, start in the middle of a document, punctuation/spacing, and line breaks without submission.

### 3. Contextual revisions

Enable replacement of the current owned span only for adapters that pass conflict and reversal tests. Partial hypotheses should remain in the overlay until field mutation behavior is proven. Add bounded context formatting, a visible original/revised comparison where meaning changes, and optional local LLM evaluation only after correction preferences and resource budget are decided. Do not put rewrite inference on the audio capture or ASR acknowledgement path.

### 4. Release qualification

Test explicit permission denial/revocation, app restart, hotkey conflict, destination termination, sleep/wake, input-device changes, overloaded CPU, and a 60-minute session with bounded memory. Measure microphone-to-first-draft, utterance-end-to-field-commit, rewrite latency, packet loss, and wrong-target writes separately. Targets must be declared before the run; no universal latency claim follows from the current call-transcription benchmark. Global insertion is releasable only with zero wrong-target/secure-field writes in the declared matrix, preserved surrounding text, bounded failure recovery, and clear compatibility limits.

## Required tests

- Pure transaction tests: stale generation, duplicate final events, conflicting manual edits, selection/caret movement, focus leaving and returning, app restart/PID reuse, failed readback, timeout after possible write, and cancellation during a pending rewrite.
- Unicode tests: UTF-16 AX ranges versus Swift string indices, emoji/ZWJ sequences, combining marks, Cyrillic, mixed RU/EN terms, multiline insertion, and reversed/invalid selections.
- Preservation tests: selected replacement changes only the declared span; inverse patch restores only our change; manual edits disable inverse patch; rich formatting is not overwritten by the plain-text adapter.
- Protected-field tests: native secure field, browser password input, invalid/unknown role, read-only field, web view with no exposed editor; no context read and no synthetic fallback.
- Capture/SDK tests: microphone denial, rapid start/stop, no audio leakage from the call channel, final packet flush, one SDK owner, rewrite load with ASR backpressure, and no saved call transcript for dictation context.
- UI tests with synthetic text/audio: switch target during an utterance and during commit; type by hand; modify text programmatically; revoke permission; close destination; verify the fallback draft and absence of duplicate insertions.

Source inspection and primary Apple documentation establish the architecture; external-field compatibility, hotkey behavior, undo semantics, and contextual rewrite quality remain untested. The initial adapter revalidates focus before writes; it cannot yet detect a focus excursion that leaves and returns to an unchanged target between commits. All stored field contents and edit history are volatile. Exact conflict checks require a bounded full field value (up to 100,000 UTF-16 code units); only 240 characters before/after the selection and 240 selected characters are exposed as rewrite context.
