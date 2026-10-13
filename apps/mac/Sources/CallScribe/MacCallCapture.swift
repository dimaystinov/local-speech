import AVFoundation
import CoreMedia
import ScreenCaptureKit

struct CaptureApplication: Identifiable, Sendable {
    let id: Int32
    let name: String
    let bundleID: String
}

enum MacCallCaptureError: LocalizedError {
    case busy, microphoneDenied, noDisplay, applicationGone, invalidAudio

    var errorDescription: String? {
        switch self {
        case .busy: return "Предыдущий захват ещё запускается или завершается."
        case .microphoneDenied: return "Разрешите доступ к микрофону в настройках конфиденциальности macOS."
        case .noDisplay: return "Не найден экран для захвата системного аудио."
        case .applicationGone: return "Выбранное приложение закрыто. Обновите список приложений."
        case .invalidAudio: return "Не удалось прочитать аудиобуфер ScreenCaptureKit."
        }
    }
}

/// Audio callbacks run on one serial queue. They must return promptly, and must not
/// synchronously wait for the main thread. Each PCM buffer owns its sample data.
@MainActor
final class MacCallCapture: NSObject {
    private let audioQueue = DispatchQueue(label: "local-speech.call-capture", qos: .userInitiated)
    private var stream: SCStream?
    private var output: CallAudioOutput?
    private var generation: UInt64 = 0
    private var starting = false
    private var stopping: Task<Void, Never>?

    func applications() async throws -> [CaptureApplication] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        return content.applications
            .filter { $0.processID != ProcessInfo.processInfo.processIdentifier }
            .map { CaptureApplication(id: $0.processID, name: $0.applicationName, bundleID: $0.bundleIdentifier) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func start(applicationID: Int32?, includeMicrophone: Bool,
               onAudio: @escaping (AudioChannel, AVAudioPCMBuffer) -> Void,
               onLevel: @escaping (AudioChannel, Float) -> Void,
               onError: @escaping (String) -> Void) async throws {
        guard !starting, stopping == nil, stream == nil else { throw MacCallCaptureError.busy }
        starting = true
        generation &+= 1
        let current = generation
        defer { starting = false }
        if includeMicrophone {
            let allowed: Bool
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: allowed = true
            case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .audio)
            default: allowed = false
            }
            try validate(current)
            guard allowed else { throw MacCallCaptureError.microphoneDenied }
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        try validate(current)
        guard let display = content.displays.first else { throw MacCallCaptureError.noDisplay }
        let filter: SCContentFilter
        if let applicationID {
            guard applicationID != ProcessInfo.processInfo.processIdentifier,
                  let app = content.applications.first(where: { $0.processID == applicationID }) else {
                throw MacCallCaptureError.applicationGone
            }
            filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        } else {
            let ownApps = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
            filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
        }
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.captureMicrophone = includeMicrophone
        configuration.sampleRate = 48_000
        configuration.channelCount = 1
        // ScreenCaptureKit requires a display filter; no screen output is registered
        // and no image is read, retained or written by this application.
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.queueDepth = 3
        configuration.showsCursor = false

        let receiver = CallAudioOutput(onAudio: onAudio, onLevel: onLevel) { [weak self] message in
            Task { @MainActor [weak self] in
                guard let self, self.generation == current, self.stream != nil else { return }
                onError(message)
                await self.stop()
            }
        }
        let newStream = SCStream(filter: filter, configuration: configuration, delegate: receiver)
        receiver.bind(newStream)
        do {
            try newStream.addStreamOutput(receiver, type: .audio, sampleHandlerQueue: audioQueue)
            if includeMicrophone {
                try newStream.addStreamOutput(receiver, type: .microphone, sampleHandlerQueue: audioQueue)
            }
            stream = newStream
            output = receiver
            try await newStream.startCapture()
            try validate(current)
        } catch {
            receiver.deactivate()
            // This also handles stop() racing an in-flight startCapture().
            try? await newStream.stopCapture()
            if stream === newStream { stream = nil; output = nil }
            throw error
        }
    }

    func stop() async {
        if let stopping { await stopping.value; return }
        generation &+= 1
        output?.deactivate()
        let previous = stream
        stream = nil
        output = nil
        guard let previous else { return }
        let task = Task { try? await previous.stopCapture(); return () }
        stopping = task
        await task.value
        stopping = nil
    }

    private func validate(_ expected: UInt64) throws {
        try Task.checkCancellation()
        guard generation == expected else { throw CancellationError() }
    }
}

private final class CallAudioOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private weak var expectedStream: SCStream?
    private var active = true
    private var levelTimes: [AudioChannel: UInt64] = [:]
    private let onAudio: (AudioChannel, AVAudioPCMBuffer) -> Void
    private let onLevel: (AudioChannel, Float) -> Void
    private let onError: (String) -> Void

    init(onAudio: @escaping (AudioChannel, AVAudioPCMBuffer) -> Void,
         onLevel: @escaping (AudioChannel, Float) -> Void,
         onError: @escaping (String) -> Void) {
        self.onAudio = onAudio; self.onLevel = onLevel; self.onError = onError
    }

    func bind(_ stream: SCStream) { lock.lock(); defer { lock.unlock() }; expectedStream = stream }
    func deactivate() { lock.lock(); defer { lock.unlock() }; active = false }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail(stream, message: error.localizedDescription)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        lock.lock()
        let accepted = active && expectedStream === stream
        lock.unlock()
        guard accepted, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let channel: AudioChannel
        switch type {
        case .audio: channel = .call
        case .microphone: channel = .microphone
        default: return
        }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0 else { return }
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              asbd.pointee.mFormatID == kAudioFormatLinearPCM,
              asbd.pointee.mSampleRate.isFinite,
              (8_000...192_000).contains(asbd.pointee.mSampleRate),
              (1...32).contains(asbd.pointee.mChannelsPerFrame),
              (1...128).contains(asbd.pointee.mBytesPerFrame),
              frames <= Int(asbd.pointee.mSampleRate) else {
            fail(stream, message: MacCallCaptureError.invalidAudio.localizedDescription); return
        }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else {
            fail(stream, message: MacCallCaptureError.invalidAudio.localizedDescription); return
        }
        pcm.frameLength = AVAudioFrameCount(frames)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0,
                                                                frameCount: Int32(frames),
                                                                into: pcm.mutableAudioBufferList)
        guard status == noErr else {
            fail(stream, message: "Ошибка чтения PCM: \(status)"); return
        }
        lock.lock()
        defer { lock.unlock() }
        guard active, expectedStream === stream else { return }
        onAudio(channel, pcm)
        let now = DispatchTime.now().uptimeNanoseconds
        if now &- (levelTimes[channel] ?? 0) >= 100_000_000 {
            levelTimes[channel] = now
            onLevel(channel, Self.level(pcm))
        }
    }

    private func fail(_ stream: SCStream, message: String) {
        lock.lock()
        guard active, expectedStream === stream else { lock.unlock(); return }
        active = false
        lock.unlock()
        onError(message)
    }

    private static func level(_ pcm: AVAudioPCMBuffer) -> Float {
        let frames = Int(pcm.frameLength)
        let stride = pcm.stride
        guard frames > 0 else { return 0 }
        var sum = 0.0
        // Meter the first channel only. The delivered buffer retains every channel.
        if let data = pcm.floatChannelData {
            for index in 0..<frames { let value = Double(data[0][index * stride]); if value.isFinite { sum += value * value } }
        } else if let data = pcm.int16ChannelData {
            for index in 0..<frames { let value = Double(data[0][index * stride]) / 32768; sum += value * value }
        } else if let data = pcm.int32ChannelData {
            for index in 0..<frames { let value = Double(data[0][index * stride]) / 2147483648; sum += value * value }
        }
        return Float(min(1, sqrt(sum / Double(frames))))
    }
}
