import XCTest
@testable import CallScribe

final class RokiQwenStreamTests: XCTestCase {
    private func runtime(_ code: String) throws -> (RokiQwenRuntime, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try code.write(to: root.appendingPathComponent("stream.py"), atomically: true, encoding: .utf8)
        return (RokiQwenRuntime(python: URL(fileURLWithPath: "/usr/bin/python3"), model: root, script: root.appendingPathComponent("synthesize.py")), root)
    }
    @MainActor func testResidentWorkerReusedAndChunksArriveBeforeEnd() async throws {
        let (runtime, root) = try runtime("""
        import sys,json,base64,time
        print(json.dumps({'type':'ready'}),flush=True)
        for line in sys.stdin:
            r=json.loads(line)
            assert r['text']=='literal $HOME; `echo no`'
            for i in range(2):
                print(json.dumps({'type':'chunk','id':r['id'],'rate':24000,'index':i,'pcm':base64.b64encode(b'\\x00\\x10'*800).decode()}),flush=True)
                time.sleep(.05)
            print(json.dumps({'type':'end','id':r['id'],'chunks':2}),flush=True)
        """)
        let worker = RokiQwenStream(runtime: runtime)
        defer { worker.shutdown(); try? FileManager.default.removeItem(at: root) }
        var readyEvents = 0
        worker.onState = { if worker.ready { readyEvents += 1 } }
        for _ in 0..<2 {
            let finished = expectation(description: "stream complete"), first = expectation(description: "first chunk")
            var chunks = 0
            worker.synthesize(text: "literal $HOME; `echo no`", language: "English") { event in
                switch event {
                case .pcm(let data, let rate): XCTAssertEqual(rate, 24000); XCTAssertEqual(data.count, 1600); chunks += 1; if chunks == 1 { first.fulfill() }
                case .end: XCTAssertEqual(chunks, 2); finished.fulfill()
                case .failure: XCTFail("unexpected failure"); finished.fulfill()
                }
            }
            await fulfillment(of: [first, finished], timeout: 4, enforceOrder: true)
            XCTAssertTrue(worker.ready)
        }
        XCTAssertEqual(readyEvents, 1, "Second utterance must reuse the resident process")
        worker.onState = nil
    }
    @MainActor func testWrongIDMalformedPCMAndOutOfOrderChunksFail() async throws {
        for payload in ["{'type':'chunk','id':'wrong','rate':24000,'index':0,'pcm':'ABAAEA=='}", "{'type':'chunk','id':r['id'],'rate':24000,'index':1,'pcm':'ABAAEA=='}", "{'type':'chunk','id':r['id'],'rate':24000,'index':0,'pcm':'bad'}", "{'type':'end','id':r['id'],'chunks':0}"] {
            let (runtime, root) = try runtime("import sys,json\nprint('{\"type\":\"ready\"}',flush=True)\nr=json.loads(sys.stdin.readline())\nprint(json.dumps(\(payload)),flush=True)\n")
            let worker = RokiQwenStream(runtime: runtime)
            defer { worker.shutdown(); try? FileManager.default.removeItem(at: root) }
            let failed = expectation(description: "invalid protocol")
            worker.synthesize(text: "test", language: "English") { event in
                if case .failure = event { failed.fulfill() } else { XCTFail("Malformed stream accepted") }
            }
            await fulfillment(of: [failed], timeout: 4)
            XCTAssertFalse(worker.ready)
        }
    }
    @MainActor func testTimeoutAndCancelIgnoreLateAudioAndShutdown() async throws {
        let (runtime, root) = try runtime("import sys,json,time\nprint('{\"type\":\"ready\"}',flush=True)\nsys.stdin.readline()\ntime.sleep(20)\n")
        defer { try? FileManager.default.removeItem(at: root) }
        let worker = RokiQwenStream(runtime: runtime, requestTimeout: 0.1)
        defer { worker.shutdown() }
        let failed = expectation(description: "bounded timeout")
        worker.synthesize(text: "test", language: "English") { event in
            if case .failure(let error) = event { XCTAssertEqual(error as? RokiQwenError, .timeout); failed.fulfill() }
        }
        await fulfillment(of: [failed], timeout: 4)
        var callbacks = 0
        worker.synthesize(text: "cancel", language: "English") { _ in callbacks += 1 }
        worker.cancel()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(callbacks, 0)
        worker.shutdown(); XCTAssertFalse(worker.ready); XCTAssertFalse(worker.warming)
    }
    @MainActor func testOversizedLineIsBounded() async throws {
        let (runtime, root) = try runtime("import sys,time\nsys.stdout.write('x'*140000);sys.stdout.flush();time.sleep(20)")
        let worker = RokiQwenStream(runtime: runtime)
        defer { worker.shutdown(); try? FileManager.default.removeItem(at: root) }
        let failed = expectation(description: "bounded output")
        worker.synthesize(text: "test", language: "English") { event in if case .failure = event { failed.fulfill() } }
        await fulfillment(of: [failed], timeout: 4)
    }
}
