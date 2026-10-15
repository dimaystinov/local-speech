import AppKit
import AVFoundation
import Combine

enum RokiVoiceStyle: String, CaseIterable, Identifiable {
    case qwen, espeakFemale, espeak, robot, soft, system
    var id: String { rawValue }
    var title: String { switch self { case .qwen: return "Роки · Qwen · собранная"; case .espeakFemale: return "eSpeak NG · женский f1"; case .espeak: return "eSpeak NG · мужской m1"; case .robot: return "Роки · робот"; case .soft: return "Роки · мягкий"; case .system: return "Системный" } }
    static var defaultStyle: Self {
        if RokiQwenRuntime.installed() != nil { return .qwen }
        return ["/opt/homebrew/bin/espeak-ng", "/usr/local/bin/espeak-ng"].contains(where: FileManager.default.isExecutableFile(atPath:)) ? .espeakFemale : .robot
    }
    func process(_ samples: [Float], rate: Int) -> [Float] {
        guard self == .robot, rate > 0 else { return samples }
        let delay = max(1, Int(Double(rate) * 0.009))
        return samples.indices.map { index in
            let carrier = Float(sin(2 * Double.pi * 62 * Double(index) / Double(rate)))
            let echo: Float = index >= delay ? samples[index - delay] * 0.12 : 0
            return max(-0.98, min(0.98, samples[index] * (0.72 + carrier * 0.28) + echo))
        }
    }
}

private final class RokiPCMCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [Float] = []
    private var sampleRate = 0
    private var ended = false
    private let style: RokiVoiceStyle
    init(style: RokiVoiceStyle) { self.style = style }
    enum Result { case clip(RokiAudioClip), failure }
    func append(_ buffer: AVAudioBuffer) -> Result? {
        lock.lock(); defer { lock.unlock() }
        guard !ended else { return nil }
        guard let pcm = buffer as? AVAudioPCMBuffer else { ended = true; return .failure }
        if pcm.frameLength == 0 {
            ended = true
            return RokiAudioClip.make(samples: style.process(samples, rate: sampleRate), rate: sampleRate).map(Result.clip) ?? .failure
        }
        let rate = Int(pcm.format.sampleRate)
        guard (8000...96000).contains(rate), sampleRate == 0 || sampleRate == rate,
              samples.count + Int(pcm.frameLength) <= rate * 60,
              let channels = pcm.floatChannelData, !pcm.format.isInterleaved,
              pcm.format.channelCount > 0, pcm.format.channelCount <= 2 else { ended = true; return .failure }
        sampleRate = rate
        let channelCount = Int(pcm.format.channelCount)
        for frame in 0..<Int(pcm.frameLength) {
            var mono: Float = 0
            for channel in 0..<channelCount { mono += channels[channel][frame * pcm.stride] }
            samples.append(mono / Float(channelCount))
        }
        return nil
    }
}

@MainActor final class RokiVoice: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var style = RokiVoiceStyle(rawValue: UserDefaults.standard.string(forKey: "roki.voiceStyle") ?? "") ?? .defaultStyle {
        didSet { UserDefaults.standard.set(style.rawValue, forKey: "roki.voiceStyle") }
    }
    @Published private(set) var preparing = false
    @Published private(set) var speaking = false
    @Published private(set) var paused = false
    @Published private(set) var error: String?
    @Published private(set) var emotion: RokiEmotion = .calm
    @Published private(set) var currentText = ""
    @Published private(set) var duration: Double = 0
    private(set) var purpose: String?
    private(set) var lastFinishedPurpose: String?
    var canSpeak: () -> Bool = { true }
    var busy: Bool { preparing || speaking || paused }
    private var synthesizer: AVSpeechSynthesizer?
    private var espeak: RokiESpeakJob?
    private var qwen: RokiQwenJob?
    // Optional one-shot override retained for isolated worker tests.
    var makeQwenJob: (() -> RokiQwenJob)?
    lazy var streamWorker = RokiQwenStream()
    private var streamPlayer: RokiStreamPlayer?
    private(set) var streamGenerating = false
    private(set) var firstAudioMs: Double?
    private(set) var lastStreamUnderruns = 0
    private var requestedAt = Date()
    var warmReady: Bool { streamWorker.ready }
    var warming: Bool { streamWorker.warming }
    var streamUnderruns: Int { streamPlayer?.underruns ?? lastStreamUnderruns }
    func warmVoice() { streamWorker.warm() }
    func shutdownVoice() { stop(); streamWorker.shutdown() }
    private var player: AVAudioPlayer?
    private var clip: RokiAudioClip?
    private var generation = UUID()
    private var timeout: Task<Void, Never>?

    var mouthLevel: Float { streamPlayer?.level ?? clip?.level(at: player?.currentTime ?? 0, playing: player?.isPlaying == true) ?? 0 }
    var playbackTime: Double { streamPlayer?.time ?? player?.currentTime ?? 0 }

    /// Adapter for assistant responses. Explicit emotion overrides the conservative text hint.
    /// Uses an installed local engine and buffered PCM; nothing is sent to a service.
    func speak(_ text: String, emotion requested: RokiEmotion? = nil, purpose: String? = nil) {
        guard canSpeak() else { error = "Остановите распознавание перед озвучкой, чтобы Роки не услышала сама себя."; return }
        stop()
        let text = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(600))
        guard !text.isEmpty else { return }
        let russian = text.range(of: "[А-Яа-яЁё]", options: .regularExpression) != nil
        let language = russian ? "ru" : "en"
        if style == .qwen {
            error = nil; preparing = true; currentText = text; emotion = requested ?? .reply(text); self.purpose = purpose
            if makeQwenJob == nil {
                startStream(text: text, language: russian ? "Russian" : "English")
                return
            }
            let current = generation, job = makeQwenJob!()
            qwen = job
            job.start(text: text, language: russian ? "Russian" : "English") { [weak self] result in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.qwen = nil; self.preparing = false
                    switch result {
                    case .success(let clip): self.play(clip)
                    case .failure(let error): self.stop(); self.error = error.localizedDescription
                    }
                }
            }
            return
        }
        if style == .espeak || style == .espeakFemale {
            error = nil; preparing = true; currentText = text; emotion = requested ?? .reply(text); self.purpose = purpose
            let current = generation, job = RokiESpeakJob()
            espeak = job
            job.start(text: text, voice: language + (style == .espeakFemale ? "+f1" : "+m1")) { [weak self] result in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.espeak = nil; self.preparing = false
                    switch result {
                    case .success(let clip): self.play(clip)
                    case .failure(let error): self.stop(); self.error = error.localizedDescription
                    }
                }
            }
            return
        }
        let installed = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language.hasPrefix(language) && !$0.voiceTraits.contains(.isPersonalVoice)
        }
        guard let voice = installed.first(where: { $0.gender == .female }) ?? installed.first else {
            error = "Нет установленного системного голоса для этого языка."; return
        }
        error = nil; preparing = true; currentText = text; emotion = requested ?? .reply(text); self.purpose = purpose
        let current = generation, collector = RokiPCMCollector(style: style)
        let synth = AVSpeechSynthesizer(); synthesizer = synth
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice; utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.94
        utterance.pitchMultiplier = style == .robot ? 0.84 : style == .soft ? 1.04 : 1
        timeout = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self, self.generation == current, self.preparing else { return }
                self.stop(); self.error = "Системный голос не подготовил звук за 20 секунд. Попробуйте ещё раз."
            } catch { }
        }
        synth.write(utterance) { [weak self] buffer in
            guard let result = collector.append(buffer) else { return }
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                self.timeout?.cancel(); self.timeout = nil; self.preparing = false
                switch result {
                case .failure: self.stop(); self.error = "Не удалось подготовить локальную озвучку."
                case .clip(let clip): self.play(clip)
                }
            }
        }
    }
    private func startStream(text: String, language: String) {
        let current = generation, audio = RokiStreamPlayer()
        streamPlayer = audio; streamGenerating = true; firstAudioMs = nil; lastStreamUnderruns = 0; requestedAt = Date()
        audio.onComplete = { [weak self] in
            guard let self, self.generation == current else { return }
            self.lastFinishedPurpose = self.purpose
            self.stop()
        }
        audio.onFailure = { [weak self] in
            guard let self, self.generation == current else { return }
            self.stop(); self.error = "Потоковое воспроизведение прервалось."
        }
        streamWorker.synthesize(text: text, language: language) { [weak self] event in
            guard let self, self.generation == current else { return }
            switch event {
            case .pcm(let data, let rate):
                do {
                    try audio.append(data, rate: rate)
                    if self.firstAudioMs == nil { self.firstAudioMs = Date().timeIntervalSince(self.requestedAt) * 1000 }
                    self.duration = audio.duration; self.preparing = false; self.speaking = !audio.paused
                } catch { self.stop(); self.error = error.localizedDescription }
            case .end:
                self.streamGenerating = false; audio.finish()
            case .failure(let error): self.stop(); self.error = error.localizedDescription
            }
        }
    }
    private func play(_ clip: RokiAudioClip) {
        do {
            let player = try AVAudioPlayer(data: clip.wav, fileTypeHint: AVFileType.wav.rawValue)
            player.delegate = self
            guard player.prepareToPlay(), player.play() else { throw CocoaError(.fileReadUnknown) }
            self.clip = clip; self.player = player; self.duration = clip.duration; self.speaking = true
        } catch { stop(); self.error = "Не удалось воспроизвести голос." }
    }
    func stop() {
        generation = UUID(); timeout?.cancel(); timeout = nil
        synthesizer?.stopSpeaking(at: .immediate); synthesizer = nil
        espeak?.cancel(); espeak = nil
        qwen?.cancel(); qwen = nil
        streamWorker.cancel()
        if let streamPlayer { lastStreamUnderruns = streamPlayer.underruns; streamPlayer.stop() }
        streamPlayer = nil; streamGenerating = false
        player?.stop(); player = nil; clip = nil
        speaking = false; preparing = false; paused = false; duration = 0; purpose = nil
    }
    func togglePause() {
        if let streamPlayer {
            streamPlayer.togglePause(); paused = streamPlayer.paused; speaking = !paused; return
        }
        guard let player else { return }
        if paused {
            if player.play() { paused = false; speaking = true }
            else { stop(); error = "Не удалось продолжить озвучку." }
        } else if speaking { player.pause(); speaking = false; paused = true }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard self.player === player else { return }
            if flag { self.lastFinishedPurpose = self.purpose }
            self.stop()
            if !flag { self.error = "Озвучка прервалась." }
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            guard self.player === player else { return }
            self.stop(); self.error = "Ошибка воспроизведения голоса."
        }
    }
}
