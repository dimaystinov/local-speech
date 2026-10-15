import XCTest
import AVFoundation
@testable import CallScribe

final class DictationTests: XCTestCase {
    func testPermissionTaskCancellationFinishesWithoutOSAnswer() async {
        let started = expectation(description: "permission requested")
        let finished = expectation(description: "cancelled without OS answer")
        let callback = PermissionCallback()
        let request = DictationMicrophonePermissionRequest()
        let task = Task {
            defer { finished.fulfill() }
            do {
                _ = try await request.value { callback.set($0); started.fulfill() }
                XCTFail("Cancelled permission wait must not grant capture")
            } catch { XCTAssertTrue(error is CancellationError) }
        }
        await fulfillment(of: [started], timeout: 1)
        task.cancel()
        await fulfillment(of: [finished], timeout: 1)
        // A grant delivered after cancellation must not resume the continuation twice.
        callback.answer(true)
        callback.answer(false)
        await task.value
    }

    func testPermissionStopCancellationFinishesWithoutCancellingCallerTask() async {
        let started = expectation(description: "permission requested")
        let finished = expectation(description: "stopped wait")
        let callback = PermissionCallback()
        let request = DictationMicrophonePermissionRequest()
        let task = Task {
            defer { finished.fulfill() }
            do {
                _ = try await request.value { callback.set($0); started.fulfill() }
                XCTFail("Stopped request must not grant capture")
            } catch { XCTAssertTrue(error is CancellationError) }
        }
        await fulfillment(of: [started], timeout: 1)
        request.cancel()
        await fulfillment(of: [finished], timeout: 1)
        callback.answer(true)
        await task.value
    }

    func testAlreadyCancelledPermissionWaitDoesNotInvokeRequest() async {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                _ = try await DictationMicrophonePermissionRequest().value { _ in XCTFail("Already cancelled wait must not request permission") }
                XCTFail("Expected cancellation")
            } catch { XCTAssertTrue(error is CancellationError) }
        }
        await task.value
    }

    func testPermissionGrantAndDenialAreDeliveredWithoutCancellation() async throws {
        let granted = try await DictationMicrophonePermissionRequest().value { $0(true) }
        let denied = try await DictationMicrophonePermissionRequest().value { $0(false) }
        XCTAssertTrue(granted)
        XCTAssertFalse(denied)
    }

    func testPermissionGrantCancellationRaceCompletesExactlyOnce() async {
        for _ in 0..<50 {
            let started = expectation(description: "race requested")
            let finished = expectation(description: "race finished")
            let request = DictationMicrophonePermissionRequest()
            let callback = PermissionCallback()
            let task = Task {
                defer { finished.fulfill() }
                do { _ = try await request.value { callback.set($0); started.fulfill() } }
                catch { XCTAssertTrue(error is CancellationError) }
            }
            await fulfillment(of: [started], timeout: 1)
            await withTaskGroup(of: Void.self) { group in
                group.addTask { callback.answer(true) }
                group.addTask { task.cancel() }
            }
            await fulfillment(of: [finished], timeout: 1)
            callback.answer(true)
            await task.value
        }
    }

    func testInsertionReplacesOnlySelectedUTF16SpanAndSetsCaret() throws {
        let original = "До 👩🏽‍💻 English после"
        let selection = (original as NSString).range(of: "English")
        let before = try DictationTextSnapshot(text: original, selection: selection)
        let after = try before.inserting("технический SDK")
        XCTAssertEqual(after.text, "До 👩🏽‍💻 технический SDK после")
        XCTAssertEqual(after.selection, NSRange(location: selection.location + "технический SDK".utf16.count, length: 0))
        XCTAssertNotEqual(before, after)
    }

    func testCaretInsertionPreservesNewlinesAndDoesNotAddSubmitKeystroke() throws {
        let before = try DictationTextSnapshot(text: "первая\nпоследняя", selection: NSRange(location: 7, length: 0))
        let after = try before.inserting("Hello, SDK!\n")
        XCTAssertEqual(after.text, "первая\nHello, SDK!\nпоследняя")
    }

    func testSnapshotDetectsExternalTextAndSelectionChanges() throws {
        let one = try DictationTextSnapshot(text: "abcdef", selection: NSRange(location: 3, length: 0))
        XCTAssertNotEqual(one, try DictationTextSnapshot(text: "abcXdef", selection: one.selection))
        XCTAssertNotEqual(one, try DictationTextSnapshot(text: one.text, selection: NSRange(location: 4, length: 0)))
    }

    func testMalformedRangesAndSplitGraphemesAreRejected() {
        for range in [NSRange(location: -1, length: 0), NSRange(location: 0, length: -1), NSRange(location: 100, length: 0), NSRange(location: 0, length: Int.max)] {
            XCTAssertThrowsError(try DictationTextSnapshot(text: "abc", selection: range))
        }
        for value in ["😀", "e\u{301}", "👩🏽‍💻"] {
            XCTAssertThrowsError(try DictationTextSnapshot(text: value, selection: NSRange(location: 1, length: 0)))
        }
    }

    func testContextIsBoundedAndPreservesSelection() throws {
        let value = String(repeating: "я", count: 500) + "Swift SDK" + String(repeating: "x", count: 500)
        let snapshot = try DictationTextSnapshot(text: value, selection: NSRange(location: 500, length: 9))
        let context = snapshot.context(applicationName: "Example")
        XCTAssertEqual(context.applicationName, "Example")
        XCTAssertEqual(context.selectedText, "Swift SDK")
        XCTAssertEqual(context.precedingText.count, 240)
        XCTAssertEqual(context.followingText.count, 240)
    }

    func testLargeFieldAndLargeReplacementAreRejected() throws {
        XCTAssertThrowsError(try DictationTextSnapshot(text: String(repeating: "a", count: 100_001), selection: NSRange(location: 0, length: 0)))
        let value = try DictationTextSnapshot(text: String(repeating: "a", count: 100_000), selection: NSRange(location: 0, length: 0))
        XCTAssertThrowsError(try value.inserting("b"))
        let replacingAll = try DictationTextSnapshot(text: value.text, selection: NSRange(location: 0, length: 100_000))
        XCTAssertEqual(try replacingAll.inserting("short").text, "short")
        XCTAssertThrowsError(try value.inserting(""))
    }

    func testTapCopyOwnsPlanarStereoSamples() throws {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        let source = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 128)!
        source.frameLength = 128
        for index in 0..<128 { source.floatChannelData![0][index] = 0.25; source.floatChannelData![1][index] = -0.75 }
        let copy = try XCTUnwrap(DictationMicrophoneDelivery.copy(source))
        source.floatChannelData![0][0] = 0
        XCTAssertEqual(copy.frameLength, 128)
        XCTAssertEqual(copy.floatChannelData![0][0], 0.25)
        XCTAssertEqual(copy.floatChannelData![1][127], -0.75)
    }

    func testTapCopyOwnsInterleavedSamples() throws {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 2, interleaved: true)!
        let source = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16)!
        source.frameLength = 16
        for index in 0..<32 { source.floatChannelData![0][index] = Float(index) / 100 }
        let copy = try XCTUnwrap(DictationMicrophoneDelivery.copy(source))
        source.floatChannelData![0][31] = 0
        XCTAssertEqual(copy.floatChannelData![0][31], 0.31, accuracy: 0.00001)
    }

    func testTapRejectsEmptyAndUnsupportedPCM() {
        let float = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!, frameCapacity: 16)!
        XCTAssertNil(DictationMicrophoneDelivery.copy(float))
        let integer = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: false)!, frameCapacity: 16)!
        integer.frameLength = 16
        XCTAssertNil(DictationMicrophoneDelivery.copy(integer))
    }

    func testStopDrainsAcceptedTailAndRejectsLaterBuffers() async {
        let entered = expectation(description: "first callback")
        let block = DispatchSemaphore(value: 0)
        var count = 0
        let delivery = DictationMicrophoneDelivery(onAudio: { _ in
            count += 1
            if count == 1 { entered.fulfill(); block.wait() }
        }, onLevel: { _ in }, onError: { XCTFail($0) })
        let buffer = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!, frameCapacity: 16)!
        buffer.frameLength = 16
        delivery.receive(buffer)
        await fulfillment(of: [entered], timeout: 2)
        delivery.receive(buffer)
        delivery.deactivate()
        delivery.receive(buffer)
        block.signal()
        await delivery.drain()
        XCTAssertEqual(count, 2)
    }

    func testQueueOverflowStopsAcceptanceAndReportsOnce() async {
        let entered = expectation(description: "blocked callback")
        let block = DispatchSemaphore(value: 0)
        var count = 0
        var errors: [String] = []
        let delivery = DictationMicrophoneDelivery(onAudio: { _ in
            count += 1
            if count == 1 { entered.fulfill(); block.wait() }
        }, onLevel: { _ in }, onError: { errors.append($0) })
        let buffer = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!, frameCapacity: 16)!
        buffer.frameLength = 16
        delivery.receive(buffer)
        await fulfillment(of: [entered], timeout: 2)
        for _ in 0..<40 { delivery.receive(buffer) }
        block.signal()
        await delivery.drain()
        XCTAssertEqual(count, 33)
        XCTAssertEqual(errors.count, 1)
    }
}

private final class PermissionCallback: @unchecked Sendable {
    private let lock = NSLock()
    private var callback: (@Sendable (Bool) -> Void)?
    func set(_ callback: @escaping @Sendable (Bool) -> Void) { lock.lock(); self.callback = callback; lock.unlock() }
    func answer(_ value: Bool) { lock.lock(); let completion = callback; lock.unlock(); completion?(value) }
}
