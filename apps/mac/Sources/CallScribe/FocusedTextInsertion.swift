import AppKit
import ApplicationServices

enum DictationInsertionError: LocalizedError {
    case permission, noTarget, unsupported, secure, changed, invalidRange, tooLarge, empty, uncertainWrite, nothingToUndo
    case unsupportedDetail(String)
    case submitUnavailable, submitAmbiguous, submitUncertain
    var errorDescription: String? {
        switch self {
        case .permission: return "Для ввода в другое приложение нужен доступ «Универсальный доступ». Текст остаётся в черновике."
        case .noTarget: return "Выберите текстовое поле в другом приложении и включите диктовку."
        case .unsupported: return "Это поле пока не поддерживает проверяемую вставку. Текст доступен в черновике."
        case .unsupportedDetail(let detail): return "Поле не поддерживает проверяемую вставку: \(detail). Текст доступен в черновике."
        case .secure: return "Диктовка в защищённое поле отключена."
        case .changed: return "Поле, курсор или текст изменились. Вставка приостановлена; черновик сохранён."
        case .invalidRange: return "Приложение сообщило неподдерживаемое выделение текста."
        case .tooLarge: return "Поле слишком большое для проверяемой вставки. Используйте черновик."
        case .empty: return "Нет текста для вставки."
        case .uncertainWrite: return "Не удалось подтвердить результат вставки. Проверьте поле; автоматический повтор отключён."
        case .nothingToUndo: return "Нет последней проверенной вставки для отмены."
        case .submitUnavailable: return "Рядом с полем не найдена однозначная доступная кнопка отправки. Сообщение не отправлено."
        case .submitAmbiguous: return "Рядом с полем несколько кнопок отправки. Выберите нужную вручную."
        case .submitUncertain: return "Команда отправки была передана, но результат не подтверждён. Проверьте приложение; повтор отключён."
        }
    }
}

struct DictationTargetContext: Sendable {
    let applicationName: String
    let selectedText: String
    let precedingText: String
    let followingText: String
}

struct DictationInsertionReceipt: Sendable {
    let insertedText: String
    let selectionAfter: NSRange
}

/// Pure edit transaction. AX offsets are UTF-16; never split a grapheme.
struct DictationTextSnapshot: Equatable, Sendable {
    static let maximumLength = 100_000
    let text: String
    let selection: NSRange
    init(text: String, selection: NSRange) throws {
        guard text.utf16.count <= Self.maximumLength else { throw DictationInsertionError.tooLarge }
        guard selection.location >= 0, selection.length >= 0,
              selection.location <= text.utf16.count,
              selection.length <= text.utf16.count - selection.location,
              let range = Range(selection, in: text),
              (range.lowerBound == text.endIndex || text.indices.contains(range.lowerBound)),
              (range.upperBound == text.endIndex || text.indices.contains(range.upperBound)) else { throw DictationInsertionError.invalidRange }
        self.text = text; self.selection = selection
    }
    func inserting(_ replacement: String) throws -> DictationTextSnapshot {
        guard !replacement.isEmpty else { throw DictationInsertionError.empty }
        guard replacement.utf16.count <= Self.maximumLength - text.utf16.count + selection.length else { throw DictationInsertionError.tooLarge }
        let range = Range(selection, in: text)!
        let result = text.replacingCharacters(in: range, with: replacement)
        return try DictationTextSnapshot(text: result, selection: NSRange(location: selection.location + replacement.utf16.count, length: 0))
    }
    func context(applicationName: String) -> DictationTargetContext {
        let range = Range(selection, in: text)!
        return DictationTargetContext(applicationName: applicationName,
            selectedText: String(text[range].prefix(240)), precedingText: String(text[..<range.lowerBound].suffix(240)),
            followingText: String(text[range.upperBound...].prefix(240)))
    }
}

/// Capability metadata contains no field value, selection text, title or document name.
struct DictationFieldCapabilities {
    let role: String?
    let subrole: String?
    let enabled: Bool?
    let selectionWritable: Bool
    let selectedTextWritable: Bool
    let valueWritable: Bool

    var diagnostic: String {
        // Only well-known roles are reported; an application's arbitrary attribute
        // string could contain user content and must not reach diagnostics.
        let roles = ["AXTextField", "AXTextArea", "AXComboBox", "AXGroup", "AXWebArea"]
        let roleLabel = role.map { roles.contains($0) ? $0 : "other" } ?? "missing"
        let subroleLabel = subrole == nil ? "missing" : (subrole == "AXSecureTextField" ? "secure" : "present")
        let enabledLabel = enabled.map { $0 ? "yes" : "no" } ?? "missing"
        return "role=\(roleLabel), subrole=\(subroleLabel), enabled=\(enabledLabel), rangeWrite=\(selectionWritable), selectedWrite=\(selectedTextWritable), valueWrite=\(valueWritable)"
    }

    func validateEditableText() throws {
        guard subrole != "AXSecureTextField" else { throw DictationInsertionError.secure }
        guard role == "AXTextField" || role == "AXTextArea" else {
            throw DictationInsertionError.unsupportedDetail("text-role; " + diagnostic)
        }
        // Subrole adds optional information; ordinary text areas commonly omit it.
        // Missing AXEnabled is distinct from an explicitly disabled control.
        guard enabled != false else { throw DictationInsertionError.unsupportedDetail("disabled; " + diagnostic) }
        guard selectionWritable else { throw DictationInsertionError.unsupportedDetail("selection-not-writable; " + diagnostic) }
    }
}

/// Pure exact-label policy. Labels are never treated as instructions or logged.
struct DictationSubmitPolicy {
    struct Candidate {
        let role: String?
        let enabled: Bool?
        let labels: [String]
        let actions: [String]
    }
    private static let labels: Set<String> = ["send", "send message", "отправить", "отправить сообщение"]
    static func matches(_ candidate: Candidate) -> Bool {
        guard candidate.role == "AXButton", candidate.enabled == true,
              candidate.actions.contains("AXPress") else { return false }
        let names = candidate.labels.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { $0.contains(where: \.isLetter) }
        // An icon may accompany a label; conflicting textual descriptions reject.
        return !names.isEmpty && names.allSatisfy { labels.contains($0) }
    }
    static func uniqueIndex(in candidates: [Candidate]) throws -> Int? {
        let matchingIndices = candidates.indices.filter { Self.matches(candidates[$0]) }
        guard matchingIndices.count <= 1 else { throw DictationInsertionError.submitAmbiguous }
        return matchingIndices.first
    }
    static func skipsSubtree(role: String?) -> Bool {
        ["AXMenu", "AXMenuBar", "AXMenuItem", "AXTextField", "AXTextArea", "AXApplication"].contains(role ?? "")
    }
}

/// Runs AX requests off the main actor. No clipboard, synthetic key events, or permission mutation.
actor FocusedTextInsertion {
    nonisolated static var isTrusted: Bool { AXIsProcessTrusted() }
    private enum WriteStrategy { case selectedText, nativePlainValue }
    private struct Target {
        let element: AXUIElement
        let pid: pid_t
        let applicationName: String
        let strategy: WriteStrategy
        var expected: DictationTextSnapshot
    }
    private var target: Target?
    private var undo: (before: DictationTextSnapshot, after: DictationTextSnapshot)?

    func clear() { target = nil; undo = nil }

    func captureTarget() throws -> DictationTargetContext {
        clear()
        guard Self.isTrusted else { throw DictationInsertionError.permission }
        let element = try focusedElement()
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid != ProcessInfo.processInfo.processIdentifier,
              let app = NSRunningApplication(processIdentifier: pid) else { throw DictationInsertionError.noTarget }
        let forbidden = ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable"]
        guard !forbidden.contains(app.bundleIdentifier ?? "") else { throw DictationInsertionError.unsupported }
        let strategy = try validateKind(element)
        let snapshot = try readSnapshot(element)
        let name = app.localizedName ?? "Приложение"
        target = Target(element: element, pid: pid, applicationName: name, strategy: strategy, expected: snapshot)
        return snapshot.context(applicationName: name)
    }

    func insertFinal(_ text: String) throws -> DictationInsertionReceipt {
        guard var current = target else { throw DictationInsertionError.noTarget }
        let next = try current.expected.inserting(text)
        do {
            try validate(current)
            try write(next, before: current.expected, replacing: current.expected.selection, with: text, target: current)
            undo = (current.expected, next)
            current.expected = next; target = current
            return DictationInsertionReceipt(insertedText: text, selectionAfter: next.selection)
        } catch {
            // A failed mutation may already have applied. Never retry implicitly.
            clear(); throw error
        }
    }

    func undoLast() throws {
        guard var current = target, let patch = undo else { throw DictationInsertionError.nothingToUndo }
        do {
            guard current.expected == patch.after else { throw DictationInsertionError.changed }
            try validate(current)
            let replacement = String(patch.before.text[Range(patch.before.selection, in: patch.before.text)!])
            let insertedLength = patch.after.text.utf16.count - patch.before.text.utf16.count + patch.before.selection.length
            let range = NSRange(location: patch.before.selection.location, length: insertedLength)
            try write(patch.before, before: patch.after, replacing: range, with: replacement, target: current)
            current.expected = patch.before; target = current; undo = nil
        } catch { clear(); throw error }
    }

    /// Explicit user action only. Successful return confirms AXPress dispatch,
    /// not delivery to a recipient. Never synthesizes Enter or another key.
    func submit() throws {
        guard let current = target else { throw DictationInsertionError.noTarget }
        let deadline = ProcessInfo.processInfo.systemUptime + 1.5
        try validateSubmitTarget(current, deadline: deadline)
        let button = try findSubmitButton(near: current, deadline: deadline)
        try validateSubmitTarget(current, deadline: deadline)
        guard try sameProcess(button, pid: current.pid, deadline: deadline),
              DictationSubmitPolicy.matches(try submitCandidate(button, deadline: deadline)) else {
            throw DictationInsertionError.changed
        }
        try checkSubmitDeadline(deadline)
        // Clear before dispatch: even a non-success AX status can leave an
        // uncertain remote side effect, so a second click cannot retry it.
        clear()
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
            throw DictationInsertionError.submitUncertain
        }
    }

    private func checkSubmitDeadline(_ deadline: TimeInterval) throws {
        try Task.checkCancellation()
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw DictationInsertionError.submitUnavailable }
    }

    private func submitAttribute(_ element: AXUIElement, _ name: String, deadline: TimeInterval) throws -> CFTypeRef? {
        try checkSubmitDeadline(deadline)
        AXUIElementSetMessagingTimeout(element, Float(min(0.05, deadline - ProcessInfo.processInfo.systemUptime)))
        let value = attribute(element, name)
        try checkSubmitDeadline(deadline)
        return value
    }

    private func sameProcess(_ element: AXUIElement, pid: pid_t, deadline: TimeInterval) throws -> Bool {
        try checkSubmitDeadline(deadline)
        AXUIElementSetMessagingTimeout(element, 0.05)
        var actual: pid_t = 0
        return AXUIElementGetPid(element, &actual) == .success && actual == pid
    }

    private func validateSubmitTarget(_ current: Target, deadline: TimeInterval) throws {
        guard Self.isTrusted else { throw DictationInsertionError.permission }
        let system = AXUIElementCreateSystemWide()
        guard let raw = try submitAttribute(system, kAXFocusedUIElementAttribute, deadline: deadline),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { throw DictationInsertionError.changed }
        let focused = unsafeBitCast(raw, to: AXUIElement.self)
        guard CFEqual(focused, current.element), try sameProcess(focused, pid: current.pid, deadline: deadline) else {
            throw DictationInsertionError.changed
        }
        let role = try submitAttribute(focused, kAXRoleAttribute, deadline: deadline) as? String
        let subrole = try submitAttribute(focused, kAXSubroleAttribute, deadline: deadline) as? String
        guard subrole != "AXSecureTextField" else { throw DictationInsertionError.secure }
        guard role == "AXTextField" || role == "AXTextArea",
              try submitAttribute(focused, kAXEnabledAttribute, deadline: deadline) as? Bool != false,
              let text = try submitAttribute(focused, kAXValueAttribute, deadline: deadline) as? String,
              let selected = try submitAttribute(focused, kAXSelectedTextRangeAttribute, deadline: deadline),
              CFGetTypeID(selected) == AXValueGetTypeID() else { throw DictationInsertionError.changed }
        let value = unsafeBitCast(selected, to: AXValue.self)
        var range = CFRange()
        guard AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range),
              try DictationTextSnapshot(text: text, selection: NSRange(location: range.location, length: range.length)) == current.expected else {
            throw DictationInsertionError.changed
        }
    }

    private func submitCandidate(_ element: AXUIElement, deadline: TimeInterval) throws -> DictationSubmitPolicy.Candidate {
        let role = try submitAttribute(element, kAXRoleAttribute, deadline: deadline) as? String
        let enabled = try submitAttribute(element, kAXEnabledAttribute, deadline: deadline) as? Bool
        let title = try submitAttribute(element, kAXTitleAttribute, deadline: deadline) as? String
        let description = try submitAttribute(element, kAXDescriptionAttribute, deadline: deadline) as? String
        try checkSubmitDeadline(deadline)
        var actions: CFArray?
        let actionStatus = AXUIElementCopyActionNames(element, &actions)
        try checkSubmitDeadline(deadline)
        return DictationSubmitPolicy.Candidate(role: role, enabled: enabled, labels: [title, description].compactMap { $0 },
                                              actions: actionStatus == .success ? (actions as? [String] ?? []) : [])
    }

    private func findSubmitButton(near current: Target, deadline: TimeInterval) throws -> AXUIElement {
        var ancestor = current.element
        var visited: [AXUIElement] = []
        for _ in 0..<6 {
            guard let raw = try submitAttribute(ancestor, kAXParentAttribute, deadline: deadline),
                  CFGetTypeID(raw) == AXUIElementGetTypeID() else { break }
            let parent = unsafeBitCast(raw, to: AXUIElement.self)
            guard !CFEqual(parent, ancestor), try sameProcess(parent, pid: current.pid, deadline: deadline) else { break }
            ancestor = parent
            let ancestorRole = try submitAttribute(ancestor, kAXRoleAttribute, deadline: deadline) as? String
            if ancestorRole == "AXApplication" { break }
            var queue = [ancestor]
            var candidates: [(AXUIElement, DictationSubmitPolicy.Candidate)] = []
            while !queue.isEmpty {
                try checkSubmitDeadline(deadline)
                let element = queue.removeFirst()
                if visited.contains(where: { CFEqual($0, element) }) { continue }
                guard visited.count < 200 else { throw DictationInsertionError.submitUnavailable }
                visited.append(element)
                guard try sameProcess(element, pid: current.pid, deadline: deadline) else { continue }
                let role = try submitAttribute(element, kAXRoleAttribute, deadline: deadline) as? String
                if DictationSubmitPolicy.skipsSubtree(role: role) { continue }
                // Never traverse into another window, sheet or application tree.
                if (role == "AXWindow" || role == "AXSheet") && !CFEqual(element, ancestor) { continue }
                if role == "AXButton" {
                    let candidate = try submitCandidate(element, deadline: deadline)
                    if DictationSubmitPolicy.matches(candidate) { candidates.append((element, candidate)) }
                    continue
                }
                try checkSubmitDeadline(deadline)
                var count: CFIndex = 0
                let countStatus = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
                if countStatus == .attributeUnsupported || countStatus == .noValue { continue }
                guard countStatus == .success, count >= 0, count <= 200 - visited.count - queue.count else {
                    throw DictationInsertionError.submitUnavailable
                }
                if count == 0 { continue }
                try checkSubmitDeadline(deadline)
                var children: CFArray?
                guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, count, &children) == .success,
                      let elements = children as? [AXUIElement] else { throw DictationInsertionError.submitUnavailable }
                try checkSubmitDeadline(deadline)
                queue.append(contentsOf: elements)
            }
            if let index = try DictationSubmitPolicy.uniqueIndex(in: candidates.map { $0.1 }) { return candidates[index].0 }
            if ancestorRole == "AXWindow" || ancestorRole == "AXSheet" { break }
        }
        throw DictationInsertionError.submitUnavailable
    }

    private func validate(_ target: Target) throws {
        guard Self.isTrusted else { throw DictationInsertionError.permission }
        let focused = try focusedElement()
        var pid: pid_t = 0
        guard AXUIElementGetPid(focused, &pid) == .success, pid == target.pid, CFEqual(focused, target.element) else { throw DictationInsertionError.changed }
        guard try validateKind(focused) == target.strategy else { throw DictationInsertionError.changed }
        guard try readSnapshot(focused) == target.expected else { throw DictationInsertionError.changed }
    }

    private func focusedElement() throws -> AXUIElement {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.2)
        guard let value = attribute(system, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { throw DictationInsertionError.noTarget }
        let element = unsafeBitCast(value, to: AXUIElement.self)
        AXUIElementSetMessagingTimeout(element, 0.2)
        return element
    }

    private func validateKind(_ element: AXUIElement) throws -> WriteStrategy {
        // A text area's role cannot tell plain text from rich text. Keep it preview-only
        // until a dedicated application adapter proves formatting preservation.
        let capabilities = capabilities(element)
        try capabilities.validateEditableText()
        let role = capabilities.role
        // Some editors explicitly provide a writable selected-text extension even
        // though Apple's general attribute contract is read-only. It preserves
        // the surrounding attributed document; verify the result after every write.
        if capabilities.selectedTextWritable { return .selectedText }
        guard role == (kAXTextFieldRole as String) else { throw DictationInsertionError.unsupportedDetail("selected-text-not-writable; " + capabilities.diagnostic) }
        var ancestor = element
        for _ in 0..<24 {
            AXUIElementSetMessagingTimeout(ancestor, 0.2)
            guard let role = attribute(ancestor, kAXRoleAttribute) as? String else { throw DictationInsertionError.unsupported }
            if role == "AXWebArea" { throw DictationInsertionError.unsupportedDetail("web-value-replacement-blocked; " + capabilities.diagnostic) }
            if role == (kAXApplicationRole as String) { break }
            guard let parent = attribute(ancestor, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { throw DictationInsertionError.unsupported }
            ancestor = unsafeBitCast(parent, to: AXUIElement.self)
            if CFEqual(ancestor, element) { throw DictationInsertionError.unsupported }
        }
        guard attribute(ancestor, kAXRoleAttribute) as? String == (kAXApplicationRole as String) else { throw DictationInsertionError.unsupported }
        guard capabilities.valueWritable else { throw DictationInsertionError.unsupportedDetail("value-not-writable; " + capabilities.diagnostic) }
        return .nativePlainValue
    }

    private func readSnapshot(_ element: AXUIElement) throws -> DictationTextSnapshot {
        guard let text = attribute(element, kAXValueAttribute) as? String else {
            throw DictationInsertionError.unsupportedDetail("text-readback-unavailable; " + capabilities(element).diagnostic)
        }
        guard let raw = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else {
            throw DictationInsertionError.unsupportedDetail("selection-readback-unavailable; " + capabilities(element).diagnostic)
        }
        let value = unsafeBitCast(raw, to: AXValue.self)
        var range = CFRange()
        guard AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range) else { throw DictationInsertionError.invalidRange }
        return try DictationTextSnapshot(text: text, selection: NSRange(location: range.location, length: range.length))
    }

    private func write(_ snapshot: DictationTextSnapshot, before: DictationTextSnapshot,
                       replacing range: NSRange, with replacement: String, target: Target) throws {
        let element = target.element
        switch target.strategy {
        case .nativePlainValue:
            guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, snapshot.text as CFString) == .success else { throw DictationInsertionError.uncertainWrite }
        case .selectedText:
            if range != before.selection {
                try setSelection(range, element: element)
                guard let focused = try? focusedElement(), CFEqual(focused, element),
                      let readback = try? readSnapshot(element), readback.text == before.text, readback.selection == range else { throw DictationInsertionError.uncertainWrite }
            }
            guard AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, replacement as CFString) == .success else { throw DictationInsertionError.uncertainWrite }
        }
        // AX mutation is not atomic with user input. Stop on any ambiguity; no recovery
        // writes or retry can safely guess what happened in a different application.
        guard let current = attribute(element, kAXValueAttribute) as? String, current == snapshot.text,
              let focused = try? focusedElement(), CFEqual(focused, element) else { throw DictationInsertionError.uncertainWrite }
        try setSelection(snapshot.selection, element: element)
        guard (try? readSnapshot(element)) == snapshot else { throw DictationInsertionError.uncertainWrite }
    }

    private func setSelection(_ selection: NSRange, element: AXUIElement) throws {
        var range = CFRange(location: selection.location, length: selection.length)
        guard let value = AXValueCreate(.cfRange, &range),
              AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success else { throw DictationInsertionError.uncertainWrite }
    }

    private func capabilities(_ element: AXUIElement) -> DictationFieldCapabilities {
        DictationFieldCapabilities(role: attribute(element, kAXRoleAttribute) as? String,
                                  subrole: attribute(element, kAXSubroleAttribute) as? String,
                                  enabled: attribute(element, kAXEnabledAttribute) as? Bool,
                                  selectionWritable: settable(element, kAXSelectedTextRangeAttribute),
                                  selectedTextWritable: settable(element, kAXSelectedTextAttribute),
                                  valueWritable: settable(element, kAXValueAttribute))
    }

    private func settable(_ element: AXUIElement, _ name: String) -> Bool {
        var value = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, name as CFString, &value) == .success && value.boolValue
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
}
