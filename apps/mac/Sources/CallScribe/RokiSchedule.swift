import Foundation
import Combine
import EventKit

struct RokiTask: Identifiable, Codable, Equatable {
    var id = UUID()
    var title: String
    var due: Date
    var completed = false
}

struct RokiCalendarItem: Equatable {
    var identifier: String
    var title: String
    var start: Date
    var end: Date
    var allDay = false
    var cancelled = false
    var key: String { "calendar:\(identifier):\(Int64(start.timeIntervalSince1970))" }
}

struct RokiReminder: Identifiable, Codable, Equatable {
    enum Source: String, Codable { case task, calendar }
    var id: String
    var title: String
    var due: Date
    var source: Source
    var taskID: UUID?
    var message: String { "Напоминаю: \(title). Время — \(due.formatted(date: .omitted, time: .shortened))." }
}

struct RokiScheduleState: Codable, Equatable {
    var version = 1
    var tasks: [RokiTask] = []
    var delivered: [String: Date] = [:]
    var snoozed: [String: Date] = [:]
    var current: RokiReminder?
    var calendarEnabled = false
    var voiceEnabled = false

    mutating func prune(now: Date) {
        let cutoff = now.addingTimeInterval(-30 * 86400)
        let activeTasks = Set(tasks.filter { !$0.completed }.map { "task:\($0.id.uuidString)" })
        delivered = delivered.filter { $0.value > cutoff || activeTasks.contains($0.key) }
        if delivered.count > 2048 {
            let active = delivered.filter { activeTasks.contains($0.key) }
            let recent = delivered.filter { !activeTasks.contains($0.key) }.sorted { $0.value > $1.value }.prefix(2048 - active.count)
            delivered = active.merging(Dictionary(uniqueKeysWithValues: recent.map { ($0.key, $0.value) })) { first, _ in first }
        }
        tasks.removeAll { $0.completed && $0.due < cutoff }
        let taskKeys = Set(tasks.map { "task:\($0.id.uuidString)" })
        snoozed = snoozed.filter { $0.value > cutoff && (taskKeys.contains($0.key) || $0.key.hasPrefix("calendar:")) }
    }

    mutating func reconcileCalendar(_ events: [RokiCalendarItem]) {
        let valid = Set(events.filter { !$0.cancelled && !$0.allDay }.map(\.key))
        snoozed = snoozed.filter { !$0.key.hasPrefix("calendar:") || valid.contains($0.key) }
        if let current, current.source == .calendar, !valid.contains(current.id) { self.current = nil }
    }

    func next(now: Date, events: [RokiCalendarItem]) -> RokiReminder? {
        guard current == nil else { return nil }
        var candidates = tasks.filter { !$0.completed }.map {
            RokiReminder(id: "task:\($0.id.uuidString)", title: $0.title, due: $0.due, source: .task, taskID: $0.id)
        }
        if calendarEnabled {
            candidates += events.filter { !$0.allDay && !$0.cancelled && $0.end > now }.map {
                RokiReminder(id: $0.key, title: $0.title, due: $0.start, source: .calendar)
            }
        }
        return candidates.filter { reminder in
            if let wake = snoozed[reminder.id] { return wake <= now }
            guard delivered[reminder.id] == nil else { return false }
            return reminder.due.addingTimeInterval(reminder.source == .calendar ? -300 : 0) <= now
        }.sorted { ($0.due, $0.id) < ($1.due, $1.id) }.first
    }
}

/// Stores only local task titles, reminder IDs/times, preferences and the current banner.
/// Calendar descriptions, notes, participants and locations are never queried or stored.
struct RokiScheduleStorage {
    let directory: URL
    private var url: URL { directory.appendingPathComponent("schedule.json") }
    static var standard: Self {
        .init(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LocalSpeech/RokiSchedule", isDirectory: true))
    }
    private func checkPath(_ path: URL) throws {
        var cursor = path.standardizedFileURL
        while cursor.path != "/" {
            if let attributes = try? FileManager.default.attributesOfItem(atPath: cursor.path), attributes[.type] as? FileAttributeType == .typeSymbolicLink {
                throw CocoaError(.fileWriteNoPermission)
            }
            cursor.deleteLastPathComponent()
        }
    }
    func load() throws -> RokiScheduleState {
        try checkPath(url)
        guard FileManager.default.fileExists(atPath: url.path) else { return .init() }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 1_048_576 else { throw CocoaError(.fileReadCorruptFile) }
        let state = try JSONDecoder().decode(RokiScheduleState.self, from: Data(contentsOf: url))
        guard state.version == 1, state.tasks.count <= 1000, state.delivered.count <= 2048, state.snoozed.count <= 3048,
              state.tasks.allSatisfy({ !$0.title.isEmpty && $0.title.count <= 240 && $0.due.timeIntervalSince1970.isFinite }) else { throw CocoaError(.fileReadCorruptFile) }
        return state
    }
    func save(_ state: RokiScheduleState) throws {
        try checkPath(url)
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let temporary = directory.appendingPathComponent(".schedule-\(UUID().uuidString)")
        let data = try JSONEncoder().encode(state)
        guard fm.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
        defer { try? fm.removeItem(at: temporary) }
        try checkPath(url)
        if rename(temporary.path, url.path) != 0 { throw CocoaError(.fileWriteUnknown) }
    }
}

private actor RokiCalendarSource {
    private let store = EKEventStore()
    func requestAccess() async throws -> Bool { try await store.requestFullAccessToEvents() }
    func events(now: Date) -> [RokiCalendarItem] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return [] }
        let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-86400), end: now.addingTimeInterval(86400), calendars: nil)
        return store.events(matching: predicate).compactMap { event in
            guard let identifier = event.eventIdentifier, let start = event.startDate, let end = event.endDate,
                  !event.isAllDay, event.status != .canceled, end > now else { return nil }
            return RokiCalendarItem(identifier: identifier, title: String((event.title ?? "Событие календаря").prefix(240)), start: start, end: end)
        }
    }
}

@MainActor final class RokiSchedule: ObservableObject {
    @Published private(set) var currentReminder: RokiReminder?
    @Published private(set) var tasks: [RokiTask] = []
    @Published private(set) var calendarEnabled = false
    @Published private(set) var calendarStatus = "Календарь не подключён"
    @Published private(set) var requestingAccess = false
    @Published var error: String?
    @Published var voiceEnabled = false { didSet { guard voiceEnabled != state.voiceEnabled else { return }; var next = state; next.voiceEnabled = voiceEnabled; commit(next) } }
    var canDeliver: () -> Bool = { true }
    var onReminder: (RokiReminder, Bool) -> Void = { _, _ in }
    var onClear: () -> Void = {}
    private var state: RokiScheduleState
    private let storage: RokiScheduleStorage
    private let clock: () -> Date
    private var source: RokiCalendarSource?
    private var loop: Task<Void, Never>?
    private var ticking = false
    private var stopped = false
    private var accessGeneration = UUID()
    private var storageHealthy = true

    init(storage: RokiScheduleStorage = .standard, clock: @escaping () -> Date = Date.init) {
        self.storage = storage; self.clock = clock
        do { state = try storage.load() } catch { state = .init(); storageHealthy = false; self.error = "Не удалось прочитать график. Исходный файл сохранён; напоминания приостановлены." }
        currentReminder = state.current; tasks = state.tasks; calendarEnabled = state.calendarEnabled; voiceEnabled = state.voiceEnabled
    }
    func start() {
        guard loop == nil else { return }
        stopped = false
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
            }
        }
    }
    func stop() { stopped = true; loop?.cancel(); loop = nil; accessGeneration = UUID(); requestingAccess = false }
    func requestCalendarAccess() {
        guard !requestingAccess else { return }
        requestingAccess = true; let generation = accessGeneration
        let source = source ?? RokiCalendarSource(); self.source = source
        Task { [weak self] in
            do {
                let granted = try await source.requestAccess()
                guard let self, self.accessGeneration == generation else { return }
                self.requestingAccess = false
                if granted { var next = self.state; next.calendarEnabled = true; self.commit(next); await self.tick() }
                else { self.calendarStatus = "Доступ не разрешён. Личные поручения доступны. Разрешение можно изменить в настройках macOS." }
            } catch {
                guard let self, self.accessGeneration == generation else { return }
                self.requestingAccess = false; self.calendarStatus = "Не удалось получить доступ к календарю. Личные поручения доступны."
            }
        }
    }
    func disableCalendar() {
        accessGeneration = UUID(); requestingAccess = false
        var next = state; next.calendarEnabled = false
        if next.current?.source == .calendar { next.current = nil }
        next.snoozed = next.snoozed.filter { !$0.key.hasPrefix("calendar:") }
        if commit(next) { calendarStatus = "Календарь отключён" }
    }
    func addTask(title: String, due: Date) {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= 240, !clean.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              due.timeIntervalSince1970.isFinite, due >= clock().addingTimeInterval(-60), due <= clock().addingTimeInterval(5 * 366 * 86400),
              state.tasks.filter({ !$0.completed }).count < 500, state.tasks.count < 1000 else {
            error = "Введите поручение до 240 символов и время от текущего момента до пяти лет вперёд (не более 500 активных поручений)."; return
        }
        var next = state; next.tasks.append(.init(title: clean, due: due)); commit(next)
        Task { await tick() }
    }
    func completeTask(_ id: UUID) {
        var next = state
        guard let index = next.tasks.firstIndex(where: { $0.id == id }) else { return }
        next.tasks[index].completed = true
        next.snoozed.removeValue(forKey: "task:\(id.uuidString)")
        if next.current?.taskID == id { next.current = nil }
        commit(next)
    }
    func completeCurrent() {
        guard let reminder = currentReminder else { return }
        if let id = reminder.taskID { completeTask(id) } else { dismissCurrent() }
    }
    func dismissCurrent() { var next = state; next.current = nil; commit(next) }
    func snoozeCurrent() {
        guard let reminder = currentReminder else { return }
        var next = state; next.snoozed[reminder.id] = clock().addingTimeInterval(600); next.current = nil; commit(next)
    }
    func tick() async {
        guard !stopped, !Task.isCancelled, !ticking, storageHealthy else { return }
        ticking = true; defer { ticking = false }
        let now = clock(), generation = accessGeneration
        var events: [RokiCalendarItem] = []
        if calendarEnabled {
            if EKEventStore.authorizationStatus(for: .event) == .fullAccess {
                let source = source ?? RokiCalendarSource(); self.source = source
                events = await source.events(now: now)
                guard !stopped, generation == accessGeneration, !Task.isCancelled else { return }
                calendarStatus = "Подключён · за 5 минут · без событий на весь день"
            } else { calendarStatus = "Доступ к календарю отозван или ограничен. Личные поручения доступны." }
        }
        var next = state; next.prune(now: now); next.reconcileCalendar(events)
        if next != state, !commit(next) { return }
        guard canDeliver(), let reminder = state.next(now: now, events: events) else { return }
        next = state; next.current = reminder; next.delivered[reminder.id] = now; next.snoozed.removeValue(forKey: reminder.id); next.prune(now: now)
        guard commit(next) else { return }
        onReminder(reminder, voiceEnabled)
    }
    @discardableResult private func commit(_ next: RokiScheduleState) -> Bool {
        guard storageHealthy else { return false }
        do {
            try storage.save(next)
            let cleared = state.current != nil && next.current?.id != state.current?.id
            state = next; tasks = next.tasks; calendarEnabled = next.calendarEnabled; currentReminder = next.current; error = nil
            if cleared { onClear() }
            return true
        } catch { self.error = "Не удалось сохранить график. Напоминание не отмечено как доставленное."; return false }
    }
}
