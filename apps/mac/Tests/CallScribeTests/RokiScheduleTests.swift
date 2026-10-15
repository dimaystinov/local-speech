import XCTest
@testable import CallScribe

final class RokiScheduleTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func event(_ id: String = "event", offset: Double = 300) -> RokiCalendarItem {
        .init(identifier: id, title: "Синтетическая встреча", start: now.addingTimeInterval(offset), end: now.addingTimeInterval(offset + 3600))
    }
    func storage() -> RokiScheduleStorage { .init(directory: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches").appendingPathComponent("roki-test-\(UUID())")) }
    func testCalendarFiveMinuteThresholdAndAllDayFilter() {
        var state = RokiScheduleState(); state.calendarEnabled = true
        XCTAssertNil(state.next(now: now, events: [event(offset: 301)]))
        XCTAssertNotNil(state.next(now: now, events: [event()]))
        var allDay = event(); allDay.allDay = true
        var cancelled = event(); cancelled.cancelled = true
        XCTAssertNil(state.next(now: now, events: [allDay, cancelled]))
        XCTAssertNil(state.next(now: now, events: [event(offset: -4000)]))
    }
    func testDifferentRecurringOccurrencesHaveIndependentKeys() {
        var state = RokiScheduleState(); state.calendarEnabled = true
        state.delivered[event().key] = now
        XCTAssertNil(state.next(now: now, events: [event()]))
        XCTAssertNotNil(state.next(now: now.addingTimeInterval(86400), events: [event(offset: 86700)]))
    }
    func testSnoozeOverridesDeliveredAndCancellationRemovesPending() {
        var state = RokiScheduleState(); state.calendarEnabled = true
        state.delivered[event().key] = now
        state.snoozed[event().key] = now.addingTimeInterval(600)
        XCTAssertNil(state.next(now: now.addingTimeInterval(599), events: [event()]))
        XCTAssertNotNil(state.next(now: now.addingTimeInterval(600), events: [event()]))
        state.reconcileCalendar([])
        XCTAssertTrue(state.snoozed.isEmpty)
        XCTAssertNil(state.next(now: now.addingTimeInterval(600), events: []))
    }
    func testCurrentBannerBlocksFollowingAndCancelledCurrentClears() {
        var state = RokiScheduleState(); state.calendarEnabled = true
        state.current = state.next(now: now, events: [event()])
        state.tasks = [.init(title: "Поручение", due: now)]
        XCTAssertNil(state.next(now: now, events: [event()]))
        state.reconcileCalendar([])
        XCTAssertEqual(state.next(now: now, events: [])?.source, .task)
    }
    func testRestartPreservesCurrentWithoutRepeatingAndPrivateFile() throws {
        let storage = storage(); defer { try? FileManager.default.removeItem(at: storage.directory) }
        var state = RokiScheduleState(); state.tasks = [.init(title: "Тестовое поручение", due: now)]
        let reminder = try XCTUnwrap(state.next(now: now, events: []))
        state.current = reminder; state.delivered[reminder.id] = now
        try storage.save(state)
        var loaded = try storage.load()
        XCTAssertEqual(loaded.current, reminder)
        loaded.current = nil
        XCTAssertNil(loaded.next(now: now, events: []))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: storage.directory.path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: storage.directory.appendingPathComponent("schedule.json").path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
    func testSymlinkAndCorruptFileRejected() throws {
        let storage = storage(); defer { try? FileManager.default.removeItem(at: storage.directory) }
        try FileManager.default.createDirectory(at: storage.directory, withIntermediateDirectories: true)
        let file = storage.directory.appendingPathComponent("schedule.json")
        try Data("broken".utf8).write(to: file)
        XCTAssertThrowsError(try storage.load())
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: storage.directory.appendingPathComponent("other"))
        XCTAssertThrowsError(try storage.save(.init()))
        XCTAssertThrowsError(try storage.load())
    }
    func testOldPendingTaskIsNotRedeliveredAfterHistoryPrune() {
        var state = RokiScheduleState(); state.tasks = [.init(title: "Старое поручение", due: now.addingTimeInterval(-40 * 86400))]
        state.delivered["task:\(state.tasks[0].id.uuidString)"] = state.tasks[0].due
        state.prune(now: now)
        XCTAssertNil(state.next(now: now, events: []))
    }
    @MainActor func testBusyDefersDeliveryAndSnoozeRequiresNewDeadline() async throws {
        let storage = storage(); defer { try? FileManager.default.removeItem(at: storage.directory) }
        var time = now
        let model = RokiSchedule(storage: storage, clock: { time })
        var delivered = 0, cleared = 0
        model.canDeliver = { false }
        model.onReminder = { _, _ in delivered += 1 }
        model.onClear = { cleared += 1 }
        model.addTask(title: "Синтетический тест", due: now)
        await model.tick()
        XCTAssertNil(model.currentReminder); XCTAssertEqual(delivered, 0)
        XCTAssertTrue(try storage.load().delivered.isEmpty)
        model.canDeliver = { true }; await model.tick()
        XCTAssertNotNil(model.currentReminder); XCTAssertEqual(delivered, 1)
        await model.tick(); XCTAssertEqual(delivered, 1)
        model.snoozeCurrent(); XCTAssertEqual(cleared, 1)
        time = now.addingTimeInterval(599); await model.tick(); XCTAssertNil(model.currentReminder)
        time = now.addingTimeInterval(600); await model.tick(); XCTAssertEqual(delivered, 2)
        model.completeCurrent(); await model.tick()
        XCTAssertEqual(model.tasks.first?.completed, true); XCTAssertNil(model.currentReminder); XCTAssertEqual(delivered, 2)
    }
    @MainActor func testStopPreventsQueuedPersonalTaskDelivery() async throws {
        let storage = storage(); defer { try? FileManager.default.removeItem(at: storage.directory) }
        let model = RokiSchedule(storage: storage, clock: { self.now })
        var delivered = 0
        model.onReminder = { _, _ in delivered += 1 }
        // addTask queues a tick on the main actor, then shutdown occurs before it runs.
        model.addTask(title: "Не говорить после остановки", due: now)
        model.stop()
        await Task.yield()
        await model.tick()
        XCTAssertEqual(delivered, 0)
        XCTAssertNil(model.currentReminder)
        XCTAssertTrue(try storage.load().delivered.isEmpty)
        model.start()
        await model.tick()
        XCTAssertEqual(delivered, 1)
        model.stop()
    }
    @MainActor func testInvalidInputAndCorruptionNeverOverwrite() throws {
        let storage = storage(); defer { try? FileManager.default.removeItem(at: storage.directory) }
        let model = RokiSchedule(storage: storage, clock: { self.now })
        for title in ["", "\n", String(repeating: "a", count: 241), "a\nb"] { model.addTask(title: title, due: now) }
        model.addTask(title: "Тест", due: now.addingTimeInterval(-120))
        XCTAssertTrue(model.tasks.isEmpty)
        try FileManager.default.createDirectory(at: storage.directory, withIntermediateDirectories: true)
        let file = storage.directory.appendingPathComponent("schedule.json")
        let original = Data("invalid".utf8); try original.write(to: file)
        let broken = RokiSchedule(storage: storage, clock: { self.now })
        broken.addTask(title: "Нельзя потерять старый файл", due: now)
        XCTAssertEqual(try Data(contentsOf: file), original)
        XCTAssertTrue(broken.tasks.isEmpty)
    }
}
