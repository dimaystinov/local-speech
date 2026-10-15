import Foundation
import Darwin

enum RokiESpeakError: LocalizedError, Equatable {
    case unavailable, invalidInput, alreadyStarted, cancelled, timeout, outputTooLarge, invalidWave, failed(Int32)
    var errorDescription: String? {
        switch self {
        case .unavailable: return "eSpeak NG не установлен. Установите espeak-ng или выберите системный голос."
        case .invalidInput: return "Для eSpeak нужен текст до 600 символов и голос ru/en с вариантом f1 или m1."
        case .alreadyStarted: return "Эта озвучка eSpeak уже запущена."
        case .cancelled: return "Озвучка eSpeak отменена."
        case .timeout: return "eSpeak не подготовил звук за 20 секунд."
        case .outputTooLarge: return "Звук eSpeak превышает безопасный размер."
        case .invalidWave: return "eSpeak вернул неподдерживаемый или повреждённый WAV."
        case .failed: return "Не удалось подготовить голос eSpeak."
        }
    }
}

/// eSpeak's stdout WAV uses placeholder RIFF/data lengths because stdout is not seekable.
/// The actual pipe length is bounded independently, then only PCM16 frames are decoded.
enum RokiESpeakWAV {
    static let byteLimit = 12 * 1024 * 1024
    static func decode(_ data: Data) throws -> RokiAudioClip {
        guard data.count >= 44, data.count <= byteLimit else { throw RokiESpeakError.invalidWave }
        let bytes = [UInt8](data)
        func tag(_ offset: Int, _ text: String) -> Bool {
            offset >= 0 && offset + 4 <= bytes.count && bytes[offset..<(offset + 4)].elementsEqual(text.utf8)
        }
        func u16(_ offset: Int) -> Int { Int(bytes[offset]) | Int(bytes[offset + 1]) << 8 }
        func u32(_ offset: Int) -> Int { Int(bytes[offset]) | Int(bytes[offset + 1]) << 8 | Int(bytes[offset + 2]) << 16 | Int(bytes[offset + 3]) << 24 }
        guard tag(0, "RIFF"), tag(8, "WAVE") else { throw RokiESpeakError.invalidWave }
        let riffLength = u32(4)
        guard riffLength >= 36 else { throw RokiESpeakError.invalidWave }
        // Finite RIFF must include the complete stream. Large stdout placeholders are allowed.
        if riffLength < 0x7fff0000, riffLength + 8 != bytes.count { throw RokiESpeakError.invalidWave }
        var offset = 12, format: (channels: Int, rate: Int)?, payload: Range<Int>?
        while offset + 8 <= bytes.count {
            let length = u32(offset + 4), begin = offset + 8, remaining = bytes.count - begin
            if tag(offset, "fmt ") {
                guard format == nil, length >= 16, length <= remaining else { throw RokiESpeakError.invalidWave }
                let encoding = u16(begin), channels = u16(begin + 2), rate = u32(begin + 4)
                guard encoding == 1, (1...2).contains(channels), (8000...96000).contains(rate),
                      u16(begin + 14) == 16, u16(begin + 12) == channels * 2,
                      u32(begin + 8) == rate * channels * 2 else { throw RokiESpeakError.invalidWave }
                format = (channels, rate)
            } else if tag(offset, "data") {
                guard format != nil, payload == nil else { throw RokiESpeakError.invalidWave }
                let actualLength: Int
                if length > remaining {
                    guard length >= 0x7fff0000 else { throw RokiESpeakError.invalidWave }
                    actualLength = remaining
                } else { actualLength = length }
                guard actualLength > 0 else { throw RokiESpeakError.invalidWave }
                payload = begin..<(begin + actualLength)
                if length > remaining { offset = bytes.count; break }
            } else if length > remaining { throw RokiESpeakError.invalidWave }
            offset = begin + length + (length & 1)
            guard offset <= bytes.count else { throw RokiESpeakError.invalidWave }
        }
        guard offset == bytes.count, let format, let payload,
              payload.count % (format.channels * 2) == 0 else { throw RokiESpeakError.invalidWave }
        let frames = payload.count / (format.channels * 2)
        guard frames > 0, frames <= format.rate * 60 else { throw RokiESpeakError.invalidWave }
        var samples: [Float] = []; samples.reserveCapacity(frames)
        for frame in 0..<frames {
            var value: Float = 0
            for channel in 0..<format.channels {
                let cursor = payload.lowerBound + (frame * format.channels + channel) * 2
                value += Float(Int16(bitPattern: UInt16(u16(cursor)))) / 32768
            }
            samples.append(value / Float(format.channels))
        }
        guard let clip = RokiAudioClip.make(samples: samples, rate: format.rate) else { throw RokiESpeakError.invalidWave }
        return clip
    }
}

/// All mutable state is confined to `queue`. Pipe reads run on a background worker;
/// completion is sent once, off the main thread. A job is deliberately single-use.
final class RokiESpeakJob: @unchecked Sendable {
    private let queue = DispatchQueue(label: "LocalSpeech.RokiESpeak", qos: .userInitiated)
    private var process: Process?
    private var timeout: DispatchWorkItem?
    private var callback: (@Sendable (Result<RokiAudioClip, Error>) -> Void)?
    private var started = false, cancelled = false, finished = false, eof = false
    private var exitStatus: Int32?
    private var output = Data()

    init() {}

    func start(text: String, voice: String, completion: @escaping @Sendable (Result<RokiAudioClip, Error>) -> Void) {
        queue.async { [self] in
            guard !started else { DispatchQueue.global().async { completion(.failure(RokiESpeakError.alreadyStarted)) }; return }
            started = true; callback = completion
            guard !cancelled else { finish(.failure(RokiESpeakError.cancelled)); return }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 600,
                  !text.contains("\0"), ["en+m1", "ru+m1", "en+f1", "ru+f1"].contains(voice) else { finish(.failure(RokiESpeakError.invalidInput)); return }
            guard let executable = ["/opt/homebrew/bin/espeak-ng", "/usr/local/bin/espeak-ng"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
                finish(.failure(RokiESpeakError.unavailable)); return
            }
            let child = Process(), input = Pipe(), stdout = Pipe()
            child.executableURL = URL(fileURLWithPath: executable)
            child.arguments = ["--stdout", "--stdin", "-v", voice, "-s", "165"]
            child.standardInput = input; child.standardOutput = stdout; child.standardError = FileHandle.nullDevice
            child.terminationHandler = { [weak self] child in
                guard let self else { return }
                self.queue.async { self.exitStatus = child.terminationStatus; self.completeIfReady() }
            }
            process = child
            do { try child.run() } catch { finish(.failure(RokiESpeakError.unavailable)); return }
            let deadline = DispatchWorkItem { [weak self] in self?.finish(.failure(RokiESpeakError.timeout), terminate: true) }
            timeout = deadline; queue.asyncAfter(deadline: .now() + 20, execute: deadline)
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                defer { try? stdout.fileHandleForReading.close() }
                do {
                    while let chunk = try stdout.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
                        let keepReading = queue.sync { () -> Bool in
                            guard !finished else { return false }
                            guard output.count + chunk.count <= RokiESpeakWAV.byteLimit else {
                                finish(.failure(RokiESpeakError.outputTooLarge), terminate: true); return false
                            }
                            output.append(chunk); return true
                        }
                        if !keepReading { return }
                    }
                    queue.async { self.eof = true; self.completeIfReady() }
                } catch { queue.async { self.finish(.failure(RokiESpeakError.invalidWave), terminate: true) } }
            }
            do { try input.fileHandleForWriting.write(contentsOf: Data(text.utf8)); try input.fileHandleForWriting.close() }
            catch { try? input.fileHandleForWriting.close(); finish(.failure(RokiESpeakError.failed(-1)), terminate: true) }
        }
    }

    func cancel() {
        queue.async { [self] in
            cancelled = true
            if started { finish(.failure(RokiESpeakError.cancelled), terminate: true) }
        }
    }

    private func completeIfReady() {
        guard !finished, let exitStatus else { return }
        guard exitStatus == 0 else { finish(.failure(RokiESpeakError.failed(exitStatus)), terminate: true); return }
        guard eof else { return }
        do { finish(.success(try RokiESpeakWAV.decode(output))) }
        catch { finish(.failure(error)) }
    }

    private func finish(_ result: Result<RokiAudioClip, Error>, terminate: Bool = false) {
        guard !finished else { return }
        finished = true; timeout?.cancel(); timeout = nil; output.removeAll(keepingCapacity: false)
        if terminate, let child = process, child.isRunning {
            child.terminate()
            // SIGTERM normally suffices; reap a stuck installed engine after a short grace period.
            queue.asyncAfter(deadline: .now() + 0.5) {
                if child.isRunning { Darwin.kill(child.processIdentifier, SIGKILL) }
            }
        }
        let completion = callback; callback = nil
        if let completion { DispatchQueue.global(qos: .userInitiated).async { completion(result) } }
    }
}
