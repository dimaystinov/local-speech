import AVFoundation

/// Queue PCM directly on one AVAudioPlayerNode; no per-chunk player restarts.
@MainActor final class RokiStreamPlayer {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var format: AVAudioFormat?
    private var samples: [Float] = []
    private var queued = 0
    private var ended = false, started = false
    private var epoch = UUID()
    private(set) var paused = false
    private(set) var underruns = 0
    private var frozenTime: Double = 0
    private var configurationObserver: NSObjectProtocol?
    var onComplete: (() -> Void)?
    var onFailure: (() -> Void)?
    var duration: Double { Double(samples.count) / 24000 }
    var time: Double {
        if paused { return frozenTime }
        guard started, let render = node.lastRenderTime, let played = node.playerTime(forNodeTime: render) else { return 0 }
        return min(duration, max(0, Double(played.sampleTime) / played.sampleRate))
    }
    var level: Float {
        guard started, !paused, queued > 0 else { return 0 }
        let index = min(samples.count, Int(time * 24000)), end = min(samples.count, index + 480)
        guard index < end else { return 0 }
        let square = samples[index..<end].reduce(Float(0)) { $0 + $1 * $1 }
        let rms = sqrt(square / Float(end - index))
        return rms < 0.003 ? 0 : min(1, sqrt(rms / 0.16))
    }
    func append(_ pcm: Data, rate: Int) throws {
        guard !ended, rate == 24000, pcm.count % 2 == 0, !pcm.isEmpty,
              samples.count + pcm.count / 2 <= 24000 * 60 else { throw RokiQwenError.tooLarge }
        if format == nil {
            guard let f = AVAudioFormat(standardFormatWithSampleRate: Double(rate), channels: 1) else { throw RokiQwenError.failed }
            format = f; engine.attach(node); engine.connect(node, to: engine.mainMixerNode, format: f)
            engine.prepare(); try engine.start()
            configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.started, !self.engine.isRunning else { return }
                    self.onFailure?()
                }
            }
        }
        guard let format, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count / 2)), let channel = buffer.floatChannelData?[0] else { throw RokiQwenError.failed }
        let bytes = [UInt8](pcm)
        for i in 0..<pcm.count / 2 {
            let value = Float(Int16(bitPattern: UInt16(bytes[2 * i]) | UInt16(bytes[2 * i + 1]) << 8)) / 32768
            channel[i] = value; samples.append(value)
        }
        buffer.frameLength = buffer.frameCapacity
        let current = epoch; queued += 1
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.epoch == current else { return }
                self.queued -= 1
                if self.queued == 0 {
                    if self.ended { self.onComplete?() }
                    else { self.underruns += 1 }
                }
            }
        }
        if !started { node.play(); started = true }
    }
    func finish() {
        ended = true
        if queued == 0 { onComplete?() }
    }
    func togglePause() {
        if paused { node.play(); paused = false }
        else { frozenTime = time; node.pause(); paused = true }
    }
    func stop() {
        epoch = UUID(); onComplete = nil; onFailure = nil
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        node.stop(); engine.stop(); samples.removeAll(); queued = 0; started = false; paused = false
    }
}
