import XCTest
@testable import CallScribe
final class VoiceProfileTests: XCTestCase {
    func testProfilesSurviveReloadAndRejectWrongModel() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("voices.json")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = VoiceProfileStore(file: url)
        var vector = [Float](repeating: 0, count: 256); vector[0] = 1
        let profile = VoiceProfile(id: UUID().uuidString, name: "Тестовый голос", modelId: VoiceProfile.model, embedding: vector)
        try store.save([profile]); XCTAssertEqual(try store.load().first?.id, profile.id)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertThrowsError(try store.save([VoiceProfile(id: profile.id, name: profile.name, modelId: "wrong", embedding: vector)]))
        XCTAssertThrowsError(try store.save([profile, profile]))
        try store.save([]); XCTAssertTrue(try store.load().isEmpty)
    }
    func testSpeakerAnnotationKeepsRawTextAndIsExported() {
        var doc = TranscriptDocument()
        doc.append(channel: .call, session: "s", segment: 1, seconds: 2, text: "Не удаляйте 15 файлов")
        doc.attribute(id: "call:s:1", speaker: VoiceAttribution(label: "Анна", kind: "known", speakerId: "p1"))
        XCTAssertEqual(doc.lines[0].text, "Не удаляйте 15 файлов")
        XCTAssertTrue(doc.plainText.contains("Собеседники · Анна"))
    }
    func testOversizedProfileFileIsRejected() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(repeating: 32, count: 2_000_001).write(to: url)
        XCTAssertThrowsError(try VoiceProfileStore(file: url).load())
    }
    func testPendingAttributionIsNotRestoredAsRunning() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let archive = TranscriptArchive(directory: dir)
        var doc = TranscriptDocument()
        doc.append(channel: .call, session: "s", segment: 1, seconds: 0, text: "Фраза")
        doc.attribute(id: "call:s:1", speaker: VoiceAttribution(label: "Определяется голос…", kind: "pending", speakerId: nil))
        try archive.save(doc)
        XCTAssertEqual(archive.latest()?.lines.first?.speaker?.kind, "uncertain")
        XCTAssertEqual(archive.latest()?.lines.first?.text, "Фраза")
    }

}
