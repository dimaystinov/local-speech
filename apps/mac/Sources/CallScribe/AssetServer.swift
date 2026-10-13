import Foundation
import Network

/// Hosts the bridge and SDK on one loopback origin. This server accepts no uploads.
@MainActor
final class AssetServer {
    private let documentRoot: URL
    private var worker: AssetServerWorker?
    private var address: URL?

    init(documentRoot: URL) { self.documentRoot = documentRoot }

    func start() async throws -> URL {
        if let address { return address }
        guard worker == nil else { throw AssetServerError.alreadyStarting }
        let next = AssetServerWorker(root: documentRoot)
        worker = next
        do {
            let url = try await withTaskCancellationHandler(operation: {
                try await withCheckedThrowingContinuation { continuation in
                    next.start { continuation.resume(with: $0) }
                }
            }, onCancel: { next.stop() })
            try Task.checkCancellation()
            guard worker === next else { throw CancellationError() }
            address = url
            return url
        } catch {
            next.stop()
            if worker === next { worker = nil; address = nil }
            throw error
        }
    }

    func stop() {
        worker?.stop()
        worker = nil
        address = nil
    }

    deinit { worker?.stop() }
}

enum AssetServerError: LocalizedError {
    case alreadyStarting, invalidRoot, unavailablePort
    var errorDescription: String? {
        switch self {
        case .alreadyStarting: return "The local asset server is already starting."
        case .invalidRoot: return "The bundled speech assets directory is unavailable."
        case .unavailablePort: return "The local asset server could not obtain a loopback port."
        }
    }
}

struct AssetHTTPError: Error {
    let status: Int
    let reason: String
    static let badRequest = Self(status: 400, reason: "Bad Request")
    static let forbidden = Self(status: 403, reason: "Forbidden")
    static let notFound = Self(status: 404, reason: "Not Found")
}

/// Pure request validation is shared by the server and security regression tests.
enum AssetRequest {
    struct Parsed {
        let file: URL
        let headOnly: Bool
    }

    static func parse(_ header: Data, root: URL, port: UInt16) throws -> Parsed {
        guard header.count <= 8192, let text = String(data: header, encoding: .utf8),
              text.hasSuffix("\r\n\r\n") else { throw AssetHTTPError.badRequest }
        let lines = text.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard first.count == 3, first[2] == "HTTP/1.1" || first[2] == "HTTP/1.0" else {
            throw AssetHTTPError.badRequest
        }
        guard first[0] == "GET" || first[0] == "HEAD" else {
            throw AssetHTTPError(status: 405, reason: "Method Not Allowed")
        }
        var fields: [String: String] = [:]
        for line in lines.dropFirst().dropLast(2) {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex,
                  !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw AssetHTTPError.badRequest }
            let name = String(line[..<colon]).lowercased()
            guard name.unicodeScalars.allSatisfy({
                (97...122).contains($0.value) || (48...57).contains($0.value) || $0 == "-"
            }), fields[name] == nil else { throw AssetHTTPError.badRequest }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !value.unicodeScalars.contains(where: { $0.value < 32 && $0 != "\t" || $0.value == 127 }) else {
                throw AssetHTTPError.badRequest
            }
            fields[name] = value
        }
        guard let host = fields["host"], host == "127.0.0.1:\(port)" || host == "localhost:\(port)" else {
            throw AssetHTTPError.forbidden
        }
        if let origin = fields["origin"], origin != "http://\(host)" { throw AssetHTTPError.forbidden }
        guard fields["transfer-encoding"] == nil,
              fields["content-length"] == nil || fields["content-length"] == "0" else {
            throw AssetHTTPError.badRequest
        }
        return Parsed(file: try resolve(root: root, target: String(first[1])), headOnly: first[0] == "HEAD")
    }

    static func resolve(root: URL, target: String) throws -> URL {
        guard target.hasPrefix("/"), !target.hasPrefix("//"), !target.contains("#"),
              let path = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]).removingPercentEncoding,
              !path.contains("\\"), !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
            throw AssetHTTPError.badRequest
        }
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.contains(".."), !parts.contains("."), !parts.contains(where: { $0.hasPrefix(".") }) else {
            throw AssetHTTPError.forbidden
        }
        let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath()
        let relative = path == "/" ? "bridge.html" : String(path.dropFirst())
        let file = canonicalRoot.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(canonicalRoot.path + "/") else { throw AssetHTTPError.forbidden }
        guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey]), values.isRegularFile == true else {
            throw AssetHTTPError.notFound
        }
        return file
    }

    static func mime(for file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "wasm": return "application/wasm"
        case "json": return "application/json"
        case "txt": return "text/plain; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "onnx", "bin", "data": return "application/octet-stream"
        default: return "application/octet-stream"
        }
    }
}

private final class AssetServerWorker: @unchecked Sendable {
    private let root: URL
    private let queue = DispatchQueue(label: "local-speech.assets", qos: .userInitiated)
    private var listener: NWListener?
    private var connections: [UUID: AssetConnection] = [:]
    private var completion: ((Result<URL, Error>) -> Void)?
    private var stopped = false

    init(root: URL) { self.root = root }

    func start(completion: @escaping (Result<URL, Error>) -> Void) {
        queue.async { [self] in
            guard !stopped else { completion(.failure(CancellationError())); return }
            self.completion = completion
            do {
                guard (try? root.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
                    throw AssetServerError.invalidRoot
                }
                let parameters = NWParameters.tcp
                parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
                let listener = try NWListener(using: parameters)
                self.listener = listener
                listener.stateUpdateHandler = { [weak self, weak listener] state in
                    guard let self, !self.stopped else { return }
                    switch state {
                    case .ready:
                        guard let port = listener?.port,
                              let url = URL(string: "http://127.0.0.1:\(port.rawValue)/") else {
                            self.finishStart(.failure(AssetServerError.unavailablePort)); self.shutdown(); return
                        }
                        self.finishStart(.success(url))
                    case .failed(let error): self.finishStart(.failure(error)); self.shutdown()
                    case .cancelled: self.finishStart(.failure(CancellationError()))
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self, weak listener] connection in
                    guard let self, !self.stopped, let port = listener?.port, self.connections.count < 16 else {
                        connection.cancel(); return
                    }
                    let id = UUID()
                    let client = AssetConnection(connection: connection, root: self.root, port: port.rawValue,
                                                 queue: self.queue) { [weak self] in self?.connections.removeValue(forKey: id) }
                    self.connections[id] = client
                    client.start()
                }
                listener.start(queue: queue)
                queue.asyncAfter(deadline: .now() + 10) { [weak self] in
                    guard let self, self.completion != nil else { return }
                    self.finishStart(.failure(AssetServerError.unavailablePort)); self.shutdown()
                }
            } catch { finishStart(.failure(error)); shutdown() }
        }
    }

    func stop() { queue.async { [self] in shutdown() } }

    private func finishStart(_ result: Result<URL, Error>) {
        let callback = completion
        completion = nil
        callback?(result)
    }

    private func shutdown() {
        guard !stopped else { return }
        stopped = true
        finishStart(.failure(CancellationError()))
        listener?.cancel()
        listener = nil
        let clients = Array(connections.values)
        connections.removeAll()
        clients.forEach { $0.close() }
    }
}

private final class AssetConnection {
    private let connection: NWConnection
    private let root: URL
    private let port: UInt16
    private let queue: DispatchQueue
    private let onClose: () -> Void
    private var header = Data()
    private var file: FileHandle?
    private var remaining: UInt64 = 0
    private var closed = false
    private var responding = false
    private var activity = Date()

    init(connection: NWConnection, root: URL, port: UInt16, queue: DispatchQueue, onClose: @escaping () -> Void) {
        self.connection = connection; self.root = root; self.port = port; self.queue = queue; self.onClose = onClose
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.close() }
            if case .cancelled = state { self?.close() }
        }
        connection.start(queue: queue)
        receiveHeader()
        checkTimeout()
    }

    private func checkTimeout() {
        queue.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, !self.closed else { return }
            if Date().timeIntervalSince(self.activity) >= 15 { self.close() }
            else { self.checkTimeout() }
        }
    }

    private func receiveHeader() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: min(4096, 8192 - header.count)) { [weak self] data, _, complete, error in
            guard let self, !self.closed, !self.responding else { return }
            if let data { self.header.append(data) }
            // Header timeout is absolute: slow clients cannot retain a slot indefinitely.
            if let end = self.header.range(of: Data("\r\n\r\n".utf8))?.upperBound {
                guard end <= 8192, end == self.header.count else { self.sendError(AssetHTTPError.badRequest); return }
                self.responding = true
                do { try self.serve(AssetRequest.parse(self.header, root: self.root, port: self.port)) }
                catch let error as AssetHTTPError { self.sendError(error) }
                catch { self.sendError(AssetHTTPError(status: 500, reason: "Internal Server Error")) }
            } else if self.header.count >= 8192 {
                self.sendError(AssetHTTPError(status: 431, reason: "Request Header Fields Too Large"))
            } else if complete || error != nil { self.close() }
            else { self.receiveHeader() }
        }
    }

    private func serve(_ request: AssetRequest.Parsed) throws {
        let handle = try FileHandle(forReadingFrom: request.file)
        file = handle
        remaining = try handle.seekToEnd()
        try handle.seek(toOffset: 0)
        let response = headers(status: 200, reason: "OK", length: remaining, mime: AssetRequest.mime(for: request.file))
        activity = Date()
        connection.send(content: response, completion: .contentProcessed { [weak self] error in
            guard let self, !self.closed else { return }
            if error != nil || request.headOnly { self.close(); return }
            self.sendChunk()
        })
    }

    // One 64 KiB read/send at a time: large model files never become whole in-memory responses.
    private func sendChunk() {
        guard !closed else { return }
        guard remaining > 0 else { close(); return }
        do {
            guard let chunk = try file?.read(upToCount: Int(min(remaining, 65_536))), !chunk.isEmpty else { close(); return }
            remaining -= UInt64(chunk.count)
            connection.send(content: chunk, completion: .contentProcessed { [weak self] error in
                guard let self, !self.closed else { return }
                if error != nil { self.close(); return }
                self.activity = Date()
                self.sendChunk()
            })
        } catch { close() }
    }

    private func sendError(_ error: AssetHTTPError) {
        responding = true
        let response = headers(status: error.status, reason: error.reason, length: 0, mime: "text/plain")
        connection.send(content: response, completion: .contentProcessed { [weak self] _ in self?.close() })
    }

    private func headers(status: Int, reason: String, length: UInt64, mime: String) -> Data {
        let allow = status == 405 ? "Allow: GET, HEAD\r\n" : ""
        return Data(("HTTP/1.1 \(status) \(reason)\r\nContent-Length: \(length)\r\nContent-Type: \(mime)\r\n" +
                     "Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n" +
                     "Cross-Origin-Resource-Policy: same-origin\r\n" + allow + "\r\n").utf8)
    }

    func close() {
        guard !closed else { return }
        closed = true
        try? file?.close()
        file = nil
        connection.cancel()
        onClose()
    }
}
