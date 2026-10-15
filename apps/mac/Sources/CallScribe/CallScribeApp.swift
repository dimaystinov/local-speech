import SwiftUI
import WebKit

@main struct CallScribeApp: App {
    @StateObject private var model: CallModel
    @StateObject private var dictation: DictationModel
    @StateObject private var companion: RokiCompanionController
    init() {
        let calls = CallModel()
        let avatar = RokiCompanionController()
        _companion = StateObject(wrappedValue: avatar)
        _model = StateObject(wrappedValue: calls)
        let input = DictationModel(sdk: calls.sdk,
            canStart: { calls.ready && !calls.active && !calls.enrolling && !calls.panelOpen && !avatar.voice.busy },
            configuration: { (calls.language, calls.terms.split(separator: ";").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }, calls.preferQuality) })
        calls.externalSessionActive = { [weak input, weak avatar] in (input?.active ?? false) || (avatar?.voice.busy ?? false) }
        input.ownerProfile = { [weak calls] in calls?.ownerProfile }
        input.voiceProfiles = { [weak calls] in calls?.voices ?? [] }
        _dictation = StateObject(wrappedValue: input)
    }
    @NSApplicationDelegateAdaptor(CallAppDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup("LocalSpeech Calls") {
            CallWindow(model: model, dictation: dictation, companion: companion).frame(minWidth: 560, minHeight: 440)
                .task {
                    delegate.model = model
                    delegate.dictation = dictation
                    delegate.companion = companion
                    companion.configure(dictation: dictation, calls: model)
                    dictation.registerShortcut()
                    await model.launch()
                    let arguments = ProcessInfo.processInfo.arguments
                    if let index = arguments.firstIndex(of: "--test-audio"), arguments.count > index + 1 {
                        await model.testFile(URL(fileURLWithPath: arguments[index + 1]))
                    }
                }
        }.defaultSize(width: 820, height: 680)
    }
}
@MainActor final class CallAppDelegate: NSObject, NSApplicationDelegate {
    weak var model: CallModel?
    weak var dictation: DictationModel?
    weak var companion: RokiCompanionController?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        companion?.shutdown()
        Task { dictation?.unregisterShortcut(); await dictation?.stop(); await model.stopOwnerVoice(); await model.stop(); model.save(); model.sdk.shutdown(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}
struct SDKEngineView: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
struct CallWindow: View {
    @ObservedObject var model: CallModel
    @ObservedObject var dictation: DictationModel
    @ObservedObject var companion: RokiCompanionController
    @State private var previewRoki = false
    @State private var showSettings = false
    @State private var showDictation = false
    @State private var copied = false
    private let blue = Color.accentColor
    private var busy: Bool { model.active || model.enrolling || dictation.active || companion.voice.busy }
    private var hasText: Bool { !model.document.lines.isEmpty || model.partials.values.contains { !$0.isEmpty } }
    private var languageLabel: String { model.language == "ru" ? "Русский" : model.language == "en" ? "English" : "Русский и English" }
    private var sourceLabel: String {
        let source = model.selection == 0 ? "звук Mac" : (model.applications.first { $0.id == model.selection }?.name ?? "выбранное приложение")
        return source + (model.microphone ? " и ваш микрофон" : "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 14) {
                Image(systemName: "waveform").font(.title2).foregroundStyle(blue)
                VStack(alignment: .leading, spacing: 4) {
                    TextField("Название созвона", text: $model.document.title)
                        .font(.title2.weight(.semibold)).textFieldStyle(.plain)
                    Text(model.active ? model.status : "Локально · \(languageLabel) · \(sourceLabel)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 0)
                Menu {
                    Button("Новый созвон", systemImage: "plus") { model.newDocument() }.disabled(busy)
                    Button("Расшифровать файл…", systemImage: "waveform.path") { model.chooseFile() }.disabled(busy || !model.ready)
                    Button("Сохранить TXT…", systemImage: "square.and.arrow.down") { model.export() }.disabled(model.document.lines.isEmpty)
                    Divider()
                    Button("Настройки…", systemImage: "slider.horizontal.3") { showSettings = true }
                } label: { Image(systemName: "ellipsis.circle").font(.title2) }
                    .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Ещё")
            }.padding(22)
            HStack(spacing: 12) {
                if model.active {
                    Button("Остановить", systemImage: "stop.fill") { Task { await model.stop() } }
                        .buttonStyle(.borderedProminent).tint(.red).disabled(model.state == "stopping")
                } else {
                    Button("Начать созвон", systemImage: "record.circle") { Task { await model.start() } }
                        .buttonStyle(.borderedProminent).disabled(!model.ready || busy)
                }
                Button(copied ? "Скопировано" : "Копировать весь текст", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    model.copyText(); copied = true
                }.disabled(!hasText)
                Spacer(minLength: 0)
                Button(dictation.active ? "Диктовка включена" : "Диктовать", systemImage: "mic") { showDictation = true }
                    .disabled(model.active || model.enrolling)
            }.controlSize(.large).padding(.horizontal, 22).padding(.bottom, 18)
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                    .padding(.horizontal, 22).padding(.bottom, 12)
            }
            Divider()
            if hasText {
                SelectableTranscriptView(text: model.document.readableText(partials: model.partials))
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "text.bubble").font(.system(size: 40, weight: .light)).foregroundStyle(.secondary)
                    Text("Весь разговор — в одном тексте").font(.title2.weight(.medium))
                    Text("Нажмите «Начать созвон». Источник: \(sourceLabel).\nЗатем скопируйте расшифровку и передайте её нейросети.")
                        .multilineTextAlignment(.center).foregroundStyle(.secondary)
                }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            HStack {
                Text(model.ready ? (model.active ? model.status : "Готово · обработка на этом Mac") : model.status)
                    .lineLimit(1)
                Spacer()
                Text("⌘A — выделить текст · ⌘C — копировать")
            }.font(.caption).foregroundStyle(.secondary).padding(14)
        }.background(Color(nsColor: .windowBackgroundColor))
            .onChange(of: model.document.lines) { copied = false }
            .onChange(of: model.partials) { copied = false }
            .onChange(of: model.document.title) { copied = false }
            .overlay(alignment: .topLeading) { SDKEngineView(webView: model.sdk.webView).frame(width: 1, height: 1).allowsHitTesting(false).accessibilityHidden(true) }
            .sheet(isPresented: $showSettings) {
                VStack(spacing: 0) {
                    HStack { Text("Настройки").font(.title2.bold()); Spacer(); Button("Готово") { showSettings = false }.keyboardShortcut(.cancelAction) }.padding(20)
                    Divider()
                    advancedSettings
                }.frame(width: 520, height: 620)
            }
            .sheet(isPresented: $showDictation) {
                VStack(alignment: .leading, spacing: 18) {
                    HStack { Text("Диктовка в любое поле").font(.title2.bold()); Spacer(); Button("Готово") { showDictation = false } }
                    if model.ownerProfile == nil {
                        Text("Чтобы принимать команды только от вас, сначала запомните ваш голос.").foregroundStyle(.secondary)
                        Button("Запомнить мой голос · 12 с") { model.recordOwnerVoice() }.disabled(busy || !model.ready)
                        if model.ownerEnrollmentActive { Button("Отменить запись") { model.cancelOwnerVoice() } }
                        Text(model.voiceStatus).font(.caption).foregroundStyle(.secondary)
                    }
                    DictationPanel(model: dictation, available: model.ready && !model.active && !model.enrolling && !companion.voice.busy)
                }.padding(24).frame(width: 500)
            }
    }
    private var advancedSettings: some View {
            ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("LocalSpeech", systemImage: "waveform").font(.title2.weight(.bold)).foregroundStyle(blue)
                    Text("Текст вашего созвона").font(.callout).foregroundStyle(.secondary)
                }
                Toggle("Роки · помощница на рабочем столе", isOn: $companion.visible).font(.callout)
                Toggle("Голос Роки через MCP", isOn: $companion.mcpEnabled).font(.callout)
                if companion.mcpEnabled {
                    Text(companion.voiceBridge.error ?? "Локальные MCP-клиенты могут озвучивать текст выбранным голосом Qwen и останавливать озвучку.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Button("Образ Роки", systemImage: "person.crop.rectangle") { previewRoki = true }
                    .sheet(isPresented: $previewRoki) {
                        RokiPreview(companion: companion, dictation: dictation, calls: model, close: { previewRoki = false })
                    }
                RokiSchedulePanel(model: companion.schedule)
                Divider()
                VStack(alignment: .leading, spacing: 10) {
                    Text("ЗВУК СОЗВОНА").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Picker("Приложение", selection: $model.selection) {
                        Text("Весь звук Mac").tag(Int32(0))
                        ForEach(model.applications) { app in Text(app.name).tag(app.id) }
                    }.labelsHidden().disabled(model.active || model.enrolling || dictation.active || companion.voice.busy).accessibilityLabel("Приложение созвона")
                    Button("Обновить приложения", systemImage: "arrow.clockwise") { Task { await model.refreshApplications() } }.disabled(model.active || model.enrolling || dictation.active || companion.voice.busy)
                    Text("Выберите Zoom, Telegram или браузер. При выборе всего звука в текст могут попасть другие приложения.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Toggle("Мой микрофон", isOn: $model.microphone).disabled(model.active || model.enrolling || dictation.active || companion.voice.busy)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("ЯЗЫК И ТЕРМИНЫ").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Picker("Язык", selection: $model.language) {
                        Text("Русский + English").tag("mixed")
                        Text("Русский · потоковый").tag("ru")
                        Text("English").tag("en")
                    }.labelsHidden().disabled(model.active || model.enrolling || dictation.active || companion.voice.busy).accessibilityLabel("Язык распознавания")
                    Picker("Приоритет", selection: $model.preferQuality) {
                        Text("Экономить ресурсы").tag(false)
                        Text("Автовыбор по ресурсам Mac").tag(true)
                    }.disabled(model.active || model.enrolling || dictation.active || companion.voice.busy)
                    TextField("Термины через ;", text: $model.terms).disabled(model.active || model.enrolling || dictation.active || companion.voice.busy)
                    Text("Подсказки применяются только поддерживающим их движком. Whisper пока использует только звук.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("ГОЛОСА · ЛОКАЛЬНО").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(model.ownerProfile == nil ? "Мой голос: ещё не обучен" : "Мой голос: готов к узнаванию").font(.caption)
                    Button(model.ownerProfile == nil ? "Запомнить мой голос · 12 с" : "Записать мой голос заново · 12 с", systemImage: "mic.badge.plus") { model.recordOwnerVoice() }
                        .disabled(model.active || model.enrolling || dictation.active || companion.voice.busy || !model.ready)
                    if model.ownerEnrollmentActive {
                        Button("Отменить обучение моего голоса") { model.cancelOwnerVoice() }
                    }
                    Text("После нажатия говорите 12 секунд: «Это мой голос. Роки, помоги мне проверить проект и составить план на сегодня. Я говорю спокойно, с обычными паузами». Записывайтесь без других голосов. Это фильтр команд, а не защита от записи или имитации голоса.").font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Toggle("Определять собеседников", isOn: $model.speakerEnabled).disabled(model.active || model.enrolling || dictation.active || companion.voice.busy)
                    TextField("Имя для образца", text: $model.voiceName).disabled(model.active || model.enrolling || dictation.active || companion.voice.busy)
                    Button("Добавить голос из файла", systemImage: "person.crop.circle.badge.plus") { model.chooseVoiceFile() }
                        .disabled(model.active || model.enrolling || dictation.active || companion.voice.busy || !model.ready || model.voiceName.trimmingCharacters(in: .whitespaces).isEmpty)
                    ForEach(model.voices) { voice in
                        HStack { Text(voice.name).font(.caption); Spacer(); Button("Удалить", systemImage: "trash") { model.removeVoice(voice.id) }.labelStyle(.iconOnly).disabled(model.active || model.enrolling || dictation.active || companion.voice.busy).help("Удалить профиль \(voice.name)") }
                    }
                    Text(model.voiceStatus).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Text("Имена — по образцу голоса. Возможны ошибки. При недостатке данных голос останется неопределённым.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(AudioChannel.allCases, id: \.self) { channel in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack { Text(channel.title); Spacer(); Text(model.backends[channel] ?? "—").font(.caption.monospaced()).foregroundStyle(.secondary) }
                            ProgressView(value: min(1, Double(model.levels[channel] ?? 0) * 8)).tint(channel == .call ? blue : .teal)
                            if let timing = model.timings[channel] { Text(timing).font(.system(size: 10)).foregroundStyle(.secondary) }
                        }
                    }
                    Text("Наушники уменьшают повтор голоса собеседников через микрофон.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Divider()
                Text("Аудио обрабатывает LocalSpeech SDK на этом Mac. Текст автоматически сохраняется локально.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(24)
            }.frame(maxWidth: .infinity)

    }
}
