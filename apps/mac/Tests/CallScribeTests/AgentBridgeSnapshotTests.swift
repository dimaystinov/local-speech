import XCTest
@testable import CallScribe

final class AgentBridgeSnapshotTests: XCTestCase {
    @MainActor func testPrivateAtomicSnapshotAndClear() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("AgentBridge"), bridge = AgentBridgeSnapshot(directory: directory)
        let id = UUID()
        try bridge.write(session: id, status: "listening", raw: "сырая фраза", text: "Готовая фраза.")
        let file = directory.appendingPathComponent("dictation-bridge.json")
        let data = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        XCTAssertEqual(data["sessionId"] as? String, id.uuidString)
        XCTAssertEqual(data["text"] as? String, "Готовая фраза.")
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        try bridge.write(session: id, status: "idle", raw: "", text: "")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["dictation-bridge.json"])
        bridge.clear(); XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
    func testUTF16LimitKeepsEmojiIntact() {
        let value = AgentBridgeSnapshot.bounded(String(repeating: "👨‍💻", count: 10_000))
        XCTAssertLessThanOrEqual(value.utf16.count, 32_000)
        XCTAssertTrue(value.hasSuffix("👨‍💻"))
    }
    @MainActor func testSymlinkDirectoryCannotWriteOrClearTarget() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let target = root.appendingPathComponent("target"), link = root.appendingPathComponent("AgentBridge")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        let sentinel = target.appendingPathComponent("dictation-bridge.json")
        try Data("unchanged".utf8).write(to: sentinel)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let bridge = AgentBridgeSnapshot(directory: link)
        XCTAssertThrowsError(try bridge.write(session: UUID(), status: "idle", raw: "", text: ""))
        bridge.clear(); XCTAssertEqual(try String(contentsOf: sentinel, encoding: .utf8), "unchanged")
    }
}
