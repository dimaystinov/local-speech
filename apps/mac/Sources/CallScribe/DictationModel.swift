import AppKit
import Combine
import AVFoundation
import UniformTypeIdentifiers

@MainActor final class DictationModel: ObservableObject {
    @Published private(set) var state = "idle"
    @Published private(set) var status = "Выберите поле и нажмите ⌘⇧D"
    @Published private(set) var draft = ""
    @Published private(set) var partial = ""
    @Published private(set) var level: Float = 0
    @Published private(set) var error: String?
    @Published private(set) var targetName = ""
    @Published private(set) var hasInsertedText = false
    @Published var rewriteEnabled = true
    @Published var activationEnabled = false
    @Published var ownerOnly = true
    var ownerProfile: () -> VoiceProfile? = { nil }
    var voiceProfiles: () -> [VoiceProfile] = { [] }
    private var voiceGate: VoiceCommandGate?
    private var voiceGateTimer: Timer?
    @Published var shareWithAgent = false { didSet { updateAgentBridge() } }
    @Published private(set) var revisedDraft = ""
    @Published private(set) var rewriteStatus = ""
    private let rewriter = LocalContextRewriter()
    private let agentBridge = AgentBridgeSnapshot()
    private var bridgeTimer: Timer?
    private var waitingForActivation = false
    private var pendingEdits = 0
    private var selectedText = ""
    private var recognitionLanguage = "mixed"
    var active: Bool { state != "idle" }
    private let sdk: SDKHost
    private let canStart: () -> Bool
    private let configuration: () -> (String, [String], Bool)
    private let microphone = DictationMicrophone()
    private let insertion = FocusedTextInsertion()
    private var hotKey: GlobalDictationHotKey?
    private var startTask: Task<Void, Never>?
    private var stopTask: Task<Void, Never>?
    private var editTask: Task<Void, Never>?
    private var packetizer: AudioPacketizer?
    private var generation = UUID()
    private var sessionID = UUID()
    private var ownsSDK = false
    private var writing = false
    private var precedingText = ""
    private var followingText = ""
    private var seen = Set<String>()
    private var previousEvent: ((AudioChannel, [String: Any]) -> Void)?
    private var previousFailure: ((String) -> Void)?
    private var previousVoice: (([String: Any]) -> Void)?

    init(sdk: SDKHost, canStart: @escaping () -> Bool, configuration: @escaping () -> (String, [String], Bool)) {
        self.sdk = sdk; self.canStart = canStart; self.configuration = configuration
    }
    func registerShortcut() {
        guard hotKey == nil else { return }
        let key = GlobalDictationHotKey { [weak self] in self?.toggle() }
        do { try key.register(); hotKey = key } catch { self.error = error.localizedDescription }
        agentBridge.clear()
        bridgeTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateAgentBridge() }
        }
    }
    func unregisterShortcut() { hotKey?.unregister(); hotKey = nil; bridgeTimer?.invalidate(); bridgeTimer = nil; shareWithAgent = false; agentBridge.clear() }
    func chooseTestFile() {
        guard !active, canStart() else { return }
        state = "choosing"
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.wav, .mp3, .mpeg4Audio, .aiff]; panel.allowsMultipleSelection = false
        let response = panel.runModal(); state = "idle"
        if response == .OK, let url = panel.url { toggle(delayed: true, audioFile: url) }
    }
    func toggle(delayed: Bool = false, audioFile: URL? = nil) {
        if active { Task { await stop() }; return }
        guard canStart() else { error = "Дождитесь готовности SDK и завершите созвон или добавление голоса."; return }
        let needsOwner = ownerOnly || activationEnabled
        let owner = ownerProfile()
        guard !needsOwner || owner?.valid == true else {
            error = "Сначала нажмите «Запомнить мой голос» в разделе голосов. Без образца команды не принимаются."
            return
        }
        let profiles = voiceProfiles()
        voiceGate = needsOwner ? VoiceCommandGate(ownerID: owner!.id) : nil
        state = delayed ? "arming" : "preparing"; error = nil; draft = ""; revisedDraft = ""; rewriteStatus = ""; partial = ""; targetName = ""; seen.removeAll(); waitingForActivation = activationEnabled; updateAgentBridge()
        generation = UUID(); sessionID = generation; hasInsertedText = false; let current = generation
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                if delayed { self.status = "За 3 секунды выберите поле для диктовки"; try await Task.sleep(nanoseconds: 3_000_000_000) }
                try Task.checkCancellation()
                self.writing = false; self.precedingText = ""; self.followingText = ""; self.selectedText = ""
                if !self.waitingForActivation { await self.captureTarget() }
                try Task.checkCancellation()
                guard self.generation == current else { return }
                self.previousEvent = self.sdk.onEvent; self.previousFailure = self.sdk.onFailure; self.previousVoice = self.sdk.onVoiceMessage
                self.ownsSDK = true
                self.sdk.onEvent = { [weak self] channel, event in
                    guard channel == .microphone, self?.generation == current else { return }
                    self?.receive(event)
                }
                self.sdk.onFailure = { [weak self] message in self?.fail(message) }
                self.sdk.onVoiceMessage = { [weak self] message in
                    guard let self, self.generation == current else { return }
                    let rejected = self.voiceGate?.rejected
                    if let accepted = self.voiceGate?.submit(message, voice: true, now: ProcessInfo.processInfo.systemUptime) {
                        for event in accepted { self.receiveVerified(event) }
                    }
                    if rejected != self.voiceGate?.rejected { self.status = self.voiceGate?.lastRejection?.message ?? "Реплика пропущена." }
                }
                self.voiceGateTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                    Task { @MainActor in
                        guard let self, self.generation == current else { return }
                        let rejected = self.voiceGate?.rejected
                        if let accepted = self.voiceGate?.drain(now: ProcessInfo.processInfo.systemUptime) {
                            for event in accepted { self.receiveVerified(event) }
                        }
                        if rejected != self.voiceGate?.rejected { self.status = self.voiceGate?.lastRejection?.message ?? "Реплика пропущена." }
                    }
                }
                self.state = "preparing"; self.status = "Подготовка локального распознавания…"
                let (language, terms, quality) = self.configuration(); self.recognitionLanguage = language
                try await self.sdk.start(language: language, terms: terms, channels: [.microphone], allowLargeModels: quality,
                    speakerEnabled: needsOwner, voiceProfiles: needsOwner ? profiles.filter { $0.id != owner!.id } + [owner!] : [])
                try Task.checkCancellation()
                let packets = AudioPacketizer(emit: { [weak self] channel, data, rate in
                    DispatchQueue.main.async {
                        guard let self, self.generation == current, self.ownsSDK else { return }
                        self.sdk.send(channel, data: data, rate: rate)
                    }
                }, error: { [weak self] message in Task { @MainActor in self?.fail(message) } })
                self.packetizer = packets
                if let audioFile {
                    let file = try AVAudioFile(forReading: audioFile)
                    let rate = file.processingFormat.sampleRate
                    guard rate.isFinite, (8000...96000).contains(rate), Double(file.length) / rate <= 300 else {
                        throw NSError(domain: "LocalSpeech.Dictation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Для проверки выберите аудио до 5 минут с частотой 8–96 кГц."])
                    }
                    self.state = "listening"; self.status = "Проверка файла · микрофон выключен"
                    let frames = AVAudioFrameCount(rate / 10)
                    while file.framePosition < file.length {
                        try Task.checkCancellation()
                        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames)!
                        try file.read(into: buffer); packets.append(buffer, channel: .microphone)
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                    Task { await self.stop() }
                    return
                }
                try await self.microphone.start(onAudio: { packets.append($0, channel: .microphone) }, onLevel: { [weak self] value in
                    Task { @MainActor in if self?.generation == current { self?.level = value } }
                }, onError: { [weak self] message in Task { @MainActor in self?.fail(message) } })
                try Task.checkCancellation()
                self.state = "listening"
                self.status = self.waitingForActivation ? "Слушаю «Роки» или «Роки два»" : (self.writing ? "Диктуйте · ⌘⇧D — остановить" : "Только черновик · ⌘⇧D — остановить")
                self.updateAgentBridge()
            } catch {
                if !(error is CancellationError) { self.error = error.localizedDescription }
                if self.stopTask == nil { Task { await self.stop() } }
            }
        }
    }
    func stop() async {
        if let stopTask { await stopTask.value; return }
        guard active else { return }
        let task = Task { await finishStop() }; stopTask = task
        await task.value; stopTask = nil
    }
    private func finishStop() async {
        state = "stopping"; status = "Завершение диктовки…"; startTask?.cancel()
        await microphone.stop()
        packetizer?.flush()
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
        if ownsSDK { await sdk.stop() }
        await startTask?.value; startTask = nil
        await editTask?.value; editTask = nil
        voiceGateTimer?.invalidate(); voiceGateTimer = nil; voiceGate?.close(); voiceGate = nil
        if ownsSDK { sdk.onEvent = previousEvent; sdk.onFailure = previousFailure; sdk.onVoiceMessage = previousVoice }
        ownsSDK = false; previousEvent = nil; previousFailure = nil; previousVoice = nil
        generation = UUID(); packetizer = nil; writing = false; level = 0; partial = ""
        state = "idle"; status = error == nil ? "Готово · ⌘⇧D — новая диктовка" : "Диктовка остановлена · проверьте сообщение"
        updateAgentBridge()
        // Retain the last verified transaction for explicit Undo; target is replaced on next start.
    }
    private func receive(_ event: [String: Any]) {
        if voiceGate != nil {
            if event["type"] as? String == "partial" { return }
            if event["type"] as? String == "final" {
                status = "Проверяю ваш голос… Чужая и неоднозначная речь пропускается."
                let rejected = voiceGate!.rejected
                for accepted in voiceGate!.submit(event, now: ProcessInfo.processInfo.systemUptime) { receiveVerified(accepted) }
                if rejected != voiceGate!.rejected { status = voiceGate!.lastRejection?.message ?? "Реплика пропущена." }
                return
            }
        }
        receiveVerified(event)
    }
    private func receiveVerified(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "partial": if !waitingForActivation { partial = event["text"] as? String ?? "" }
        case "clear-partial": partial = ""
        case "final":
            guard var text = event["rawText"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            if voiceGate != nil { status = "Ваш голос распознан · принимаю диктовку" }
            if let session = event["sessionId"] as? String, let segment = event["segmentId"] as? Int {
                guard seen.insert("\(session):\(segment)").inserted else { return }
                if seen.count > 2048 { seen = ["\(session):\(segment)"] }
            }
            let activating = waitingForActivation
            if activating {
                guard let remainder = DictationActivation.consume(text, waitingForActivation: true) else { return }
                waitingForActivation = false; text = remainder; status = "Роки активирован · принимаю диктовку"
            }
            partial = ""
            if !text.isEmpty { draft = String((draft + (draft.isEmpty ? "" : " ") + text).suffix(20_000)) }
            let previous = editTask, raw = text
            pendingEdits += 1
            let shouldRewrite = rewriteEnabled && pendingEdits <= 2
            editTask = Task { [weak self] in
                await previous?.value
                guard let self else { return }
                defer { self.pendingEdits -= 1; self.updateAgentBridge() }
                if activating { await self.captureTarget() }
                guard !raw.isEmpty else { return }
                let context = DictationTargetContext(applicationName: self.targetName, selectedText: self.selectedText,
                    precedingText: self.precedingText, followingText: self.followingText)
                var revised = raw
                if shouldRewrite {
                    let result = await self.rewriter.rewrite(raw: raw, context: context, language: self.recognitionLanguage)
                    revised = result.text; self.rewriteStatus = result.warning ?? (result.engine ?? "Исходный текст")
                }
                self.revisedDraft = String((self.revisedDraft + (self.revisedDraft.isEmpty ? "" : " ") + revised).suffix(20_000))
                guard self.writing else { return }
                let addition = DictationFormatting.join(revised, after: self.precedingText, before: self.followingText)
                do {
                    _ = try await self.insertion.insertFinal(addition)
                    self.hasInsertedText = true
                    self.precedingText = String((self.precedingText + addition).suffix(240)); self.selectedText = ""
                } catch { self.writing = false; self.hasInsertedText = false; self.fail(error.localizedDescription) }
            }
            updateAgentBridge()
        case "progress": if state == "preparing" { status = event["message"] as? String ?? status }
        case "warning": status = event["message"] as? String ?? status
        case "error": fail(event["message"] as? String ?? "Ошибка распознавания")
        default: break
        }
    }
    private func captureTarget() async {
        do {
            let context = try await insertion.captureTarget()
            targetName = context.applicationName; precedingText = context.precedingText
            followingText = context.followingText; selectedText = context.selectedText; writing = true
        } catch { writing = false; self.error = error.localizedDescription }
    }
    private func updateAgentBridge() {
        guard shareWithAgent else { agentBridge.clear(); return }
        do { try agentBridge.write(session: sessionID, status: state, raw: draft, text: revisedDraft) }
        catch { shareWithAgent = false; self.error = "Не удалось открыть локальный доступ агента к черновику." }
    }
    private func fail(_ message: String) { error = message; if active && state != "stopping" { Task { await stop() } } }
    func undo() {
        guard !active, canStart() else { return }
        state = "undoing"; status = "За 3 секунды вернитесь в то же поле для отмены"
        startTask = Task {
            do {
                try await Task.sleep(nanoseconds: 3_000_000_000)
                try Task.checkCancellation()
                try await insertion.undoLast(); status = "Последняя вставка отменена"
            } catch {
                if !(error is CancellationError) { self.error = error.localizedDescription }
            }
            if state == "undoing" { state = "idle" }
        }
    }
    func submit() {
        guard !active, canStart(), hasInsertedText else { return }
        state = "submitting"; status = "За 3 секунды вернитесь в поле сообщения для отправки"
        startTask = Task {
            do {
                try await Task.sleep(nanoseconds: 3_000_000_000)
                try Task.checkCancellation()
                try await insertion.submit()
                hasInsertedText = false
                status = "Нажата кнопка отправки · проверьте результат в приложении"
            } catch {
                if !(error is CancellationError) { self.error = error.localizedDescription }
            }
            if state == "submitting" { state = "idle" }
            updateAgentBridge()
        }
    }
    func copyDraft(original: Bool = false) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(original || revisedDraft.isEmpty ? draft : revisedDraft, forType: .string)
    }
    func openAccessibilitySettings() { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!) }
}

enum DictationFormatting {
    /// Context only controls word boundaries; never silently rewrite names, numbers, or meaning.
    static func join(_ text: String, after prefix: String, before suffix: String = "") -> String {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = text.first else { return "" }
        if let last = prefix.last, !last.isWhitespace,
           !"([{«“/".contains(last), !".,!?;:)]}»”".contains(first) { text = " " + text }
        if let next = suffix.first, !next.isWhitespace,
           !".,!?;:)]}»”".contains(next), let last = text.last, !"([{«“/".contains(last) { text += " " }
        return text
    }
}
