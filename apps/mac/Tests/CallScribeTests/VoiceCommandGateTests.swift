import XCTest
@testable import CallScribe

final class VoiceCommandGateTests: XCTestCase {
    func testRejectionReasonsDistinguishOverlapForeignVoiceShortSpeechAndTimeout() {
        for (person, kind, reason) in [("owner", "overlap", "overlap"), ("other", "known", "otherSpeaker"), ("owner", "uncertain", "unverified")] {
            var gate = VoiceCommandGate(ownerID: "owner")
            _ = gate.submit(text(), now: 0)
            _ = gate.submit(voice(person: person, kind: kind), voice: true, now: 1)
            XCTAssertEqual(gate.lastRejection?.rawValue, reason)
        }
        var gate = VoiceCommandGate(ownerID: "owner")
        var shortText = text(); shortText["endMs"] = 1500.0
        var shortVoice = voice(); shortVoice["intervals"] = [["startMs":0.0,"endMs":1500.0,"kind":"known","speakerId":"owner"]]
        _ = gate.submit(shortText, now: 0)
        _ = gate.submit(shortVoice, voice: true, now: 1)
        XCTAssertEqual(gate.lastRejection?.rawValue, "tooShort")
        _ = gate.submit(text(2), now: 2); _ = gate.drain(now: 10)
        XCTAssertEqual(gate.lastRejection?.rawValue, "timeout")
        XCTAssertEqual(gate.rejectionCounts[.timeout], 1)
        XCTAssertEqual(gate.rejectionCounts[.tooShort], 1)
    }
    private func text(_ segment: Int = 1, session: String = "session") -> [String: Any] {
        ["type":"final", "sessionId":session, "segmentId":segment, "rawText":"Роки проверь проект", "startMs":0.0, "endMs":4000.0]
    }
    private func voice(_ segment: Int = 1, person: String = "owner", kind: String = "known") -> [String: Any] {
        ["type":"speaker", "channel":"microphone", "sessionId":"session", "segmentId":segment, "kind":kind, "speakerId":person,
         "intervals":[["startMs":0.0,"endMs":4000.0,"kind":kind,"speakerId":person]]]
    }
    func testOnlyVerifiedOwnerTextIsReleasedAndDuplicatesDoNotActTwice() {
        var gate = VoiceCommandGate(ownerID: "owner")
        XCTAssertTrue(gate.submit(text(), now: 0).isEmpty)
        XCTAssertEqual(gate.submit(voice(), voice: true, now: 1).count, 1)
        XCTAssertTrue(gate.submit(text(), now: 2).isEmpty)
        XCTAssertTrue(gate.submit(voice(), voice: true, now: 2).isEmpty)
        XCTAssertEqual(gate.pendingCount, 0)
    }
    func testOtherPeopleOverlapAndUncertainResultsCannotActivate() {
        for (person,kind) in [("other","known"),("owner","overlap"),("owner","uncertain"),("owner","anonymous")] {
            var gate = VoiceCommandGate(ownerID: "owner")
            _ = gate.submit(text(), now: 0)
            XCTAssertTrue(gate.submit(voice(person: person, kind: kind), voice: true, now: 1).isEmpty)
            XCTAssertEqual(gate.rejected, 1)
        }
    }
    func testOutOfOrderResultsPreserveTextOrderAndEarlyVoiceCanPair() {
        var gate = VoiceCommandGate(ownerID: "owner")
        _ = gate.submit(text(1), now: 0); _ = gate.submit(text(2), now: 0)
        XCTAssertTrue(gate.submit(voice(2), voice: true, now: 1).isEmpty)
        XCTAssertEqual(gate.submit(voice(1), voice: true, now: 2).compactMap { $0["segmentId"] as? Int }, [1,2])
        _ = gate.submit(voice(3), voice: true, now: 3)
        XCTAssertEqual(gate.submit(text(3), now: 4).count, 1)
    }
    func testTimeoutMissingIntervalsAndLateResultsFailClosed() {
        var gate = VoiceCommandGate(ownerID: "owner")
        _ = gate.submit(text(), now: 0); XCTAssertTrue(gate.drain(now: 8).isEmpty)
        XCTAssertTrue(gate.submit(voice(), voice: true, now: 9).isEmpty)
        _ = gate.submit(text(2), now: 10)
        var missing = voice(2); missing.removeValue(forKey: "intervals")
        XCTAssertTrue(gate.submit(missing, voice: true, now: 11).isEmpty)
        XCTAssertEqual(gate.rejected, 2)
        gate.close(); XCTAssertTrue(gate.submit(text(3), now: 12).isEmpty)
        XCTAssertEqual(gate.pendingCount, 0)
    }
    func testUncertainInterruptionCannotBorrowOwnersNameAndQueueIsBounded() {
        var gate = VoiceCommandGate(ownerID: "owner")
        _ = gate.submit(text(), now: 0)
        var bad = voice()
        bad["intervals"] = [["startMs":0.0,"endMs":3000.0,"kind":"known","speakerId":"owner"],
                            ["startMs":3000.0,"endMs":4000.0,"kind":"uncertain"]]
        XCTAssertTrue(gate.submit(bad, voice: true, now: 1).isEmpty)
        for i in 2...100 { _ = gate.submit(text(i), now: 2) }
        XCTAssertLessThanOrEqual(gate.pendingCount, 8)
        XCTAssertTrue(gate.submit(voice(2), voice: true, now: 3).isEmpty)
    }
    func testCallAudioAndDifferentSessionCannotAuthorizeMicrophoneText() {
        var gate = VoiceCommandGate(ownerID: "owner")
        _ = gate.submit(text(), now: 0)
        var remote = voice(); remote["channel"] = "call"
        XCTAssertTrue(gate.submit(remote, voice: true, now: 1).isEmpty)
        remote["channel"] = "microphone"; remote["sessionId"] = "different"
        XCTAssertTrue(gate.submit(remote, voice: true, now: 2).isEmpty)
        XCTAssertTrue(gate.drain(now: 10).isEmpty)
    }
}
