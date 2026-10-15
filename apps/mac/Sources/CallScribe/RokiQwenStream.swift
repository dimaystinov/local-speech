import Foundation
import Darwin

/// One resident worker per RokiVoice; model/reference caches survive utterances.
/// Cancellation invalidates all callbacks and kills the worker before restarting it.
@MainActor final class RokiQwenStream {
    enum Event { case pcm(Data, Int), end, failure(Error) }
    private let runtime: RokiQwenRuntime?
    private let warmTimeout: Double
    private let requestTimeout: Double
    private var child: Process?
    private var input: FileHandle?
    private var output = Data()
    private var epoch = UUID()
    private var requestID: String?
    private var pending: Data?
    private var callback: ((Event) -> Void)?
    private var timeout: Task<Void, Never>?
    private var totalBytes = 0, nextIndex = 0
    private(set) var ready = false
    private(set) var warming = false
    var onState: (() -> Void)?
    init(runtime: RokiQwenRuntime? = RokiQwenRuntime.installed(), warmTimeout: Double = 120, requestTimeout: Double = 90) {
        self.runtime = runtime; self.warmTimeout = warmTimeout; self.requestTimeout = requestTimeout
    }
    deinit { child?.terminate(); try? input?.close() }

    func warm() {
        guard child == nil else { return }
        guard let runtime else { fail(RokiQwenError.unavailable); return }
        let script = runtime.script.deletingLastPathComponent().appendingPathComponent("stream.py")
        guard FileManager.default.fileExists(atPath: script.path) else { fail(RokiQwenError.unavailable); return }
        let process = Process(), stdin = Pipe(), stdout = Pipe(), current = UUID()
        epoch = current; output.removeAll(); ready = false; warming = true; onState?()
        process.executableURL = runtime.python
        process.arguments = ["-I", "-u", script.path, runtime.model.path]
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self, self.epoch == current else { return }
                self.fail(RokiQwenError.failed)
            }
        }
        child = process; input = stdin.fileHandleForWriting
        do { try process.run() } catch { fail(RokiQwenError.unavailable); return }
        armTimeout(seconds: warmTimeout)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            defer { try? stdout.fileHandleForReading.close() }
            var buffer = [UInt8](repeating: 0, count: 65536)
            while true {
                // Foundation read(upToCount:) may wait to fill its requested size.
                // POSIX read returns immediately when the next stream fragment arrives.
                let count = Darwin.read(stdout.fileHandleForReading.fileDescriptor, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                let bytes = Data(buffer.prefix(count))
                // Bound producer backlog to one pipe read; all mutable state is on main.
                let keepReading = DispatchQueue.main.sync { self?.consume(bytes, epoch: current) ?? false }
                if !keepReading { return }
            }
            DispatchQueue.main.async {
                guard let self, self.epoch == current else { return }
                self.fail(RokiQwenError.failed)
            }
        }
    }
    func synthesize(text: String, language: String, onEvent: @escaping (Event) -> Void) {
        guard requestID == nil else { onEvent(.failure(RokiQwenError.alreadyStarted)); return }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.unicodeScalars.count <= 600,
              !text.contains("\0"), ["Russian", "English"].contains(language) else { onEvent(.failure(RokiQwenError.invalidInput)); return }
        let id = UUID().uuidString
        guard var data = try? JSONSerialization.data(withJSONObject: ["id": id, "text": text, "language": language]), data.count <= 8192 else { onEvent(.failure(RokiQwenError.invalidInput)); return }
        data.append(10); requestID = id; callback = onEvent; pending = data; totalBytes = 0; nextIndex = 0
        warm()
        if ready { sendPending() }
    }
    private func sendPending() {
        guard let data = pending else { return }
        pending = nil
        do { try input?.write(contentsOf: data); armTimeout(seconds: requestTimeout) }
        catch { fail(RokiQwenError.failed) }
    }
    private func armTimeout(seconds: Double) {
        timeout?.cancel()
        timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(max(0.01, seconds) * 1_000_000_000)); self?.fail(RokiQwenError.timeout) } catch { }
        }
    }
    private func consume(_ bytes: Data, epoch current: UUID) -> Bool {
        guard epoch == current else { return false }
        output.append(bytes)
        while let newline = output.firstIndex(of: 10) {
            let line = output.prefix(upTo: newline); output.removeSubrange(...newline)
            guard line.count <= 131072, let event = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let type = event["type"] as? String else { fail(RokiQwenError.failed); return false }
            if type == "ready", !ready {
                ready = true; warming = false; timeout?.cancel(); timeout = nil; onState?(); sendPending(); continue
            }
            guard let id = requestID, event["id"] as? String == id else { fail(RokiQwenError.failed); return false }
            switch type {
            case "chunk":
                guard event["rate"] as? Int == 24000, event["index"] as? Int == nextIndex,
                      let encoded = event["pcm"] as? String, let pcm = Data(base64Encoded: encoded),
                      !pcm.isEmpty, pcm.count % 2 == 0, pcm.count <= 96000,
                      totalBytes + pcm.count <= 24000 * 2 * 60 else { fail(RokiQwenError.tooLarge); return false }
                totalBytes += pcm.count; nextIndex += 1; callback?(.pcm(pcm, 24000))
            case "end":
                guard nextIndex > 0, event["chunks"] as? Int == nextIndex else { fail(RokiQwenError.failed); return false }
                let done = callback; callback = nil; requestID = nil; timeout?.cancel(); timeout = nil
                done?(.end)
            default: fail(RokiQwenError.failed); return false
            }
            if epoch != current { return false }
        }
        if output.count > 131072 { fail(RokiQwenError.tooLarge); return false }
        return true
    }
    func cancel() {
        guard requestID != nil else { return }
        shutdown(); warm()
    }
    func shutdown() {
        epoch = UUID(); timeout?.cancel(); timeout = nil
        callback = nil; requestID = nil; pending = nil; output.removeAll(); ready = false; warming = false
        try? input?.close(); input = nil
        if let process = child, process.isRunning {
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) } }
        }
        child = nil; onState?()
    }
    private func fail(_ error: Error) {
        let failed = callback; shutdown(); failed?(.failure(error))
    }
}
