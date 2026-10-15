import AppKit
import Carbon

/// A registered shortcut, not a global keyboard monitor. Does not request TCC access.
@MainActor final class GlobalDictationHotKey {
    static let displayName = "⌘⇧D"
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let onToggle: () -> Void
    private static let signature: OSType = 0x4C534443 // LSDC
    init(onToggle: @escaping () -> Void) { self.onToggle = onToggle }

    func register() throws {
        guard hotKey == nil else { return }
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var identifier = EventHotKeyID()
            guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &identifier) == noErr,
                  identifier.signature == 0x4C534443, identifier.id == 1 else { return OSStatus(eventNotHandledErr) }
            let instance = Unmanaged<GlobalDictationHotKey>.fromOpaque(context).takeUnretainedValue()
            // Carbon application event handlers run on the main event loop.
            MainActor.assumeIsolated { instance.onToggle() }
            return noErr
        }, 1, &type, Unmanaged.passUnretained(self).toOpaque(), &handler)
        guard status == noErr else { unregister(); throw failure(status) }
        let registered = RegisterEventHotKey(UInt32(kVK_ANSI_D), UInt32(cmdKey | shiftKey), EventHotKeyID(signature: Self.signature, id: 1), GetApplicationEventTarget(), 0, &hotKey)
        guard registered == noErr else { unregister(); throw failure(registered) }
    }
    func unregister() {
        if let hotKey { UnregisterEventHotKey(hotKey) }; hotKey = nil
        if let handler { RemoveEventHandler(handler) }; handler = nil
    }
    deinit {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let handler { RemoveEventHandler(handler) }
    }
    private func failure(_ code: OSStatus) -> NSError {
        NSError(domain: "LocalSpeech.DictationHotKey", code: Int(code), userInfo: [NSLocalizedDescriptionKey: "Не удалось зарегистрировать \(Self.displayName). Возможно, сочетание занято; диктовка доступна из окна приложения."])
    }
}
