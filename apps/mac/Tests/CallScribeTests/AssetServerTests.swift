import XCTest
import Foundation
@testable import CallScribe

final class AssetServerTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("asset-server-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("sdk"), withIntermediateDirectories: true)
        try Data("<html>bridge</html>".utf8).write(to: root.appendingPathComponent("bridge.html"))
        try Data("export const ok = true;".utf8).write(to: root.appendingPathComponent("bridge.js"))
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func request(_ line: String = "GET / HTTP/1.1", headers: String = "Host: 127.0.0.1:1234") -> Data {
        Data("\(line)\r\n\(headers)\r\n\r\n".utf8)
    }

    func testRootAndQueryResolveToBundledFiles() throws {
        let root = try fixture()
        XCTAssertEqual(try AssetRequest.resolve(root: root, target: "/"), root.appendingPathComponent("bridge.html").resolvingSymlinksInPath())
        XCTAssertEqual(try AssetRequest.resolve(root: root, target: "/bridge.js?v=1").lastPathComponent, "bridge.js")
        XCTAssertEqual(try AssetRequest.resolve(root: root, target: "/%62ridge.js").lastPathComponent, "bridge.js")
    }

    func testTraversalMalformedAndHiddenPathsAreRejected() throws {
        let root = try fixture()
        for target in ["/../bridge.html", "/%2e%2e/bridge.html", "/sdk/%2e%2e/bridge.html", "/sdk%2f..%2fbridge.html",
                       "/%00", "/%ZZ", "/sdk\\..\\bridge.html", "/.secret", "//elsewhere/bridge.html", "http://evil/bridge.html", "/bridge.html#fragment"] {
            XCTAssertThrowsError(try AssetRequest.resolve(root: root, target: target), target)
        }
        XCTAssertThrowsError(try AssetRequest.resolve(root: root, target: "/sdk"))
        XCTAssertThrowsError(try AssetRequest.resolve(root: root, target: "/missing"))
    }

    func testSymlinkReturningInsideRootIsAllowed() throws {
        let root = try fixture()
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("outside"), withDestinationURL: root.deletingLastPathComponent())
        XCTAssertEqual(try AssetRequest.resolve(root: root, target: "/outside/\(root.lastPathComponent)/bridge.html"),
                       root.appendingPathComponent("bridge.html").resolvingSymlinksInPath())
    }

    func testSymlinkOutsideRootIsForbidden() throws {
        let root = try fixture()
        let outside = root.deletingLastPathComponent().appendingPathComponent("outside-\(UUID().uuidString).txt")
        try Data("not bundled".utf8).write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape.txt"), withDestinationURL: outside)
        XCTAssertThrowsError(try AssetRequest.resolve(root: root, target: "/escape.txt")) { error in
            XCTAssertEqual((error as? AssetHTTPError)?.status, 403)
        }
    }

    func testHostOriginAndRequestBodyValidation() throws {
        let root = try fixture()
        XCTAssertFalse(try AssetRequest.parse(request(), root: root, port: 1234).headOnly)
        XCTAssertTrue(try AssetRequest.parse(request("HEAD / HTTP/1.1", headers: "Host: localhost:1234\r\nOrigin: http://localhost:1234"), root: root, port: 1234).headOnly)
        for headers in ["Host: attacker.example:1234", "Host: 127.0.0.1:99", "Host: 127.0.0.1:1234\r\nOrigin: https://evil.example",
                        "Host: 127.0.0.1:1234\r\nHost: localhost:1234", "Host: 127.0.0.1:1234\r\nContent-Length: 10",
                        "Host: 127.0.0.1:1234\r\nTransfer-Encoding: chunked", "Content-Length: 0", "Host : 127.0.0.1:1234"] {
            XCTAssertThrowsError(try AssetRequest.parse(request(headers: headers), root: root, port: 1234), headers)
        }
        XCTAssertThrowsError(try AssetRequest.parse(request("POST / HTTP/1.1"), root: root, port: 1234)) { error in
            XCTAssertEqual((error as? AssetHTTPError)?.status, 405)
        }
        XCTAssertThrowsError(try AssetRequest.parse(request(headers: "Host: 127.0.0.1:1234\r\nX-Large: " + String(repeating: "a", count: 8192)), root: root, port: 1234))
    }

    func testExpectedMIMETypes() {
        for (extensionName, expected) in ["wasm": "application/wasm", "onnx": "application/octet-stream", "json": "application/json", "js": "text/javascript; charset=utf-8"] {
            XCTAssertEqual(AssetRequest.mime(for: URL(fileURLWithPath: "/file.\(extensionName)")), expected)
        }
    }

    @MainActor
    func testLoopbackServerStreamsLargeFileAndSupportsHead() async throws {
        let root = try fixture()
        let bytes = Data((0..<(2 * 1024 * 1024 + 13)).map { UInt8($0 % 251) })
        try bytes.write(to: root.appendingPathComponent("sdk/model.onnx"))
        let server = AssetServer(documentRoot: root)
        let url = try await server.start()
        defer { server.stop() }
        XCTAssertEqual(url.host, "127.0.0.1")
        XCTAssertNotNil(url.port)
        let secondURL = try await server.start()
        XCTAssertEqual(url, secondURL)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(from: url.appendingPathComponent("sdk/model.onnx"))
        XCTAssertEqual(data, bytes)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200)
        XCTAssertEqual(http.value(forHTTPHeaderField: "Content-Length"), String(bytes.count))
        XCTAssertEqual(http.value(forHTTPHeaderField: "Cross-Origin-Resource-Policy"), "same-origin")
        XCTAssertNil(http.value(forHTTPHeaderField: "Access-Control-Allow-Origin"))
        var head = URLRequest(url: url.appendingPathComponent("sdk/model.onnx"))
        head.httpMethod = "HEAD"
        let (headData, headResponse) = try await session.data(for: head)
        XCTAssertTrue(headData.isEmpty)
        XCTAssertEqual((headResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Length"), String(bytes.count))
        var post = URLRequest(url: url)
        post.httpMethod = "POST"
        let (_, postResponse) = try await session.data(for: post)
        XCTAssertEqual((postResponse as? HTTPURLResponse)?.statusCode, 405)
        var crossOrigin = URLRequest(url: url)
        crossOrigin.setValue("https://example.com", forHTTPHeaderField: "Origin")
        let (_, originResponse) = try await session.data(for: crossOrigin)
        XCTAssertEqual((originResponse as? HTTPURLResponse)?.statusCode, 403)
    }

    @MainActor
    func testMissingRootFailsAndServerCanRestartAfterStop() async throws {
        let root = try fixture()
        let missing = AssetServer(documentRoot: root.appendingPathComponent("missing"))
        do { _ = try await missing.start(); XCTFail("Missing root was accepted") }
        catch { XCTAssertTrue(error is AssetServerError) }
        missing.stop()
        let server = AssetServer(documentRoot: root)
        _ = try await server.start()
        server.stop()
        let restarted = try await server.start()
        XCTAssertEqual(restarted.host, "127.0.0.1")
        server.stop()
    }

    @MainActor
    func testCancelledStartDoesNotLeaveAnActiveServer() async throws {
        let server = AssetServer(documentRoot: try fixture())
        let start = Task { try await server.start() }
        start.cancel()
        do { _ = try await start.value; XCTFail("Cancelled start unexpectedly succeeded") }
        catch { XCTAssertTrue(error is CancellationError) }
        let url = try await server.start()
        XCTAssertEqual(url.host, "127.0.0.1")
        server.stop()
    }
}
