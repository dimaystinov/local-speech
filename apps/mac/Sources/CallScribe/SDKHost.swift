import AppKit
import WebKit
import Combine

@MainActor final class SDKHost: NSObject, ObservableObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    private var server: AssetServer?
    private var origin: URL?
    private var waits: [String: CheckedContinuation<Void, Error>] = [:]
    private var pending: [Int: (AudioChannel, Date)] = [:]
    private var refinementAudio: [AudioChannel: RefinementPCMWindow] = [:]
    private var nextPacket = 0
    private var waitIDs: [String: UUID] = [:]
    private var watchdog: Timer?
    private var activeWork: Set<String> = []
    private var shuttingDown = false
    var onEvent: ((AudioChannel, [String: Any]) -> Void)?
    var onVoiceMessage: (([String: Any]) -> Void)?
    var onFailure: ((String) -> Void)?
    @Published var booted = false
    var outstanding: Int { pending.count }
    override init() {
        let config = WKWebViewConfiguration()
        // The app bundles weights; no cross-launch duplicate caches at ephemeral origins.
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "speech")
        webView.navigationDelegate = self
    }
    func launch() async throws {
        keepRunning("boot", true)
        defer { keepRunning("boot", false) }
        guard let resources = Bundle.main.resourceURL else { throw NSError(domain: "CallScribe", code: 1, userInfo: [NSLocalizedDescriptionKey: "Не найдены ресурсы приложения"]) }
        let root = resources.appendingPathComponent("Web")
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("sdk/local-speech.js").path) else { throw NSError(domain: "CallScribe", code: 2, userInfo: [NSLocalizedDescriptionKey: "Соберите приложение командой apps/mac/build.sh"]) }
        let service = AssetServer(documentRoot: root); server = service; origin = try await service.start()
        try await wait("boot", timeout: 30) { self.webView.load(URLRequest(url: self.origin!.appendingPathComponent("bridge.html"))) }
    }
    func start(language: String, terms: [String], channels: [AudioChannel], allowLargeModels: Bool = false, speakerEnabled: Bool = false, voiceProfiles: [VoiceProfile] = []) async throws {
        keepRunning("call", true)
        var prepared = false
        defer { if !prepared { keepRunning("call", false) } }
        pending.removeAll(); refinementAudio.removeAll()
        let count = Double(max(1, channels.count)), machine = ProcessInfo.processInfo
        let budget = max(1, Double(machine.physicalMemory) / 1073741824 - 2) / count
        let profiles = try JSONSerialization.jsonObject(with: JSONEncoder().encode(voiceProfiles))
        let config: [String: Any] = ["speakerEnabled": speakerEnabled, "voiceProfiles": profiles, "language": language, "terms": terms, "cacheOnly": false, "allowLargeModels": allowLargeModels, "channels": channels.map(\.rawValue), "deviceHints": ["memoryGB": budget, "cores": max(1, machine.activeProcessorCount / channels.count), "mobile": false, "saveData": false]]
        let json = String(data: try JSONSerialization.data(withJSONObject: config), encoding: .utf8)!
        try await wait("ready", timeout: 90) { self.run("void CallBridge.prepare(\(json))") }
        prepared = true
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.pending.values.contains(where: { Date().timeIntervalSince($0.1) > 40 }) else { return }
                self.watchdog?.invalidate(); self.onFailure?("SDK не подтвердил обработку звука за 40 секунд. Запись остановлена; готовый текст сохранён.")
            }
        }
    }
    func send(_ channel: AudioChannel, data: Data, rate: Double) {
        guard pending.values.filter({ $0.0 == channel }).count < 150 else { onFailure?("Распознавание отстаёт больше чем на 15 секунд. Запись остановлена; готовый текст сохранён."); return }
        refinementAudio[channel, default: RefinementPCMWindow()].append(data, rate: rate)
        nextPacket += 1; let id = nextPacket; pending[id] = (channel, Date())
        run("void CallBridge.audio('\(channel.rawValue)','\(data.base64EncodedString())',\(rate),\(id))")
    }
    func refinementSample(_ channel: AudioChannel, start: Double, end: Double) -> (Data, Double)? {
        guard let window = refinementAudio[channel], let data = window.slice(start: start, end: end) else { return nil }
        return (data, window.rate)
    }
    func drain() async throws {
        let deadline = Date().addingTimeInterval(25)
        while !pending.isEmpty {
            if Date() > deadline { throw NSError(domain: "CallScribe", code: 3, userInfo: [NSLocalizedDescriptionKey: "Истекло ожидание обработки аудио"]) }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }
    func stop() async {
        keepRunning("stop", true)
        defer { keepRunning("call", false); keepRunning("stop", false) }
        watchdog?.invalidate(); watchdog = nil
        finish("ready", error: CancellationError())
        do { try await wait("stopped", timeout: 30, cancellable: false) { self.run("void CallBridge.stop()") } }
        catch { onFailure?("Не удалось завершить SDK: \(error.localizedDescription)") }
        pending.removeAll(); refinementAudio.removeAll()
    }
    func enrollVoice(name: String, data: Data? = nil, rate: Double? = nil, segmentKey: String? = nil) async throws {
        let requestID = UUID().uuidString
        let key = "voice-enrolled:" + requestID
        keepRunning(key, true)
        defer { keepRunning(key, false) }
        var options: [String: Any] = ["id": requestID, "name": name]
        if let data, let rate { options["encoded"] = data.base64EncodedString(); options["rate"] = rate }
        if let segmentKey { options["segmentKey"] = segmentKey }
        let json = String(data: try JSONSerialization.data(withJSONObject: options), encoding: .utf8)!
        do {
            try await wait(key, timeout: 105) { self.run("void CallBridge.enroll(\(json))") }
        } catch {
            // Keep WebKit awake until the addressed cancellation has been dispatched.
            // Cleanup must run even when the enrolling Swift Task was cancelled.
            if shuttingDown { throw error }
            let cancelKey = "voice-cancel-dispatch:" + requestID
            try? await wait(cancelKey, timeout: 5, cancellable: false) {
                self.webView.evaluateJavaScript("void CallBridge.cancelEnrollment('\(requestID)')") { [weak self] _, dispatchError in
                    Task { @MainActor in self?.finish(cancelKey, error: dispatchError) }
                }
            }
            throw error
        }
    }
    func shutdown() { shuttingDown = true; for key in Array(waits.keys) { finish(key, error: CancellationError()) }; activeWork.removeAll(); webView.configuration.preferences.inactiveSchedulingPolicy = .suspend; watchdog?.invalidate(); server?.stop(); webView.configuration.userContentController.removeScriptMessageHandler(forName: "speech") }
    private func keepRunning(_ reason: String, _ active: Bool) {
        if active { activeWork.insert(reason) } else { activeWork.remove(reason) }
        // Capture is native, so WebKit cannot infer that the hidden SDK view is
        // doing user-requested audio work. Allow background execution only then.
        webView.configuration.preferences.inactiveSchedulingPolicy = activeWork.isEmpty ? .suspend : .none
    }
    private func run(_ script: String) {
        webView.evaluateJavaScript(script) { [weak self] _, error in
            if let error { Task { @MainActor in self?.failed(error.localizedDescription) } }
        }
    }
    private func wait(_ name: String, timeout: Double, cancellable: Bool = true, action: () -> Void) async throws {
        let ticket = UUID()
        try await withTaskCancellationHandler {
            if cancellable { try Task.checkCancellation() }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                finish(name, error: CancellationError()); waits[name] = continuation
                waitIDs[name] = ticket
                action()
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    guard self?.waitIDs[name] == ticket else { return }
                    self?.finish(name, error: NSError(domain: "CallScribe", code: 4, userInfo: [NSLocalizedDescriptionKey: "Таймаут SDK: \(name)"]))
                }
            }
        } onCancel: { [weak self] in
            guard cancellable else { return }
            Task { @MainActor in
                guard self?.waitIDs[name] == ticket else { return }
                self?.finish(name, error: CancellationError())
            }
        }
    }
    private func finish(_ name: String, error: Error? = nil) {
        guard let continuation = waits.removeValue(forKey: name) else { return }
        waitIDs.removeValue(forKey: name)
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }
    private func failed(_ message: String) {
        for key in Array(waits.keys) { finish(key, error: NSError(domain: "CallScribe", code: 5, userInfo: [NSLocalizedDescriptionKey: message])) }
        pending.removeAll(); onFailure?(message)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "127.0.0.1", message.frameInfo.securityOrigin.port == origin?.port,
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "boot": booted = true; finish("boot")
        case "ready", "stopped": finish(type)
        case "ack": if let id = body["packetId"] as? Int { pending.removeValue(forKey: id) }
        case "event": if let raw = body["channel"] as? String, let channel = AudioChannel(rawValue: raw), let event = body["event"] as? [String: Any] { onEvent?(channel, event) }
        case "speaker": onVoiceMessage?(body)
        case "speaker-status":
            if let requestID = body["requestId"] as? String, waits["voice-enrolled:" + requestID] == nil { return }
            onVoiceMessage?(body)
        case "voice-profile", "voice-error":
            guard let requestID = body["requestId"] as? String else { return }
            let key = "voice-enrolled:" + requestID
            guard waits[key] != nil else { return } // Ignore late or cancelled enrollment results.
            if type == "voice-profile" {
                guard let profile = body["profile"] as? [String: Any], profile["id"] as? String == requestID else { return }
                onVoiceMessage?(body); finish(key)
            } else {
                onVoiceMessage?(body)
                finish(key, error: NSError(domain: "CallScribe", code: 7, userInfo: [NSLocalizedDescriptionKey: body["message"] as? String ?? "Не удалось сохранить голос"]))
            }
        case "failure": failed(body["message"] as? String ?? "Ошибка SDK")
        default: break
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { booted = false; failed("WebView завершил процесс SDK. Перезапустите приложение.") }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.host == "127.0.0.1" && url?.port == origin?.port ? .allow : .cancel)
    }
}
