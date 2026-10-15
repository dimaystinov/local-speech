import XCTest
@testable import CallScribe

/// Exercises the actual coordinators before AX, permission prompts or audio capture.
/// It does not open a target editor or grant access to the test process.
@MainActor final class DictationCoordinatorTests: XCTestCase {
    func testDictationWithoutOwnerEnrollmentDoesNotStartOrTakeSDKCallbacks() async {
        let sdk = SDKHost(); defer { sdk.shutdown() }
        let input = DictationModel(sdk: sdk, canStart: { true }, configuration: { ("mixed", [], false) })
        input.toggle(delayed: true)
        let observed = input.state
        await input.stop()
        XCTAssertEqual(observed, "idle", "Unenrolled background voices must not activate dictation")
        XCTAssertNotNil(input.error)
    }
    func testUnavailableSDKPreventsDictationAndUndoWithoutTakingCallbacks() async {
        let sdk = SDKHost()
        defer { sdk.shutdown() }
        var eventCount = 0
        var configurations = 0
        sdk.onEvent = { _, _ in eventCount += 1 }
        let input = DictationModel(sdk: sdk, canStart: { false }, configuration: {
            configurations += 1
            return ("mixed", [], false)
        })
        input.toggle()
        input.undo()
        await Task.yield()
        XCTAssertEqual(input.state, "idle")
        XCTAssertNotNil(input.error)
        XCTAssertEqual(configurations, 0)
        sdk.onEvent?(.microphone, [:])
        XCTAssertEqual(eventCount, 1)
        XCTAssertEqual(sdk.outstanding, 0)
    }

    func testConcurrentStopsCancelArmingAndAllowRepeatedStarts() async {
        let sdk = SDKHost()
        defer { sdk.shutdown() }
        var eventCount = 0
        var configurations = 0
        sdk.onEvent = { _, _ in eventCount += 1 }
        let input = DictationModel(sdk: sdk, canStart: { true }, configuration: {
            configurations += 1
            return ("mixed", [], false)
        })
        for _ in 0..<5 {
            input.ownerOnly = false
            input.toggle(delayed: true)
            XCTAssertEqual(input.state, "arming")
            await Task.yield()
            let first = Task { await input.stop() }
            let second = Task { await input.stop() }
            await first.value
            await second.value
            XCTAssertEqual(input.state, "idle")
            XCTAssertFalse(input.active)
            XCTAssertNil(input.error)
        }
        XCTAssertEqual(configurations, 0, "Cancelled arming must never prepare the SDK")
        sdk.onEvent?(.microphone, [:])
        XCTAssertEqual(eventCount, 1)
        XCTAssertEqual(sdk.outstanding, 0)
    }

    func testUndoDelayCanBeCancelledWithoutReadingOrMutatingExternalField() async {
        let sdk = SDKHost()
        defer { sdk.shutdown() }
        let input = DictationModel(sdk: sdk, canStart: { true }, configuration: { ("mixed", [], false) })
        input.undo()
        XCTAssertEqual(input.state, "undoing")
        await Task.yield()
        await input.stop()
        XCTAssertEqual(input.state, "idle")
        XCTAssertNil(input.error, "Cancelled delay must not attempt AX undo with no target")
        input.ownerOnly = false
        input.toggle(delayed: true)
        XCTAssertEqual(input.state, "arming")
        await input.stop()
        XCTAssertEqual(input.state, "idle")
    }

    func testArmingDictationExcludesCallFileEnrollmentAndNewDocumentAtModelBoundary() async {
        let calls = CallModel()
        defer { calls.sdk.shutdown() }
        calls.ready = true
        // Replace loaded display state with a synthetic in-memory document. All
        // mutation paths below must return before persistence, panels or capture.
        calls.document = TranscriptDocument()
        calls.error = nil
        var fixture = TranscriptDocument()
        fixture.append(channel: .call, session: "coordinator-fixture", segment: 1, seconds: 0, text: "Untouched fixture")
        calls.voiceName = "Fixture voice"
        let originalID = calls.document.id
        let originalLines = calls.document.lines
        let originalVoiceStatus = calls.voiceStatus
        let originalVoices = calls.voices
        let input = DictationModel(sdk: calls.sdk,
            canStart: { calls.ready && !calls.active && !calls.enrolling && !calls.panelOpen },
            configuration: { ("mixed", [], false) })
        calls.externalSessionActive = { [weak input] in input?.active ?? false }
        input.ownerOnly = false
        input.toggle(delayed: true)
        XCTAssertTrue(input.active)
        await calls.start()
        await calls.testFile(URL(fileURLWithPath: "/nonexistent-dictation-coordinator-fixture.wav"))
        calls.rememberVoice(fixture.lines[0])
        calls.newDocument()
        XCTAssertEqual(calls.state, "idle")
        XCTAssertFalse(calls.enrolling)
        XCTAssertFalse(calls.panelOpen)
        XCTAssertNil(calls.error)
        XCTAssertEqual(calls.document.id, originalID)
        XCTAssertEqual(calls.document.lines, originalLines)
        XCTAssertEqual(calls.voiceStatus, originalVoiceStatus)
        XCTAssertEqual(calls.voices.map(\.id), originalVoices.map(\.id))
        await input.stop()
        XCTAssertFalse(calls.externalSessionActive())
    }
}
