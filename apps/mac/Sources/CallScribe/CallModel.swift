import AppKit
import AVFoundation
import Combine
import UniformTypeIdentifiers

@MainActor final class CallModel: ObservableObject {
    let sdk = SDKHost()
    private let capture = MacCallCapture()
    private let archive = TranscriptArchive()
    private let voiceStore = VoiceProfileStore()
    private var packetizer: AudioPacketizer?
    private var generation = 0
    private var sessionStarted = Date()
    private var sessionOffset: Double = 0
    private var launched = false
    private var stopTask: Task<Void, Never>?
    private var normalizedTerms: [String] { terms.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    @Published var document = TranscriptDocument()
    @Published var applications: [CaptureApplication] = []
    @Published var selection: Int32 = 0
    @Published var microphone = true
    @Published var language = "mixed"
    @Published var terms = ""
    @Published var preferQuality = false
    @Published var speakerEnabled = true
    @Published var voiceName = ""
    @Published var voices: [VoiceProfile] = []
    @Published var voiceStatus = "Сохраните чистый образец: 3–15 секунд речи одного человека."
    @Published var enrolling = false
    @Published var voiceSamples = Set<String>()
    @Published var timings: [AudioChannel: String] = [:]
    @Published var state = "idle"
    @Published var status = "Подготовка SDK…"
    @Published var error: String?
    @Published var partials: [AudioChannel: String] = [:]
    @Published var levels: [AudioChannel: Float] = [:]
    @Published var backends: [AudioChannel: String] = [:]
    @Published var ready = false
    var active: Bool { state != "idle" }
    var elapsed: Double { max(0, Date().timeIntervalSince(sessionStarted)) }
    init() {
        if let previous = archive.latest() { document = previous }
        sdk.onEvent = { [weak self] channel, event in self?.receive(channel, event) }
        do { voices = try voiceStore.load() } catch { self.error = "Не удалось прочитать профили голосов: \(error.localizedDescription)" }
        sdk.onVoiceMessage = { [weak self] message in self?.receiveVoice(message) }
        sdk.onFailure = { [weak self] message in self?.fail(message) }
    }
    func launch() async {
        guard !launched else { return }; launched = true
        do { try await sdk.launch(); ready = true; status = "Готово к созвону" }
        catch { self.error = error.localizedDescription; status = "SDK не запущен" }
    }
    func refreshApplications() async {
        do { applications = try await capture.applications(); if selection != 0 && !applications.contains(where: { $0.id == selection }) { selection = 0 } }
        catch { self.error = "Нет доступа к звуку приложений: \(error.localizedDescription)" }
    }
    func start() async {
        guard !active, !enrolling, ready else { return }
        generation += 1; let current = generation
        voiceSamples = []
        state = "preparing"; status = "Подготовка моделей SDK…"; error = nil
        partials = [:]; backends = [:]; timings = [:]; sessionStarted = Date(); sessionOffset = document.durationSeconds ?? document.lines.last?.seconds ?? 0
        let channels: [AudioChannel] = microphone ? [.microphone, .call] : [.call]
        do {
            try await sdk.start(language: language, terms: normalizedTerms, channels: channels, allowLargeModels: preferQuality, speakerEnabled: speakerEnabled, voiceProfiles: voices)
            guard current == generation else { return }
            status = "Подключение звука · проверьте запросы разрешений macOS"
            let packets = AudioPacketizer(emit: { [weak self] channel, data, rate in
                DispatchQueue.main.async { guard let self, self.generation == current, self.active else { return }; self.sdk.send(channel, data: data, rate: rate) }
            }, error: { [weak self] message in Task { @MainActor in self?.fail(message) } })
            packetizer = packets
            try await capture.start(applicationID: selection == 0 ? nil : selection, includeMicrophone: microphone, onAudio: { channel, buffer in packets.append(buffer, channel: channel) }, onLevel: { [weak self] channel, level in
                Task { @MainActor in guard let self, self.generation == current else { return }; self.levels[channel] = level }
            }, onError: { [weak self] message in self?.fail(message) })
            guard current == generation else { await capture.stop(); return }
            sessionStarted = Date(); state = "listening"; status = "Идёт расшифровка"
        } catch { if current == generation { self.error = captureError(error); await stop() } }
    }
    func stop() async {
        if let stopTask { await stopTask.value; return }
        guard active else { return }
        let task = Task { await finishStop() }
        stopTask = task
        await task.value
        stopTask = nil
    }
    private func finishStop() async {
        if state == "preparing" { generation += 1 }
        state = "stopping"; status = "Завершаю последние фразы…"
        await capture.stop(); packetizer?.flush()
        // Allow tail packets already scheduled by the serial capture queue to enter SDK.
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
        await sdk.stop(); generation += 1; packetizer = nil
        partials = [:]; levels = [:]; state = "idle"; status = error == nil ? "Сеанс завершён · текст сохранён" : "Сеанс остановлен"
        save()
    }
    private func fail(_ message: String) {
        error = message
        if active && state != "stopping" { Task { await self.stop() } }
    }
    private func receive(_ channel: AudioChannel, _ event: [String: Any]) {
        switch event["type"] as? String {
        case "partial": partials[channel] = event["text"] as? String
        case "clear-partial": partials[channel] = nil
        case "final":
            partials[channel] = nil
            if let text = event["rawText"] as? String, let session = event["sessionId"] as? String, let segment = event["segmentId"] as? Int {
                let start = (event["startMs"] as? Double).flatMap { $0.isFinite && $0 >= 0 ? $0 / 1000 : nil } ?? elapsed
                document.append(channel: channel, session: session, segment: segment, seconds: sessionOffset + start, text: text)
                let end = (event["endMs"] as? Double).flatMap { $0.isFinite && $0 >= 0 ? $0 / 1000 : nil } ?? start
                document.durationSeconds = max(document.durationSeconds ?? 0, sessionOffset + end); save()
                if let ms = event["processing_ms"] as? Double, ms.isFinite {
                    timings[channel] = String(format: "Завершение %.1f с · звук %.1f с", ms / 1000, max(0, end - start))
                }
            }
        case "backend": backends[channel] = event["backend"] as? String
        case "progress": if state == "preparing" { status = event["message"] as? String ?? status }
        case "warning": status = event["message"] as? String ?? "Предупреждение SDK"
        case "error": fail(event["message"] as? String ?? "Ошибка распознавания")
        default: break
        }
    }
    func newDocument() {
        guard !active else { return }; save(); document = TranscriptDocument(); partials = [:]; error = nil; status = "Новый созвон"
    }
    func save() {
        guard !document.lines.isEmpty else { return }
        do { try archive.save(document) } catch { self.error = "Не удалось сохранить текст: \(error.localizedDescription)" }
    }
    func export() {
        let panel = NSSavePanel(); panel.allowedContentTypes = [.plainText]; panel.nameFieldStringValue = "Созвон.txt"
        if panel.runModal() == .OK, let url = panel.url {
            do { try document.plainText.write(to: url, atomically: true, encoding: .utf8) } catch { self.error = error.localizedDescription }
        }
    }
    func copyText() { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(document.plainText, forType: .string) }
    // File mode exercises the same SDK bridge without granting capture permissions.
    func testFile(_ url: URL) async {
        guard !active, !enrolling, ready else { return }
        generation += 1; let current = generation
        voiceSamples = []
        save(); partials = [:]; backends = [:]; timings = [:]
        state = "preparing"; status = "Проверка файла через SDK…"; error = nil; document = TranscriptDocument(); sessionStarted = Date(); sessionOffset = 0
        do {
            try await sdk.start(language: language, terms: normalizedTerms, channels: [.call], allowLargeModels: preferQuality, speakerEnabled: speakerEnabled, voiceProfiles: voices)
            guard current == generation else { return }
            state = "listening"
            let file = try AVAudioFile(forReading: url)
            let frames = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
            let packets = AudioPacketizer(emit: { [weak self] channel, data, rate in
                DispatchQueue.main.async { guard let self, self.generation == current, self.active else { return }; self.sdk.send(channel, data: data, rate: rate) }
            }, error: { [weak self] message in Task { @MainActor in self?.fail(message) } })
            packetizer = packets
            while file.framePosition < file.length && state == "listening" && current == generation {
                let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames)!
                try file.read(into: buffer); packets.append(buffer, channel: .call)
                await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }; try await sdk.drain()
            }
            if current == generation { await stop() }
        } catch { if current == generation { self.error = error.localizedDescription; await stop() } }
    }
    private func receiveVoice(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "speaker":
            guard let channel = message["channel"] as? String, let session = message["sessionId"] as? String, let segment = message["segmentId"] as? Int,
                  let label = message["label"] as? String, let kind = message["kind"] as? String else { return }
            let id = "\(channel):\(session):\(segment)"
            document.attribute(id: id, speaker: VoiceAttribution(label: label, kind: kind, speakerId: message["speakerId"] as? String)); save()
            if message["canEnroll"] as? Bool == true { voiceSamples.insert(id) }
        case "speaker-status", "voice-error": voiceStatus = message["message"] as? String ?? "Голос не определён"
        case "voice-profile":
            do {
                let data = try JSONSerialization.data(withJSONObject: message["profile"] ?? [:])
                let profile = try JSONDecoder().decode(VoiceProfile.self, from: data)
                let updated = voices + [profile]; try voiceStore.save(updated); voices = updated
                voiceStatus = "Голос «\(profile.name)» сохранён локально. На следующем созвоне включите определение голосов."
                voiceName = ""
            } catch { voiceStatus = "Не удалось сохранить профиль: \(error.localizedDescription)" }
        default: break
        }
    }
    func removeVoice(_ id: String) {
        guard !active, !enrolling else { return }
        do { let updated = voices.filter { $0.id != id }; try voiceStore.save(updated); voices = updated }
        catch { voiceStatus = error.localizedDescription }
    }
    func rememberVoice(_ line: TranscriptLine) {
        guard !active, !enrolling, !voiceName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        enrolling = true; voiceStatus = "Сравниваю части образца и сохраняю голос…"
        Task {
            defer { enrolling = false }
            do { try await sdk.enrollVoice(name: voiceName, segmentKey: line.id) }
            catch { voiceStatus = error.localizedDescription }
        }
    }
    func chooseVoiceFile() {
        guard !active, !enrolling, !voiceName.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.wav, .mp3, .mpeg4Audio, .aiff]; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        enrolling = true; voiceStatus = "Проверяю образец голоса…"
        Task {
            defer { enrolling = false }
            do {
                let file = try AVAudioFile(forReading: url), rate = file.processingFormat.sampleRate
                guard (8000...96000).contains(rate), Double(file.length) / rate >= 3, Double(file.length) / rate <= 15 else {
                    throw NSError(domain: "CallScribe", code: 8, userInfo: [NSLocalizedDescriptionKey: "Выберите от 3 до 15 секунд речи одного человека, частота 8–96 кГц."])
                }
                let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
                try file.read(into: buffer)
                var data = Data(), issue: String?
                let packetizer = AudioPacketizer(emit: { _, chunk, _ in data.append(chunk) }, error: { issue = $0 })
                packetizer.append(buffer, channel: .call); packetizer.flush()
                if let issue { throw NSError(domain: "CallScribe", code: 9, userInfo: [NSLocalizedDescriptionKey: issue]) }
                try await sdk.enrollVoice(name: voiceName, data: data, rate: rate)
            } catch { voiceStatus = error.localizedDescription }
        }
    }
    private func captureError(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain", ns.code == -3801 {
            return "Нет доступа к звуку созвона. В настройках macOS → Конфиденциальность и безопасность → Запись экрана и системного аудио разрешите LocalSpeech Calls, затем перезапустите приложение. Проверка файла доступна без этого разрешения."
        }
        return error.localizedDescription
    }
    func chooseFile() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.wav, .mp3, .mpeg4Audio]; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { Task { await testFile(url) } }
    }
}
