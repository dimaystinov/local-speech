import XCTest
@testable import CallScribe
final class NativeRefinementTests: XCTestCase {
    func testScopeKeepsEnglishMixedAndShortCommandsUntouched() {
        XCTAssertFalse(RefinementPolicy.eligible("Please check the API before deploying"))
        XCTAssertFalse(RefinementPolicy.eligible("Проверь пожалуйста наш GitHub перед публикацией"))
        XCTAssertFalse(RefinementPolicy.eligible("Роки отправь"))
        XCTAssertTrue(RefinementPolicy.eligible("Сегодня мы проверяем работу локального приложения"))
    }
    func testNumbersAndNegationsCannotChange() {
        let original = "Не удаляй пожалуйста эти 15 важных файлов"
        XCTAssertFalse(RefinementPolicy.accept(original: original, candidate: "Удаляй пожалуйста эти 15 важных файлов"))
        XCTAssertFalse(RefinementPolicy.accept(original: original, candidate: "Не удаляй пожалуйста эти 50 важных файлов"))
        XCTAssertTrue(RefinementPolicy.accept(original: original, candidate: "Не удаляй, пожалуйста, эти 15 важных файлов."))
    }
    func testBoundedAudioNeverReturnsPartialOrWrongSessionSpan() {
        var window = RefinementPCMWindow()
        let frame = Data(repeating: 0, count: 8000 * 4)
        for _ in 0..<31 { window.append(frame, rate: 8000) }
        XCTAssertNil(window.slice(start: 0, end: 1))
        XCTAssertEqual(window.slice(start: 1, end: 2)?.count, frame.count)
        XCTAssertNil(window.slice(start: 30, end: 32))
        XCTAssertNil(window.slice(start: .nan, end: 2))
        window.append(Data(repeating: 0, count: 16000 * 4), rate: 16000)
        XCTAssertEqual(window.slice(start: 0, end: 1)?.count, 64000)
        XCTAssertNil(window.slice(start: 1, end: 2))
    }
}
extension NativeRefinementTests {
    func testTranscriptRefinementPreservesRawAndRejectsStaleResults() {
        var document = TranscriptDocument()
        let raw = "Сегодня мы проверяем работу нового преложения"
        document.append(channel: .call, session: "test", segment: 1, seconds: 0, text: raw)
        let id = document.lines[0].id
        XCTAssertFalse(document.refine(id: id, original: "чужой текст", candidate: "Сегодня мы проверяем работу нового приложения"))
        XCTAssertTrue(document.refine(id: id, original: raw, candidate: "Сегодня мы проверяем работу нового приложения"))
        XCTAssertEqual(document.lines[0].originalText, raw)
        XCTAssertFalse(document.refine(id: id, original: raw, candidate: "Сегодня мы проверяем работу другого приложения"))
        let restored = try! JSONDecoder().decode(TranscriptDocument.self, from: JSONEncoder().encode(document))
        XCTAssertEqual(restored.lines[0].originalText, raw)
    }
}
extension NativeRefinementTests {
    func testLateOverlapRestoresOriginal() {
        var document = TranscriptDocument()
        let raw = "Сегодня мы проверяем работу нового преложения"
        document.append(channel: .call, session: "test", segment: 1, seconds: 0, text: raw)
        let id = document.lines[0].id
        XCTAssertTrue(document.refine(id: id, original: raw, candidate: "Сегодня мы проверяем работу нового приложения"))
        document.attribute(id: id, speaker: VoiceAttribution(label: "Одновременно", kind: "overlap", speakerId: nil))
        XCTAssertEqual(document.lines[0].text, raw)
        XCTAssertFalse(document.refine(id: id, original: raw, candidate: "Сегодня мы проверяем работу другого приложения"))
    }
}
extension NativeRefinementTests {
    func testLanguageDriftAndLargeDeletionsAreRejected() {
        XCTAssertFalse(RefinementPolicy.eligible("Дихатільне упражнення мантри і візуалізації сьогодні"))
        XCTAssertFalse(RefinementPolicy.accept(original: "Энергия кундалини энергия просветления в кундалини йоге пробуждается через позы", candidate: "Энергия кундалини это энергия просветления"))
    }
}
