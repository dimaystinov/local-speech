import Foundation
import Darwin

// This pass is text-only. Owner verification and command execution keep SDK raw text.
enum RefinementPolicy {
    static func eligible(_ text: String) -> Bool {
        text.range(of: "[а-яё]", options: [.regularExpression, .caseInsensitive]) != nil &&
        text.range(of: "[a-zіїєґ]", options: [.regularExpression, .caseInsensitive]) == nil &&
        text.split(whereSeparator: \.isWhitespace).count >= 5
    }
    static func accept(original: String, candidate: String) -> Bool {
        guard eligible(original), eligible(candidate), candidate.count <= 2000,
              Double(candidate.split(whereSeparator: \.isWhitespace).count) >= Double(original.split(whereSeparator: \.isWhitespace).count) * 0.8 else { return false }
        // Never silently change explicit digits or negative commands in this refinement route.
        func protected(_ text: String) -> [String] {
            let regex = try! NSRegularExpression(pattern: "[0-9]+|(?<![\\p{L}])(не|нет|нельзя)(?![\\p{L}])", options: .caseInsensitive)
            let s = text.lowercased() as NSString
            return regex.matches(in: text.lowercased(), range: NSRange(location: 0, length: s.length)).map { s.substring(with: $0.range) }
        }
        return protected(original) == protected(candidate)
    }
}

struct RefinementPCMWindow {
    private(set) var rate: Double = 0
    private var data = Data()
    private var firstFrame = 0
    private var endFrame = 0
    mutating func append(_ incoming: Data, rate: Double) {
        guard rate.isFinite, rate >= 8000, rate <= 96000, incoming.count % 4 == 0 else { return }
        if self.rate != rate { self = Self(); self.rate = rate }
        data.append(incoming); endFrame += incoming.count / 4
        let excess = data.count / 4 - Int(rate * 30)
        if excess > 0 { data.removeFirst(excess * 4); firstFrame += excess }
    }
    func slice(start: Double, end: Double) -> Data? {
        guard start.isFinite, end.isFinite, rate > 0, start >= 0, end > start, end - start <= 20 else { return nil }
        let a = Int((start * rate).rounded()), b = Int((end * rate).rounded())
        guard a >= firstFrame, b <= endFrame, b > a else { return nil }
        let base = data.startIndex
        return data.subdata(in: base + (a - firstFrame) * 4..<base + (b - firstFrame) * 4)
    }
}

@MainActor final class NativeRefinement {
    private var busy = false
    func refine(audio: Data, rate: Double, original: String) async -> String? {
        guard !busy, RefinementPolicy.eligible(original), audio.count > 0,
              rate.isFinite, rate >= 8000, rate <= 96000, audio.count % 4 == 0,
              Double(audio.count) / 4 / rate <= 20,
              ProcessInfo.processInfo.physicalMemory >= 12 * 1024 * 1024 * 1024,
              let root = Bundle.main.resourceURL?.appendingPathComponent("NativeASR"),
              FileManager.default.isExecutableFile(atPath: root.appendingPathComponent("native-refiner").path)
        else { return nil }
        busy = true; defer { busy = false }
        let text = await Task.detached(priority: .utility) { () -> String? in
            let process = Process(), input = Pipe(), output = Pipe()
            process.qualityOfService = .utility
            process.executableURL = root.appendingPathComponent("native-refiner")
            process.arguments = [root.appendingPathComponent("models").path, String(Int(rate))]
            process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
            do { try process.run() } catch { return nil }
            let deadline = DispatchWorkItem {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 5, execute: deadline)
            do { try input.fileHandleForWriting.write(contentsOf: audio); try input.fileHandleForWriting.close() }
            catch { if process.isRunning { process.terminate() }; deadline.cancel(); return nil }
            // Drain stdout before wait: even a long result cannot deadlock the pipe.
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit(); deadline.cancel()
            guard process.terminationStatus == 0, bytes.count <= 65536,
                  let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let text = object["text"] as? String else { return nil }
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }.value
        guard let text, RefinementPolicy.accept(original: original, candidate: text) else { return nil }
        return text
    }
}
