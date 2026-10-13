import AVFoundation

// Called on capture's serial callback queue. Lock also protects the final flush.
final class AudioPacketizer {
    private let lock = NSLock()
    private var pending: [AudioChannel: [Float]] = [:]
    private var rates: [AudioChannel: Double] = [:]
    let emit: (AudioChannel, Data, Double) -> Void
    let error: (String) -> Void
    init(emit: @escaping (AudioChannel, Data, Double) -> Void, error: @escaping (String) -> Void) { self.emit = emit; self.error = error }
    func append(_ input: AVAudioPCMBuffer, channel: AudioChannel) {
        lock.lock(); defer { lock.unlock() }
        let frames = Int(input.frameLength), channels = Int(input.format.channelCount), rate = input.format.sampleRate
        guard frames > 0 else { return }
        guard channels > 0, rate.isFinite, rate >= 8000, rate <= 96000 else { error("Поддерживается звук с частотой от 8 до 96 кГц."); return }
        if let previous = rates[channel], previous != rate { error("Частота аудио изменилась. Перезапустите запись."); return }
        rates[channel] = rate
        var mono = [Float](); mono.reserveCapacity(frames)
        let interleaved = input.format.isInterleaved
        for i in 0..<frames {
            var sample: Float = 0
            for c in 0..<channels {
                let plane = interleaved ? 0 : c, offset = interleaved ? i * channels + c : i
                if let data = input.floatChannelData { sample += data[plane][offset] / Float(channels) }
                else if let data = input.int16ChannelData { sample += Float(data[plane][offset]) / 32768 / Float(channels) }
                else if let data = input.int32ChannelData { sample += Float(data[plane][offset]) / 2147483648 / Float(channels) }
                else { error("Неподдерживаемый формат звука"); return }
            }
            mono.append(sample.isFinite ? min(1, max(-1, sample)) : 0)
        }
        pending[channel, default: []].append(contentsOf: mono)
        let size = Int(rate / 10)
        while (pending[channel]?.count ?? 0) >= size {
            let chunk = Array(pending[channel]!.prefix(size)); pending[channel]!.removeFirst(size)
            chunk.withUnsafeBytes { emit(channel, Data($0), rate) }
        }
    }
    func flush() {
        lock.lock(); defer { lock.unlock() }
        for channel in AudioChannel.allCases {
            if let chunk = pending[channel], !chunk.isEmpty, let rate = rates[channel] { chunk.withUnsafeBytes { emit(channel, Data($0), rate) } }
        }
        pending.removeAll()
    }
}
