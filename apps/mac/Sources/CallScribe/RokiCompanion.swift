import AppKit
import Combine
import SwiftUI

private final class RokiPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor final class RokiCompanionController: ObservableObject {
    let voice = RokiVoice()
    lazy var voiceBridge = RokiVoiceBridge(voice: voice)
    @Published var mcpEnabled = UserDefaults.standard.bool(forKey: "roki.mcpEnabled") {
        didSet {
            UserDefaults.standard.set(mcpEnabled, forKey: "roki.mcpEnabled")
            if mcpEnabled { voiceBridge.start() } else { voiceBridge.stop() }
        }
    }
    let schedule = RokiSchedule()
    @Published var visible = UserDefaults.standard.object(forKey: "roki.visible") as? Bool ?? true {
        didSet { UserDefaults.standard.set(visible, forKey: "roki.visible"); updateVisibility() }
    }
    @Published var followPointer = UserDefaults.standard.object(forKey: "roki.followPointer") as? Bool ?? true {
        didSet { UserDefaults.standard.set(followPointer, forKey: "roki.followPointer") }
    }
    @Published var emotionOverride: RokiEmotion?
    @Published private(set) var gesture: RokiGesture = .none
    @Published private(set) var gestureID = 0
    private var panel: RokiPanel?
    private weak var dictation: DictationModel?
    private weak var calls: CallModel?
    private var subscriptions = Set<AnyCancellable>()
    func perform(_ gesture: RokiGesture) { self.gesture = gesture; gestureID += 1 }
    func configure(dictation: DictationModel, calls: CallModel) {
        guard panel == nil else { return }
        self.dictation = dictation; self.calls = calls
        voice.canSpeak = { [weak dictation, weak calls] in
            guard let dictation, let calls else { return false }
            return !dictation.active && !calls.active && !calls.enrolling && !calls.panelOpen
        }
        voice.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
        schedule.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
        schedule.canDeliver = { [weak self] in
            guard let self else { return false }
            return !self.voice.busy && self.voice.canSpeak()
        }
        schedule.onReminder = { [weak self] reminder, aloud in
            guard let self else { return }
            self.visible = true; self.perform(.nod)
            if aloud { self.voice.speak(reminder.message, emotion: .attentive, purpose: "reminder:" + reminder.id) }
        }
        schedule.onClear = { [weak self] in
            if self?.voice.purpose?.hasPrefix("reminder:") == true { self?.voice.stop() }
        }
        schedule.$currentReminder.sink { [weak self] reminder in
            guard let panel = self?.panel else { return }
            let origin = panel.frame.origin
            panel.setContentSize(NSSize(width: 244, height: reminder == nil ? 486 : 560))
            panel.setFrameOrigin(origin)
        }.store(in: &subscriptions)
        dictation.$state.removeDuplicates().sink { [weak self] state in
            if state == "listening" { self?.perform(.nod) }
        }.store(in: &subscriptions)
        let panel = RokiPanel(contentRect: NSRect(x: 0, y: 0, width: 244, height: schedule.currentReminder == nil ? 486 : 560),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Роки · голосовая помощница"
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .floating; panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        if let screen = NSScreen.main {
            panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.maxX - 268, y: screen.visibleFrame.minY + 30))
        }
        self.panel = panel; updateVisibility(); schedule.start()
        if ProcessInfo.processInfo.arguments.contains("--enable-roki-mcp") { mcpEnabled = true }
        if mcpEnabled { voiceBridge.start() }
    }
    func shutdown() { voiceBridge.stop(); schedule.stop(); voice.shutdownVoice(); panel?.orderOut(nil); panel?.contentView = nil }
    private func updateVisibility() {
        guard let panel, let dictation, let calls else { return }
        if visible {
            panel.contentView = NSHostingView(rootView: RokiCompanionView(dictation: dictation, calls: calls, companion: self, hide: { [weak self] in self?.visible = false }))
            panel.orderFrontRegardless()
        } else { panel.orderOut(nil); panel.contentView = nil }
    }
    func emotion(dictation: DictationModel, calls: CallModel) -> RokiEmotion {
        if dictation.error != nil || calls.error != nil || voice.error != nil { return .concerned }
        if let emotionOverride { return emotionOverride }
        if voice.preparing { return .thinking }
        if voice.speaking || voice.paused { return voice.emotion }
        return .context(dictation: dictation.state, callActive: calls.active, hasError: false)
    }
}

struct RokiCompanionView: View {
    @ObservedObject var dictation: DictationModel
    @ObservedObject var calls: CallModel
    @ObservedObject var companion: RokiCompanionController
    let hide: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var caption: String {
        if companion.voice.preparing { return "Готовлю ответ…" }
        if companion.voice.paused { return "Озвучка на паузе" }
        if companion.voice.speaking { return "Роки говорит" }
        if dictation.error != nil || companion.voice.error != nil { return "Проверьте сообщение в приложении" }
        if dictation.active { return dictation.status }
        if calls.active { return "Расшифровываю созвон" }
        return "Роки · рядом"
    }
    var body: some View {
        VStack(spacing: 5) {
            HStack {
                Spacer()
                Button(action: hide) { Image(systemName: "xmark.circle.fill").font(.system(size: 17)).foregroundStyle(.secondary).background(.regularMaterial, in: Circle()) }
                    .buttonStyle(.plain).help("Скрыть помощницу").accessibilityLabel("Скрыть Роки")
            }.padding(.horizontal, 12)
            RokiStage(voice: companion.voice, emotion: companion.emotion(dictation: dictation, calls: calls),
                      gesture: companion.gesture, gestureID: companion.gestureID,
                      reduced: reduceMotion, followPointer: companion.followPointer)
                .frame(width: 205, height: 372)
                .accessibilityLabel("Роки · " + companion.emotion(dictation: dictation, calls: calls).title)
                .accessibilityAddTraits(.isImage)
                .allowsHitTesting(false)
            VStack(spacing: 6) {
                if let reminder = companion.schedule.currentReminder {
                    Text(reminder.title).font(.system(size: 11, weight: .semibold)).lineLimit(2)
                    HStack {
                        Button(reminder.source == .task ? "Выполнено" : "Понятно") { companion.schedule.completeCurrent() }
                        Button("Через 10 мин") { companion.schedule.snoozeCurrent() }
                    }
                }
                HStack(spacing: 5) {
                    Circle().fill(companion.voice.speaking ? .cyan : dictation.active || calls.active ? .green : .gray).frame(width: 6, height: 6)
                    Text(caption).font(.system(size: 10, weight: .medium)).lineLimit(2).multilineTextAlignment(.center)
                }
                if companion.voice.busy {
                    HStack {
                        if !companion.voice.preparing { Button(companion.voice.paused ? "Продолжить" : "Пауза") { companion.voice.togglePause() } }
                        Button("Замолчать") { companion.voice.stop() }
                    }
                } else if dictation.active {
                    Button("Остановить") { Task { await dictation.stop() } }.disabled(dictation.state == "stopping")
                } else {
                    Button("Включить «Роки»") { dictation.activationEnabled = true; dictation.toggle() }
                        .disabled(!calls.ready || calls.active || calls.enrolling || calls.panelOpen)
                }
            }.font(.system(size: 11)).padding(9).frame(width: 204).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 15))
        }.frame(width: 244, height: companion.schedule.currentReminder == nil ? 486 : 560)
    }
}

struct RokiPreview: View {
    @ObservedObject var companion: RokiCompanionController
    @ObservedObject var dictation: DictationModel
    @ObservedObject var calls: CallModel
    let close: () -> Void
    @State private var dark = true
    @State private var text = "Привет! Я Роки. Рада быть рядом. Помогу с планами и напомню, когда пора переходить к следующему делу."
    var body: some View {
        HStack(spacing: 0) {
            RokiCompanionView(dictation: dictation, calls: calls, companion: companion, hide: close)
                .padding(20).background(dark ? Color(red: 0.035, green: 0.045, blue: 0.07) : Color(white: 0.95))
            VStack(alignment: .leading, spacing: 16) {
                Text("Роки · характер и движения").font(.title3.bold())
                Text("Заботливая, спокойная, собранная. Помогает придерживаться плана и предлагает перенос, когда планы меняются.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Toggle("Тёмный фон", isOn: $dark)
                Toggle("Иногда смотреть на курсор", isOn: $companion.followPointer)
                Picker("Голос", selection: Binding(get: { companion.voice.style }, set: { companion.voice.style = $0 })) {
                    ForEach(RokiVoiceStyle.allCases) { style in Text(style.title).tag(style) }
                }.disabled(companion.voice.busy)
                Picker("Настроение", selection: $companion.emotionOverride) {
                    Text("По контексту").tag(Optional<RokiEmotion>.none)
                    ForEach(RokiEmotion.allCases) { emotion in Text(emotion.title).tag(Optional(emotion)) }
                }
                HStack { ForEach([RokiGesture.wave, .nod, .shrug]) { gesture in Button(gesture.title) { companion.perform(gesture) } } }
                Text("Что произнести").font(.caption.weight(.semibold))
                TextEditor(text: $text).frame(height: 85).font(.callout).border(.secondary.opacity(0.3))
                    .onChange(of: text) { text = String(text.prefix(600)) }
                Button("Произнести вслух", systemImage: "speaker.wave.2") {
                    companion.perform(.wave)
                    companion.voice.speak(text, emotion: companion.emotionOverride)
                }.disabled(dictation.active || calls.active || calls.enrolling || companion.voice.busy)
                if let error = companion.voice.error { Text(error).font(.caption).foregroundStyle(.red) }
                Text("Рот следует громкости звучащей речи. Все голоса работают локально. Во время записи озвучка ждёт.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button("Готово", action: close)
            }.padding(24).frame(width: 390)
        }.frame(height: companion.schedule.currentReminder == nil ? 600 : 650)
        .onDisappear { companion.emotionOverride = nil }
    }
}
