import Foundation
import Darwin

/// Private, bounded IPC for explicit MCP speech actions. No microphone or field access.
/// Use a pinned directory descriptor and openat: never follow request symlinks.
final class RokiBridgeFiles {
    let directory: URL
    private let fd: Int32
    init(directory: URL) throws {
        self.directory = directory
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard directory.standardizedFileURL.path == directory.resolvingSymlinksInPath().path else { throw CocoaError(.fileReadNoPermission) }
        fd = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw CocoaError(.fileReadNoPermission) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw CocoaError(.fileReadNoPermission) }
    }
    deinit { close(fd) }
    func read(_ name: String) -> Data? {
        let file = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard file >= 0 else { return nil }
        defer { close(file) }
        var info = stat()
        guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_nlink == 1,
              info.st_size > 0, info.st_size <= 16384 else { return nil }
        var bytes = [UInt8](repeating: 0, count: Int(info.st_size) + 1)
        let count = Darwin.read(file, &bytes, bytes.count)
        guard count == info.st_size else { return nil }
        return Data(bytes.prefix(count))
    }
    func write(_ name: String, _ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        let temp = ".voice-" + UUID().uuidString
        let file = openat(fd, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard file >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { close(file); unlinkat(fd, temp, 0) }
        let count = data.withUnsafeBytes { Darwin.write(file, $0.baseAddress, $0.count) }
        guard count == data.count, renameat(fd, temp, fd, name) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
    func remove(_ name: String) { unlinkat(fd, name, 0) }
    func names() -> [String] {
        // This pathname is only used for inventory; all file operations use the pinned fd.
        (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    }
}

@MainActor final class RokiVoiceBridge {
    nonisolated static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/LocalSpeech/RokiMCP")
    }
    private let voice: RokiVoice
    var qwenAvailable: () -> Bool = { RokiQwenRuntime.installed() != nil }
    private let directory: URL
    private var files: RokiBridgeFiles?
    private var timer: Timer?
    private var session = UUID().uuidString
    private var results: [String: [String: Any]] = [:]
    private var order: [String] = []
    private var activeID: String?
    private struct PendingSpeech { let id: String; let text: String; let emotion: RokiEmotion? }
    private var speechQueue: [PendingSpeech] = []
    private var lastPublish = Date.distantPast
    private(set) var error: String?
    var enabled: Bool { files != nil }
    init(voice: RokiVoice, directory: URL = RokiVoiceBridge.directory) { self.voice = voice; self.directory = directory }

    func start() {
        guard files == nil else { return }
        do {
            let store = try RokiBridgeFiles(directory: directory)
            // Old commands must never play after a restart; only this protocol's files are removed.
            for name in store.names() where Self.ownedFile(name) { store.remove(name) }
            files = store; session = UUID().uuidString; error = nil
            voice.warmVoice()
            try publish()
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        } catch { self.error = "Не удалось открыть мост голоса MCP."; files = nil }
    }
    func stop() {
        timer?.invalidate(); timer = nil
        if let activeID, voice.purpose == "mcp:" + activeID { voice.stop() }
        if let files { for name in files.names() where Self.ownedFile(name) { files.remove(name) } }
        files = nil; activeID = nil; results.removeAll(); order.removeAll()
        speechQueue.removeAll()
        voice.streamWorker.shutdown()
    }
    static func ownedFile(_ name: String) -> Bool {
        if name == "status.json" { return true }
        for prefix in ["request-", "reply-", ".voice-"] where name.hasPrefix(prefix) {
            let tail = String(name.dropFirst(prefix.count))
            let id = prefix == ".voice-" ? tail : String(tail.dropLast(5))
            if (prefix == ".voice-" || tail.hasSuffix(".json")), UUID(uuidString: id) != nil { return true }
        }
        return false
    }
    private func envelope(_ value: [String: Any]) -> [String: Any] {
        value.merging(["version": 1, "sessionId": session, "updatedAt": Date().timeIntervalSince1970 * 1000]) { _, new in new }
    }
    private func publish() throws {
        let state = voice.preparing ? "preparing" : voice.speaking ? "speaking" : voice.paused ? "paused" : "idle"
        var status: [String: Any] = ["enabled": true, "state": state, "engine": voice.style.rawValue,
            "profile": "roki-composed-01b", "qwenAvailable": qwenAvailable(),
            "canSpeak": voice.canSpeak(), "duration": voice.duration, "playbackTime": voice.playbackTime,
            "mouthLevel": voice.mouthLevel]
        status["warmReady"] = voice.warmReady; status["warming"] = voice.warming
        status["streaming"] = true; status["generating"] = voice.streamGenerating
        status["underruns"] = voice.streamUnderruns
        status["queued"] = speechQueue.count
        if let latency = voice.firstAudioMs { status["firstAudioMs"] = latency }
        if let activeID { status["requestId"] = activeID }
        if let error = voice.error { status["error"] = error }
        try files?.write("status.json", envelope(status)); lastPublish = Date()
    }
    private func save(_ id: String, _ value: [String: Any]) throws {
        let result = envelope(value.merging(["requestId": id]) { _, new in new })
        results[id] = result
        order.removeAll { $0 == id }; order.append(id)
        while order.count > 32 {
            guard let index = order.firstIndex(where: { candidate in candidate != activeID && !speechQueue.contains(where: { $0.id == candidate }) }) else { break }
            let old = order.remove(at: index); results.removeValue(forKey: old); files?.remove("reply-\(old).json")
        }
        try files?.write("reply-\(id).json", result)
    }
    private func updateActive() throws {
        guard let id = activeID else { return }
        let state: String
        if voice.purpose != "mcp:" + id { state = voice.error == nil ? (voice.lastFinishedPurpose == "mcp:" + id ? "completed" : "stopped") : "failed" }
        else { state = voice.preparing ? "preparing" : voice.paused ? "paused" : "speaking" }
        if results[id]?["state"] as? String != state {
            var value: [String: Any] = ["state": state]
            if state == "failed", let error = voice.error { value["error"] = error }
            try save(id, value)
        }
        if ["completed", "stopped", "failed"].contains(state) {
            activeID = nil
            if state != "completed" { try clearQueued() }
        }
    }
    private func clearQueued() throws {
        let cancelled = speechQueue; speechQueue.removeAll()
        for item in cancelled { try save(item.id, ["state": "stopped"]) }
    }
    private func startSpeech(_ item: PendingSpeech) throws {
        voice.style = .qwen
        voice.speak(item.text, emotion: item.emotion, purpose: "mcp:" + item.id)
        activeID = item.id
        try save(item.id, ["state": voice.preparing ? "preparing" : "failed"])
    }
    private func drainQueue() throws {
        guard activeID == nil, !speechQueue.isEmpty else { return }
        guard !voice.busy, voice.canSpeak() else { try clearQueued(); return }
        try startSpeech(speechQueue.removeFirst())
    }
    func tick() {
        guard let files else { return }
        do {
            try updateActive()
            // Bounded per tick. Stops have priority over newly submitted speech.
            let pending = files.names().filter { $0.hasPrefix("request-") && Self.ownedFile($0) }.sorted().prefix(32)
            var requests: [(String, [String: Any])] = []
            for name in pending {
                guard let data = files.read(name), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { files.remove(name); continue }
                requests.append((name, value))
            }
            requests.sort {
                let leftStop = $0.1["action"] as? String == "stop", rightStop = $1.1["action"] as? String == "stop"
                if leftStop != rightStop { return leftStop }
                return ($0.1["createdAt"] as? Double ?? 0) < ($1.1["createdAt"] as? Double ?? 0)
            }
            let stoppedThisTick = requests.contains { $0.1["action"] as? String == "stop" && $0.1["sessionId"] as? String == session }
            for (name, value) in requests {
                files.remove(name)
                try handle(value, filename: name, suppressSpeak: stoppedThisTick)
            }
            try updateActive()
            try drainQueue()
            if voice.busy || !requests.isEmpty || Date().timeIntervalSince(lastPublish) >= 2 { try publish() }
        } catch { self.error = "Ошибка обмена с MCP. Мост отключён."; stop() }
    }
    private func handle(_ value: [String: Any], filename: String, suppressSpeak: Bool) throws {
        guard let id = value["requestId"] as? String, UUID(uuidString: id) != nil, filename == "request-\(id).json",
              value["sessionId"] as? String == session,
              let created = value["createdAt"] as? Double, created.isFinite,
              abs(Date().timeIntervalSince1970 * 1000 - created) <= 10000 else { return }
        if let previous = results[id] { try files?.write("reply-\(id).json", previous); return }
        guard Set(value.keys).isSubset(of: ["version", "requestId", "sessionId", "createdAt", "action", "text", "emotion"]),
              value["version"] as? Int == 1, let action = value["action"] as? String, ["speak", "stop"].contains(action) else {
            try save(id, ["state": "rejected", "error": "Invalid voice command"]); return
        }
        if action == "stop" {
            try clearQueued()
            if let activeID, voice.purpose == "mcp:" + activeID { voice.stop() }
            try updateActive(); try save(id, ["state": "stopped"]); return
        }
        guard let text = value["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.unicodeScalars.count <= 600, !text.unicodeScalars.contains(where: { $0.value < 32 && $0.value != 10 && $0.value != 9 }),
              value["emotion"] == nil || (value["emotion"] as? String).flatMap(RokiEmotion.init(rawValue:)) != nil else {
            try save(id, ["state": "rejected", "error": "Expected text of 1–600 characters and a supported emotion"]); return
        }
        guard !suppressSpeak, voice.canSpeak() else { try save(id, ["state": "rejected", "error": "Audio is busy. Stop recording or wait for speech to finish."]); return }
        guard qwenAvailable() else { try save(id, ["state": "rejected", "error": "Selected local Qwen voice is not installed"]); return }
        let item = PendingSpeech(id: id, text: text, emotion: (value["emotion"] as? String).flatMap(RokiEmotion.init(rawValue:)))
        if voice.busy || !speechQueue.isEmpty {
            guard (!voice.busy || activeID != nil), speechQueue.count < 8 else { try save(id, ["state": "rejected", "error": "Voice is busy or the eight-fragment queue is full"]); return }
            speechQueue.append(item); try save(id, ["state": "queued"])
        } else { try startSpeech(item) }
    }
}
