import XCTest
@testable import CallScribe

final class RokiVoiceBridgeTests: XCTestCase {
    @MainActor private func fixture() throws -> (RokiVoice, RokiVoiceBridge, URL) {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        let voice = RokiVoice(), bridge = RokiVoiceBridge(voice: voice, directory: root)
        bridge.start(); XCTAssertTrue(bridge.enabled); return (voice, bridge, root)
    }
    private func read(_ root: URL, _ name: String) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent(name))) as! [String: Any]
    }
    @MainActor private func request(_ root: URL, _ bridge: RokiVoiceBridge, _ extra: [String: Any], id: String = UUID().uuidString) throws -> String {
        let status = try read(root, "status.json")
        var value: [String: Any] = ["version": 1, "sessionId": status["sessionId"]!, "requestId": id, "createdAt": Date().timeIntervalSince1970 * 1000]
        value.merge(extra) { _, new in new }
        let file = root.appendingPathComponent("request-\(id).json")
        FileManager.default.createFile(atPath: file.path, contents: try JSONSerialization.data(withJSONObject: value), attributes: [.posixPermissions: 0o600])
        bridge.tick(); return id
    }
    @MainActor func testOptInPrivateStatusAndExclusiveOwnership() throws {
        let (_, bridge, root) = try fixture()
        defer { bridge.stop(); try? FileManager.default.removeItem(at: root) }
        let status = try read(root, "status.json")
        XCTAssertEqual(status["state"] as? String, "idle")
        XCTAssertNil(status["text"])
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("status.json").path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let second = RokiVoiceBridge(voice: RokiVoice(), directory: root); second.start(); XCTAssertFalse(second.enabled)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("status.json").path))
        bridge.stop(); XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("status.json").path))
    }
    @MainActor func testStaleSessionAndExpiredCommandsNeverSpeak() throws {
        let (voice, bridge, root) = try fixture()
        defer { bridge.stop(); try? FileManager.default.removeItem(at: root) }
        for extra: [String: Any] in [["sessionId": UUID().uuidString], ["createdAt": 1.0]] {
            let id = try request(root, bridge, ["action": "speak", "text": "Never speak"].merging(extra) { _, new in new })
            XCTAssertFalse(voice.busy)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("reply-\(id).json").path))
        }
    }
    @MainActor func testBusyRecordingInvalidArgumentsAndMissingModelRejected() throws {
        let (voice, bridge, root) = try fixture()
        defer { bridge.stop(); try? FileManager.default.removeItem(at: root) }
        for extra: [String: Any] in [["text": ""], ["text": String(repeating: "x", count: 601)], ["text": "valid", "emotion": "unknown"], ["text": "valid", "command": "run"]] {
            let id = try request(root, bridge, ["action": "speak"].merging(extra) { _, new in new })
            XCTAssertEqual(try read(root, "reply-\(id).json")["state"] as? String, "rejected")
            XCTAssertFalse(voice.busy)
        }
        voice.canSpeak = { false }
        let busy = try request(root, bridge, ["action": "speak", "text": "Hello"])
        XCTAssertTrue((try read(root, "reply-\(busy).json")["error"] as? String)?.contains("busy") == true)
        voice.canSpeak = { true }; bridge.qwenAvailable = { false }
        let missing = try request(root, bridge, ["action": "speak", "text": "Hello"])
        XCTAssertTrue((try read(root, "reply-\(missing).json")["error"] as? String)?.contains("not installed") == true)
    }
    @MainActor func testAcceptedJobDuplicateStopAndNoLateRestart() async throws {
        let (voice, bridge, root) = try fixture(), old = voice.style
        defer { bridge.stop(); voice.style = old; try? FileManager.default.removeItem(at: root) }
        let script = root.appendingPathComponent("slow.py")
        try "import time; time.sleep(20)".write(to: script, atomically: true, encoding: .utf8)
        let runtime = RokiQwenRuntime(python: URL(fileURLWithPath: "/usr/bin/python3"), model: root, script: script)
        var starts = 0
        voice.makeQwenJob = { starts += 1; return RokiQwenJob(runtime: runtime) }; bridge.qwenAvailable = { true }
        let id = try request(root, bridge, ["action": "speak", "text": "Hello"])
        XCTAssertTrue(voice.preparing)
        _ = try request(root, bridge, ["action": "speak", "text": "Hello"], id: id)
        XCTAssertEqual(starts, 1)
        let other = try request(root, bridge, ["action": "speak", "text": "Second"])
        XCTAssertEqual(try read(root, "reply-\(other).json")["state"] as? String, "queued")
        var queued = [other]
        for _ in 0..<7 { queued.append(try request(root, bridge, ["action": "speak", "text": "Queued sentence"])) }
        for _ in 0..<35 {
            let overflow = try request(root, bridge, ["action": "speak", "text": "Must not overflow"])
            XCTAssertEqual(try read(root, "reply-\(overflow).json")["state"] as? String, "rejected")
        }
        XCTAssertEqual(try read(root, "reply-\(id).json")["state"] as? String, "preparing")
        for item in queued { XCTAssertEqual(try read(root, "reply-\(item).json")["state"] as? String, "queued") }
        _ = try request(root, bridge, ["action": "stop"])
        XCTAssertEqual(try read(root, "reply-\(id).json")["state"] as? String, "stopped")
        XCTAssertEqual(try read(root, "reply-\(other).json")["state"] as? String, "stopped")
        for item in queued { XCTAssertEqual(try read(root, "reply-\(item).json")["state"] as? String, "stopped") }
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertFalse(voice.busy)
        bridge.stop(); bridge.start()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("reply-\(id).json").path))
    }
    @MainActor func testSymlinkRequestIsDiscardedWithoutReadingOrChangingTarget() throws {
        let (voice, bridge, root) = try fixture()
        defer { bridge.stop(); try? FileManager.default.removeItem(at: root) }
        let target = root.appendingPathComponent("keep.txt"), name = "request-\(UUID().uuidString).json"
        try "unchanged".write(to: target, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent(name), withDestinationURL: target)
        bridge.tick(); XCTAssertFalse(voice.busy)
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "unchanged")
    }
}
