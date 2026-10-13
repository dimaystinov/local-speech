import SwiftUI
import WebKit

@main struct CallScribeApp: App {
    @StateObject private var model = CallModel()
    @NSApplicationDelegateAdaptor(CallAppDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup("LocalSpeech Calls") {
            CallWindow(model: model).frame(minWidth: 900, minHeight: 620)
                .task {
                    delegate.model = model
                    await model.launch()
                    let arguments = ProcessInfo.processInfo.arguments
                    if let index = arguments.firstIndex(of: "--test-audio"), arguments.count > index + 1 {
                        await model.testFile(URL(fileURLWithPath: arguments[index + 1]))
                    }
                }
        }.defaultSize(width: 1080, height: 760)
    }
}
@MainActor final class CallAppDelegate: NSObject, NSApplicationDelegate {
    weak var model: CallModel?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        Task { await model.stop(); model.save(); model.sdk.shutdown(); sender.reply(toApplicationShouldTerminate: true) }
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
    private let ink = Color(red: 0.13, green: 0.19, blue: 0.26)
    private let blue = Color(red: 0.15, green: 0.38, blue: 0.68)
    var body: some View {
        HStack(spacing: 0) {
            ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("LocalSpeech", systemImage: "waveform").font(.title2.weight(.bold)).foregroundStyle(blue)
                    Text("Текст вашего созвона").font(.callout).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("ЗВУК СОЗВОНА").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Picker("Приложение", selection: $model.selection) {
                        Text("Весь звук Mac").tag(Int32(0))
                        ForEach(model.applications) { app in Text(app.name).tag(app.id) }
                    }.labelsHidden().disabled(model.active || model.enrolling).accessibilityLabel("Приложение созвона")
                    Button("Обновить приложения", systemImage: "arrow.clockwise") { Task { await model.refreshApplications() } }.disabled(model.active || model.enrolling)
                    Text("Выберите Zoom, Telegram или браузер. При выборе всего звука в текст могут попасть другие приложения.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Toggle("Мой микрофон", isOn: $model.microphone).disabled(model.active || model.enrolling)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("ЯЗЫК И ТЕРМИНЫ").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Picker("Язык", selection: $model.language) {
                        Text("Русский + English").tag("mixed")
                        Text("Русский · потоковый").tag("ru")
                        Text("English").tag("en")
                    }.labelsHidden().disabled(model.active || model.enrolling).accessibilityLabel("Язык распознавания")
                    Picker("Приоритет", selection: $model.preferQuality) {
                        Text("Скорость").tag(false)
                        Text("Точность · медленнее").tag(true)
                    }.disabled(model.active || model.enrolling)
                    TextField("Термины через ;", text: $model.terms).disabled(model.active || model.enrolling)
                    Text("Подсказки применяются только поддерживающим их движком. Whisper пока использует только звук.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("ГОЛОСА · ЛОКАЛЬНО").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Toggle("Определять собеседников", isOn: $model.speakerEnabled).disabled(model.active || model.enrolling)
                    TextField("Имя для образца", text: $model.voiceName).disabled(model.active || model.enrolling)
                    Button("Добавить голос из файла", systemImage: "person.crop.circle.badge.plus") { model.chooseVoiceFile() }
                        .disabled(model.active || model.enrolling || !model.ready || model.voiceName.trimmingCharacters(in: .whitespaces).isEmpty)
                    ForEach(model.voices) { voice in
                        HStack { Text(voice.name).font(.caption); Spacer(); Button("Удалить", systemImage: "trash") { model.removeVoice(voice.id) }.labelStyle(.iconOnly).disabled(model.active || model.enrolling).help("Удалить профиль \(voice.name)") }
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
            }.frame(width: 290).background(Color(red: 0.94, green: 0.96, blue: 0.98))
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 6) {
                        TextField("Название созвона", text: $model.document.title).font(.title.weight(.semibold)).textFieldStyle(.plain)
                        HStack(spacing: 7) {
                            Circle().fill(model.state == "listening" ? Color.red : Color.gray.opacity(0.4)).frame(width: 7, height: 7)
                            Text(model.status).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    Spacer()
                    if model.active {
                        Button("Остановить", systemImage: "stop.fill") { Task { await model.stop() } }.buttonStyle(.borderedProminent).tint(.red).disabled(model.state == "stopping")
                    } else {
                        Button("Начать созвон", systemImage: "record.circle") { Task { await model.start() } }.buttonStyle(.borderedProminent).tint(blue).disabled(!model.ready || model.enrolling)
                    }
                }.padding(28)
                if let error = model.error {
                    HStack(alignment: .top) { Image(systemName: "exclamationmark.triangle"); Text(error).textSelection(.enabled) }.font(.callout).foregroundStyle(Color(red: 0.65, green: 0.21, blue: 0.12)).padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Color.orange.opacity(0.09)).padding(.horizontal, 28)
                }
                ScrollViewReader { reader in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 22) {
                            if model.document.lines.isEmpty && model.partials.values.allSatisfy(\.isEmpty) {
                                VStack(alignment: .leading, spacing: 16) {
                                    Image(systemName: "quote.bubble").font(.system(size: 38, weight: .light)).foregroundStyle(blue.opacity(0.7))
                                    Text("Разговор превращается в текст").font(.title2.weight(.medium))
                                    Text("Выберите приложение и включите созвон. Здесь будут появляться фразы — ваши и собеседников.").foregroundStyle(.secondary).lineSpacing(5)
                                    Text("Русский режим обновляет текст потоком. В смешанном режиме Whisper обрабатывает окна и паузы; задержка зависит от Mac.").font(.callout).foregroundStyle(.secondary)
                                }.padding(.top, 75).padding(.trailing, 30)
                            }
                            ForEach(model.document.lines) { line in
                                VStack(alignment: .leading, spacing: 7) {
                                    HStack { Text(line.speakerLabel).font(.caption.weight(.semibold)).foregroundStyle(line.channel == .call ? blue : .teal); Text(TranscriptDocument.timestamp(line.seconds)).font(.caption.monospacedDigit()).foregroundStyle(.tertiary) }
                                    Text(line.text).font(.system(size: 18)).lineSpacing(5).textSelection(.enabled)
                                    if let speaker = line.speaker, (speaker.intervals?.filter { $0.kind != "silence" }.count ?? 0) > 1 {
                                        DisclosureGroup("Голоса по времени") {
                                            Text(speaker.timeline(baseSeconds: line.seconds)).font(.caption.monospacedDigit()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                            Text("Метки относятся к звуку; отдельные слова между говорящими не распределены.").font(.caption2).foregroundStyle(.secondary)
                                        }.font(.caption)
                                    }
                                    if model.voiceSamples.contains(line.id) {
                                        Button("Запомнить голос из этой реплики") { model.rememberVoice(line) }.font(.caption)
                                            .disabled(model.active || model.enrolling || model.voiceName.trimmingCharacters(in: .whitespaces).isEmpty || line.speaker?.kind == "mixed")
                                    }
                                }
                            }
                            ForEach(AudioChannel.allCases, id: \.self) { channel in
                                if let text = model.partials[channel], !text.isEmpty {
                                    VStack(alignment: .leading, spacing: 6) { Text(channel.title + " · распознаётся").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true); Text(text).font(.system(size: 18)).foregroundStyle(.secondary).textSelection(.enabled) }
                                }
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 32).padding(.bottom, 24)
                    }.onChange(of: model.document.lines.count) { reader.scrollTo("bottom", anchor: .bottom) }
                }
                Divider()
                HStack {
                    Button("Новый созвон", systemImage: "plus") { model.newDocument() }.disabled(model.active || model.enrolling)
                    Button("Проверить файл", systemImage: "waveform.path") { model.chooseFile() }.disabled(model.active || model.enrolling || !model.ready)
                    Spacer()
                    Button("Копировать", systemImage: "doc.on.doc") { model.copyText() }.disabled(model.document.lines.isEmpty)
                    Button("Сохранить TXT", systemImage: "square.and.arrow.down") { model.export() }.disabled(model.document.lines.isEmpty)
                }.padding(18)
            }.background(Color.white)
        }.foregroundStyle(ink).preferredColorScheme(.light)
            .overlay(alignment: .topLeading) { SDKEngineView(webView: model.sdk.webView).frame(width: 1, height: 1).allowsHitTesting(false).accessibilityHidden(true) }
    }
}
