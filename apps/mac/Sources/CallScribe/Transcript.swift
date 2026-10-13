import Foundation

enum AudioChannel: String, CaseIterable, Codable, Sendable {
    case microphone, call
    var title: String { self == .microphone ? "Я" : "Собеседники" }
}
struct TranscriptLine: Identifiable, Codable, Equatable {
    let id: String
    let channel: AudioChannel
    let seconds: Double
    let text: String
    var speaker: VoiceAttribution?
    var speakerLabel: String { speaker.map { channel.title + " · " + $0.label } ?? channel.title }
}
struct TranscriptDocument: Codable {
    var id = UUID().uuidString
    var createdAt = Date()
    var title = "Созвон"
    var lines: [TranscriptLine] = []
    var durationSeconds: Double?
    mutating func append(channel: AudioChannel, session: String, segment: Int, seconds: Double, text: String) {
        let key = channel.rawValue + ":" + session + ":" + String(segment)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !lines.contains(where: { $0.id == key }) else { return }
        let time = seconds.isFinite ? max(0, seconds) : 0
        let index = lines.firstIndex { $0.seconds > time } ?? lines.endIndex
        lines.insert(TranscriptLine(id: key, channel: channel, seconds: time, text: text), at: index)
    }
    mutating func attribute(id: String, speaker: VoiceAttribution) {
        guard let index = lines.firstIndex(where: { $0.id == id }) else { return }
        lines[index].speaker = speaker
    }
    var plainText: String {
        title + "\n\n" + lines.map { "[" + Self.timestamp($0.seconds) + "] " + $0.speakerLabel + ": " + $0.text + (($0.speaker?.intervals?.count ?? 0) > 1 ? "\nГолоса по времени:\n" + ($0.speaker?.timeline(baseSeconds: $0.seconds) ?? "") : "") }.joined(separator: "\n\n")
    }
    static func timestamp(_ seconds: Double) -> String {
        let s = Int(max(0, seconds)); return String(format: "%02d:%02d", s / 60, s % 60)
    }
}

final class TranscriptArchive {
    let directory: URL
    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("LocalSpeech Calls/Sessions")
    }
    func save(_ document: TranscriptDocument) throws {
        guard UUID(uuidString: document.id) != nil else { throw CocoaError(.fileWriteInvalidFileName) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent(document.id + ".json")
        try JSONEncoder().encode(document).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    func latest() -> TranscriptDocument? {
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return nil }
        return files.filter { $0.pathExtension == "json" }.sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }.compactMap { try? JSONDecoder().decode(TranscriptDocument.self, from: Data(contentsOf: $0)) }.first.map { document in
            var restored = document
            for index in restored.lines.indices where restored.lines[index].speaker?.kind == "pending" {
                restored.lines[index].speaker = VoiceAttribution(label: "Голос не определён", kind: "uncertain", speakerId: nil)
            }
            return restored
        }
    }
}
