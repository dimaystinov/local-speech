import XCTest
@testable import CallScribe

final class SpeakerContextNamesTests: XCTestCase {
    func testSelfIntroductionSuggestsNameOnlyForSameAnonymousVoiceInSameSession() {
        var doc = TranscriptDocument()
        doc.append(channel: .call, session: "s1", segment: 1, seconds: 0, text: "Привет. Меня зовут Анна, я заказчик.")
        doc.append(channel: .call, session: "s1", segment: 2, seconds: 5, text: "Обсудим проект.")
        doc.append(channel: .call, session: "s2", segment: 1, seconds: 10, text: "Другой созвон.")
        for id in ["call:s1:1","call:s1:2","call:s2:1"] {
            doc.attribute(id: id, speaker: VoiceAttribution(label: "Голос 1", kind: "anonymous", speakerId: "voice1"))
        }
        XCTAssertTrue(doc.lines[0].speakerLabel.contains("Анна"))
        XCTAssertTrue(doc.lines[1].speakerLabel.contains("предположительно"))
        XCTAssertFalse(doc.lines[2].speakerLabel.contains("Анна"))
        XCTAssertEqual(doc.lines[0].speaker?.speakerId, "voice1")
        XCTAssertEqual(doc.lines[0].speaker?.kind, "anonymous")
    }
    func testQuotedNamesOtherPeopleAndMixedSpeechDoNotRenameSpeakers() {
        for text in ["Анна, проверь проект", "Он сказал: меня зовут Анна", "Меня зовут домой", "\"Меня зовут Анна\"", "I am ready"] {
            var doc = TranscriptDocument()
            doc.append(channel: .call, session: "s", segment: 1, seconds: 0, text: text)
            doc.attribute(id: "call:s:1", speaker: VoiceAttribution(label: "Голос 1", kind: "anonymous", speakerId: "voice1"))
            XCTAssertEqual(doc.lines[0].speakerLabel, "Собеседники · Голос 1")
        }
        for kind in ["known","overlap","mixed","uncertain"] {
            var doc = TranscriptDocument()
            doc.append(channel: .call, session: "s", segment: 1, seconds: 0, text: "My name is Alice.")
            doc.attribute(id: "call:s:1", speaker: VoiceAttribution(label: "Original", kind: kind, speakerId: "person"))
            XCTAssertFalse(doc.lines[0].speakerLabel.contains("Alice"))
        }
    }
    func testConflictingIntroductionsRemoveSuggestionWithoutChangingVoiceIdentity() {
        var doc = TranscriptDocument()
        for (i,name) in ["Alice","Mary"].enumerated() {
            doc.append(channel: .call, session: "s", segment: i, seconds: Double(i), text: "My name is \(name).")
            doc.attribute(id: "call:s:\(i)", speaker: VoiceAttribution(label: "Голос 1", kind: "anonymous", speakerId: "voice1"))
        }
        XCTAssertTrue(doc.lines.allSatisfy { $0.speakerLabel == "Собеседники · Голос 1" })
    }
}
