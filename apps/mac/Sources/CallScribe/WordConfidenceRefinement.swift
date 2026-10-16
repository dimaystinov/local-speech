import Foundation
import Darwin

struct WordConfidenceReview: Codable, Equatable {
    struct Word: Codable, Equatable { let word: String; let probability: Double? }
    struct Change: Codable, Equatable { let index: Int; let from: String; let to: String }
    let original: String
    let text: String
    let words: [Word]
    let changes: [Change]
    let elapsedSeconds: Double
    let rechecked: Bool
    var valid: Bool {
        original.count <= 2000 && text.count <= 2000 && words.count <= 500 && changes.count <= 2 &&
        elapsedSeconds.isFinite && elapsedSeconds >= 0 &&
        words.allSatisfy { $0.probability == nil || ($0.probability!.isFinite && (0...1).contains($0.probability!)) }
    }
}

/// Optional locally installed Python/CT2 adapter. One job, bounded time, no queued audio.
@MainActor final class WordConfidenceRefinement {
    private var busy = false
    private struct Settings: Decodable { let python: String; let model: String }
    func review(audio: Data, rate: Double, original: String, terms: [String]) async -> WordConfidenceReview? {
        guard !busy, rate.isFinite, rate >= 8000, rate <= 96000, rate.rounded() == rate, !audio.isEmpty, audio.count % 4 == 0, Double(audio.count) <= rate * 12 * 4,
              original.count <= 2000, terms.count <= 32, !terms.isEmpty,
              ProcessInfo.processInfo.physicalMemory >= 12 * 1024 * 1024 * 1024,
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
              let bytes = try? Data(contentsOf: support.appendingPathComponent("LocalSpeech Calls/WordConfidence/runtime.json")),
              let settings = try? JSONDecoder().decode(Settings.self, from: bytes),
              FileManager.default.isExecutableFile(atPath: settings.python),
              let script = Bundle.main.resourceURL?.appendingPathComponent("word-confidence.py"),
              FileManager.default.fileExists(atPath: script.path),
              let request = try? JSONSerialization.data(withJSONObject: ["audio": audio.base64EncodedString(), "rate": rate, "original": original, "terms": terms]) else { return nil }
        busy = true; defer { busy = false }
        return await Task.detached(priority: .utility) {
            let process = Process(), input = Pipe(), output = Pipe()
            process.executableURL = URL(fileURLWithPath: settings.python)
            process.arguments = ["-I", script.path, settings.model]
            process.qualityOfService = .utility
            process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
            do { try process.run() } catch { return nil }
            let deadline = DispatchWorkItem { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 6, execute: deadline)
            defer { deadline.cancel() }
            do { try input.fileHandleForWriting.write(contentsOf: request); try input.fileHandleForWriting.close() }
            catch { if process.isRunning { process.terminate() }; return nil }
            let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
            guard process.terminationStatus == 0, data.count <= 65536,
                  let review = try? JSONDecoder().decode(WordConfidenceReview.self, from: data), review.valid,
                  review.original == original else { return nil }
            return review
        }.value
    }
}
