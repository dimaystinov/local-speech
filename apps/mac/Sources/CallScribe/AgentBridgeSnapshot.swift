import Foundation

/// Opt-in, leased local IPC. Never exposes field context or call archives.
@MainActor final class AgentBridgeSnapshot {
    private let directory: URL
    private var file: URL { directory.appendingPathComponent("dictation-bridge.json") }
    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LocalSpeech/AgentBridge", isDirectory: true)
    }
    func write(session: UUID, status: String, raw: String, text: String) throws {
        let manager = FileManager.default
        // Do not follow a replaced IPC directory into another location.
        for url in [directory.deletingLastPathComponent(), directory, file] where manager.fileExists(atPath: url.path) {
            if try url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true { throw CocoaError(.fileWriteNoPermission) }
        }
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "enabled": true,
            "sessionId": session.uuidString, "status": String(status.prefix(256)),
            "rawText": Self.bounded(raw), "text": Self.bounded(text),
            "updatedAt": ISO8601DateFormatter().string(from: Date())])
        let temporary = directory.appendingPathComponent(".snapshot-" + UUID().uuidString)
        defer { try? manager.removeItem(at: temporary) }
        guard manager.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
        if rename(temporary.path, file.path) != 0 { throw CocoaError(.fileWriteUnknown) }
    }
    func clear() {
        for url in [directory.deletingLastPathComponent(), directory] {
            guard (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true else { return }
        }
        try? FileManager.default.removeItem(at: file)
    }
    nonisolated static func bounded(_ input: String) -> String {
        var output = "", length = 0
        for character in input {
            let units = String(character).utf16.count
            guard length + units <= 32_000 else { break }
            output.append(character); length += units
        }
        return output
    }
}
