import Foundation

struct VoiceProfile: Codable, Identifiable {
    static let model = "wespeaker-resnet34-lm-q8@6a61a1833ff2583aabeba044f5c8221f00b67ceb"
    let id: String
    let name: String
    let modelId: String
    let embedding: [Float]
    var valid: Bool {
        UUID(uuidString: id) != nil && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 80 &&
        !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) && modelId == Self.model && embedding.count == 256 &&
        embedding.allSatisfy(\.isFinite) && abs(embedding.reduce(0) { $0 + $1 * $1 } - 1) < 0.02
    }
}
struct VoiceAttribution: Codable, Equatable {
    let label: String
    let kind: String
    let speakerId: String?
}
final class VoiceProfileStore {
    let file: URL
    init(file: URL? = nil) {
        self.file = file ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("LocalSpeech Calls/voices.json")
    }
    func load() throws -> [VoiceProfile] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: 2_000_001) ?? Data()
        guard data.count <= 2_000_000 else { throw CocoaError(.fileReadCorruptFile) }
        let profiles = try JSONDecoder().decode([VoiceProfile].self, from: data)
        guard profiles.count <= 100, profiles.allSatisfy(\.valid), Set(profiles.map(\.id)).count == profiles.count else { throw CocoaError(.fileReadCorruptFile) }
        return profiles
    }
    func save(_ profiles: [VoiceProfile]) throws {
        guard profiles.count <= 100, profiles.allSatisfy(\.valid), Set(profiles.map(\.id)).count == profiles.count else { throw CocoaError(.fileWriteInvalidFileName) }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(profiles).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
