import XCTest
@testable import CallScribe

final class RokiQwenTests: XCTestCase {
    private func fixture(_ code: String) throws -> (RokiQwenRuntime, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let script = directory.appendingPathComponent("worker.py")
        try code.write(to: script, atomically: true, encoding: .utf8)
        return (RokiQwenRuntime(python: URL(fileURLWithPath: "/usr/bin/python3"), model: directory, script: script), directory)
    }
    private func result(_ job: RokiQwenJob, text: String = "Тест", language: String = "Russian") async -> Result<RokiAudioClip, Error> {
        await withCheckedContinuation { continuation in
            job.start(text: text, language: language) { continuation.resume(returning: $0) }
        }
    }
    func testUnavailableDoesNotFallbackToAnotherVoice() async {
        let value = await result(RokiQwenJob(runtime: nil))
        if case .failure(let error) = value { XCTAssertEqual(error as? RokiQwenError, .unavailable) }
        else { XCTFail("Missing Qwen must be explicit") }
    }
    func testInvalidInputAndLanguageRejected() async {
        for (text, language) in [("", "Russian"), ("test", "Russian; exit"), (String(repeating: "a", count: 601), "English")] {
            let value = await result(RokiQwenJob(runtime: nil), text: text, language: language)
            if case .failure(let error) = value { XCTAssertEqual(error as? RokiQwenError, .invalidInput) }
            else { XCTFail("Invalid input was accepted") }
        }
    }
    func testPlainTextJSONAndWAVProtocol() async throws {
        let (runtime, directory) = try fixture("""
        import json,sys,wave,io,struct
        request=json.load(sys.stdin)
        assert request['text']=='$HOME; `echo never`', request
        out=io.BytesIO()
        with wave.open(out,'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes(struct.pack('<h',5000)*1600)
        sys.stdout.buffer.write(out.getvalue())
        """)
        defer { try? FileManager.default.removeItem(at: directory) }
        let clip = try await result(RokiQwenJob(runtime: runtime), text: "$HOME; `echo never`").get()
        XCTAssertEqual(clip.duration, 0.1, accuracy: 0.001)
        XCTAssertTrue(clip.levels.contains { $0 > 0 })
    }
    func testMalformedWorkerOutputRejected() async throws {
        let (runtime, directory) = try fixture("print('not a WAV')")
        defer { try? FileManager.default.removeItem(at: directory) }
        let value = await result(RokiQwenJob(runtime: runtime))
        if case .failure(let error) = value { XCTAssertEqual(error as? RokiQwenError, .failed) }
        else { XCTFail("Invalid output was accepted") }
    }
    func testTimeoutAndInFlightCancellation() async throws {
        let (runtime, directory) = try fixture("import time; time.sleep(20)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let timed = await result(RokiQwenJob(runtime: runtime, deadlineSeconds: 0.1))
        if case .failure(let error) = timed { XCTAssertEqual(error as? RokiQwenError, .timeout) }
        else { XCTFail("Timeout must fail") }
        let job = RokiQwenJob(runtime: runtime)
        let task = Task { await result(job) }
        try await Task.sleep(nanoseconds: 100_000_000)
        job.cancel()
        let cancelled = await task.value
        if case .failure(let error) = cancelled { XCTAssertEqual(error as? RokiQwenError, .cancelled) }
        else { XCTFail("Cancellation must fail") }
    }
}
