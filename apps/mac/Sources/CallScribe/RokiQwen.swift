import Foundation
import Darwin

struct RokiQwenRuntime {
    let python: URL
    let model: URL
    let script: URL
    static let revision = "e7dd0585652209fa0d7783659aad4e8a324de11c"
    static func installed(resources: URL? = Bundle.main.resourceURL) -> Self? {
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/LocalSpeech/RokiVoice")
        struct Settings: Decodable { let python: String; let model: String }
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("runtime.json")), data.count <= 16384,
              let settings = try? JSONDecoder().decode(Settings.self, from: data),
              settings.python.hasPrefix("/"), settings.model.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: settings.python),
              URL(fileURLWithPath: settings.model).lastPathComponent == revision,
              FileManager.default.fileExists(atPath: settings.model + "/config.json"),
              let resources else { return nil }
        let script = resources.appendingPathComponent("RokiVoice/synthesize.py")
        guard FileManager.default.fileExists(atPath: script.path) else { return nil }
        return Self(python: URL(fileURLWithPath: settings.python), model: URL(fileURLWithPath: settings.model), script: script)
    }
}

enum RokiQwenError: LocalizedError, Equatable {
    case unavailable, invalidInput, cancelled, timeout, failed, tooLarge, alreadyStarted
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Локальный голос Роки Qwen не настроен. Нужны окружение Python и скачанная модель."
        case .invalidInput: return "Для Qwen нужен текст до 600 символов на русском или английском."
        case .cancelled: return "Озвучка Роки отменена."
        case .timeout: return "Qwen не подготовила ответ за 90 секунд. Попробуйте более короткую фразу."
        case .failed: return "Не удалось создать голос Роки Qwen. Проверьте локальную модель и окружение."
        case .tooLarge: return "Ответ Qwen превысил допустимый размер."
        case .alreadyStarted: return "Эта озвучка уже запущена."
        }
    }
}

/// One bounded child per response; model memory is released when speech is ready.
/// All mutable process state belongs to `queue`, while pipe reads use a worker.
final class RokiQwenJob: @unchecked Sendable {
    private let queue = DispatchQueue(label: "LocalSpeech.RokiQwen", qos: .userInitiated)
    private let runtime: RokiQwenRuntime?
    private let deadlineSeconds: Double
    private var process: Process?
    private var timeout: DispatchWorkItem?
    private var callback: (@Sendable (Result<RokiAudioClip, Error>) -> Void)?
    private var started = false, cancelled = false, finished = false, eof = false
    private var exitStatus: Int32?
    private var output = Data()

    init(runtime: RokiQwenRuntime? = RokiQwenRuntime.installed(), deadlineSeconds: Double = 90) {
        self.runtime = runtime; self.deadlineSeconds = deadlineSeconds
    }
    func start(text: String, language: String, completion: @escaping @Sendable (Result<RokiAudioClip, Error>) -> Void) {
        queue.async { [self] in
            guard !started else { DispatchQueue.global().async { completion(.failure(RokiQwenError.alreadyStarted)) }; return }
            started = true; callback = completion
            guard !cancelled else { finish(.failure(RokiQwenError.cancelled)); return }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.unicodeScalars.count <= 600,
                  !text.contains("\0"), ["Russian", "English"].contains(language),
                  let inputData = try? JSONSerialization.data(withJSONObject: ["text": text, "language": language]),
                  inputData.count <= 8192 else { finish(.failure(RokiQwenError.invalidInput)); return }
            guard let runtime else { finish(.failure(RokiQwenError.unavailable)); return }
            let child = Process(), stdin = Pipe(), stdout = Pipe()
            child.executableURL = runtime.python
            child.arguments = ["-I", "-u", runtime.script.path, runtime.model.path]
            child.standardInput = stdin; child.standardOutput = stdout; child.standardError = FileHandle.nullDevice
            child.terminationHandler = { [weak self] child in
                guard let self else { return }
                self.queue.async { self.exitStatus = child.terminationStatus; self.completeIfReady() }
            }
            process = child
            do { try child.run() } catch { finish(.failure(RokiQwenError.unavailable)); return }
            let deadline = DispatchWorkItem { [weak self] in self?.finish(.failure(RokiQwenError.timeout), terminate: true) }
            timeout = deadline; queue.asyncAfter(deadline: .now() + deadlineSeconds, execute: deadline)
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                defer { try? stdout.fileHandleForReading.close() }
                do {
                    while let chunk = try stdout.fileHandleForReading.read(upToCount: 65536), !chunk.isEmpty {
                        let more = queue.sync { () -> Bool in
                            guard !finished else { return false }
                            guard output.count + chunk.count <= RokiESpeakWAV.byteLimit else {
                                finish(.failure(RokiQwenError.tooLarge), terminate: true); return false
                            }
                            output.append(chunk); return true
                        }
                        if !more { return }
                    }
                    queue.async { self.eof = true; self.completeIfReady() }
                } catch { queue.async { self.finish(.failure(RokiQwenError.failed), terminate: true) } }
            }
            do { try stdin.fileHandleForWriting.write(contentsOf: inputData); try stdin.fileHandleForWriting.close() }
            catch { try? stdin.fileHandleForWriting.close(); finish(.failure(RokiQwenError.failed), terminate: true) }
        }
    }
    func cancel() {
        queue.async { [self] in
            cancelled = true
            if started { finish(.failure(RokiQwenError.cancelled), terminate: true) }
        }
    }
    private func completeIfReady() {
        guard !finished, let exitStatus else { return }
        guard exitStatus == 0 else { finish(.failure(RokiQwenError.failed), terminate: true); return }
        guard eof else { return }
        do { finish(.success(try RokiESpeakWAV.decode(output))) }
        catch { finish(.failure(RokiQwenError.failed)) }
    }
    private func finish(_ result: Result<RokiAudioClip, Error>, terminate: Bool = false) {
        guard !finished else { return }
        finished = true; timeout?.cancel(); timeout = nil; output.removeAll(keepingCapacity: false)
        if terminate, let child = process, child.isRunning {
            child.terminate()
            queue.asyncAfter(deadline: .now() + 0.5) {
                if child.isRunning { Darwin.kill(child.processIdentifier, SIGKILL) }
            }
        }
        let completion = callback; callback = nil
        if let completion { DispatchQueue.global(qos: .userInitiated).async { completion(result) } }
    }
}
