import AVFoundation

enum DictationMicrophoneError: LocalizedError {
    case busy, denied, unavailable
    var errorDescription: String? {
        switch self {
        case .busy: return "Микрофон диктовки уже запущен."
        case .denied: return "Разрешите доступ к микрофону для диктовки в настройках macOS."
        case .unavailable: return "Микрофон недоступен или его формат не поддерживается."
        }
    }
}

/// Microphone-only capture; no ScreenCaptureKit stream or system-audio permission.
@MainActor final class DictationMicrophone {
    private var engine: AVAudioEngine?
    private var delivery: DictationMicrophoneDelivery?
    private var configurationObserver: NSObjectProtocol?
    private var permissionRequest: DictationMicrophonePermissionRequest?
    private var stoppingTask: Task<Void, Never>?
    private var generation: UInt64 = 0
    private var starting = false

    func start(onAudio: @escaping (AVAudioPCMBuffer) -> Void,
               onLevel: @escaping (Float) -> Void,
               onError: @escaping (String) -> Void) async throws {
        guard engine == nil, !starting, stoppingTask == nil else { throw DictationMicrophoneError.busy }
        generation &+= 1; let current = generation; starting = true
        defer { starting = false }
        let allowed: Bool
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: allowed = true
        case .notDetermined:
            let request = DictationMicrophonePermissionRequest()
            permissionRequest = request
            defer { permissionRequest = nil }
            allowed = try await request.value { completion in
                AVCaptureDevice.requestAccess(for: .audio, completionHandler: completion)
            }
        default: allowed = false
        }
        try Task.checkCancellation()
        guard generation == current else { throw CancellationError() }
        guard allowed else { throw DictationMicrophoneError.denied }
        let fresh = AVAudioEngine()
        let input = fresh.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate.isFinite, (8_000...96_000).contains(format.sampleRate),
              (1...32).contains(format.channelCount), format.commonFormat == .pcmFormatFloat32 else { throw DictationMicrophoneError.unavailable }
        let receiver = DictationMicrophoneDelivery(onAudio: onAudio, onLevel: onLevel) { message in
            Task { @MainActor [weak self] in
                guard let self, self.generation == current, self.engine != nil else { return }
                let stoppedGeneration = current &+ 1
                await self.stop()
                guard self.generation == stoppedGeneration else { return }
                onError(message)
            }
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in receiver.receive(buffer) }
        engine = fresh; delivery = receiver
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: fresh, queue: nil) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == current, self.engine != nil else { return }
                let stoppedGeneration = current &+ 1
                await self.stop()
                guard self.generation == stoppedGeneration else { return }
                onError("Микрофон или его формат изменился. Диктовка приостановлена; включите её снова.")
            }
        }
        do { fresh.prepare(); try fresh.start() }
        catch { await stop(); throw error }
    }

    func stop() async {
        if let stoppingTask { await stoppingTask.value; return }
        generation &+= 1
        permissionRequest?.cancel()
        delivery?.deactivate()
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        engine = nil
        let previous = delivery; delivery = nil
        let task = Task { await previous?.drain(); return () }
        stoppingTask = task
        await task.value
        stoppingTask = nil
    }
}

/// Cancels our wait, not the OS permission dialog. The callback may arrive after
/// stop or a later session starts; a one-shot gate prevents it resuming stale work.
final class DictationMicrophonePermissionRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Error>?
    private var result: Result<Bool, Error>?

    func value(start: (@escaping @Sendable (Bool) -> Void) -> Void) async throws -> Bool {
        let allowed = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
                if install(continuation) {
                    start { [self] allowed in finish(.success(allowed)) }
                }
            }
        } onCancel: { self.cancel() }
        // Cancellation may race a grant that already won the continuation gate.
        // Even in that case, a cancelled start must not open the microphone.
        try Task.checkCancellation()
        return allowed
    }

    func cancel() { finish(.failure(CancellationError())) }

    private func install(_ incoming: CheckedContinuation<Bool, Error>) -> Bool {
        lock.lock()
        if let result { lock.unlock(); incoming.resume(with: result); return false }
        continuation = incoming
        lock.unlock()
        return true
    }

    private func finish(_ completed: Result<Bool, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = completed
        let pending = continuation; continuation = nil
        lock.unlock()
        pending?.resume(with: completed)
    }
}

/// Copies borrowed tap buffers before dispatch. Bounded queue fails visibly instead of
/// allowing unbounded latency. User callbacks run serially away from the audio thread.
final class DictationMicrophoneDelivery: @unchecked Sendable {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "local-speech.dictation-microphone", qos: .userInitiated)
    private var active = true
    private var pending = 0
    private var lastLevel: UInt64 = 0
    private let onAudio: (AVAudioPCMBuffer) -> Void
    private let onLevel: (Float) -> Void
    private let onError: (String) -> Void
    init(onAudio: @escaping (AVAudioPCMBuffer) -> Void, onLevel: @escaping (Float) -> Void, onError: @escaping (String) -> Void) {
        self.onAudio = onAudio; self.onLevel = onLevel; self.onError = onError
    }
    func deactivate() { lock.lock(); active = false; lock.unlock() }
    func drain() async { await withCheckedContinuation { continuation in queue.async { continuation.resume() } } }
    func receive(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        guard active else { lock.unlock(); return }
        guard pending < 32 else {
            active = false
            queue.async { self.onError("Обработка микрофона отстаёт. Диктовка остановлена без накопления звука.") }
            lock.unlock(); return
        }
        pending += 1
        guard let owned = Self.copy(buffer) else {
            pending -= 1; active = false
            queue.async { self.onError("Не удалось прочитать звук микрофона.") }
            lock.unlock(); return
        }
        // Enqueue while holding the admission lock, so deactivate()+drain() cannot
        // overtake an accepted tap buffer that is still being copied.
        queue.async {
            self.lock.lock(); self.pending -= 1; self.lock.unlock()
            // Accepted buffers drain during stop before the caller flushes its
            // packetizer. Deactivation rejects only newly arriving tap buffers.
            self.onAudio(owned)
            let now = DispatchTime.now().uptimeNanoseconds
            if now - self.lastLevel >= 100_000_000 {
                self.lastLevel = now; self.onLevel(Self.level(owned))
            }
        }
        lock.unlock()
    }
    static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard buffer.frameLength > 0, buffer.frameLength <= buffer.frameCapacity,
              buffer.format.commonFormat == .pcmFormatFloat32,
              let owned = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return nil }
        owned.frameLength = buffer.frameLength
        let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
        let destination = UnsafeMutableAudioBufferListPointer(owned.mutableAudioBufferList)
        guard source.count == destination.count else { return nil }
        for index in source.indices {
            let count = Int(source[index].mDataByteSize)
            guard count <= Int(destination[index].mDataByteSize), let from = source[index].mData, let to = destination[index].mData else { return nil }
            memcpy(to, from, count)
        }
        return owned
    }
    private static func level(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData else { return 0 }
        let frames = Int(buffer.frameLength), channels = Int(buffer.format.channelCount)
        var sum: Double = 0
        for frame in 0..<frames {
            for channel in 0..<channels {
                let sample = data[buffer.format.isInterleaved ? 0 : channel][buffer.format.isInterleaved ? frame * channels + channel : frame]
                if sample.isFinite { let bounded = Double(min(1, max(-1, sample))); sum += bounded * bounded }
            }
        }
        return Float(sqrt(sum / Double(max(1, frames * channels))))
    }
}
