import XCTest
@testable import CallScribe

final class DictationActivationTests: XCTestCase {
    func testBothPhrasesActivateTheSameModeAndReturnTheSameRemainder() {
        for phrase in ["Роки", "Роки два", "Роки 2"] {
            XCTAssertEqual(DictationActivation.consume(phrase), "")
            XCTAssertEqual(DictationActivation.consume(phrase + " Проверь Swift SDK 2.0"), "Проверь Swift SDK 2.0")
        }
    }

    func testCyrillicAndEnglishSpellingVariantsAreCaseInsensitive() {
        for name in ["роки", "РОКИ", "Рокки", "рОкКи", "Rocky", "ROCKY"] {
            XCTAssertEqual(DictationActivation.consume(name + " ДВА: Hello, Kubernetes!"), "Hello, Kubernetes!")
        }
    }

    func testWhitespaceAndPunctuationCanSeparateTheAnchoredCommand() {
        XCTAssertEqual(DictationActivation.consume(" \n«Роки», два — Проверь API, пожалуйста.  "), "Проверь API, пожалуйста.")
        XCTAssertEqual(DictationActivation.consume("Роки!\n2:\tПуть /api/v1 — правильный."), "Путь /api/v1 — правильный.")
        XCTAssertEqual(DictationActivation.consume("Роки, скажи «Hello»!"), "скажи «Hello»!")
        XCTAssertEqual(DictationActivation.consume("Роки два..."), "")
    }

    func testActivationMustBeAtStartAndUseAnExactName() {
        for text in ["", "  ... ", "Руки два", "руки", "Рокировка", "рокидва", "Rocky2", "rocking", "Эй, Роки", "Скажи Роки два", "Не Роки", "📣 Роки"] {
            XCTAssertNil(DictationActivation.consume(text), text)
        }
    }

    func testOnlyExactOptionalTwoTokenIsConsumed() {
        XCTAssertEqual(DictationActivation.consume("Роки двадцать файлов"), "двадцать файлов")
        XCTAssertEqual(DictationActivation.consume("Роки 20 файлов"), "20 файлов")
        XCTAssertEqual(DictationActivation.consume("Роки дважды проверь"), "дважды проверь")
        XCTAssertEqual(DictationActivation.consume("Роки two files"), "two files")
        XCTAssertEqual(DictationActivation.consume("Роки два два файла"), "два файла")
    }

    func testManualDictationNeverTriggersActivationActions() {
        for text in ["Роки", "Роки два", "Роки 2 Отправь сообщение", "Обычный текст"] {
            XCTAssertNil(DictationActivation.consume(text, waitingForActivation: false))
        }
        XCTAssertEqual(DictationActivation.consume("Роки два Привет", waitingForActivation: true), "Привет")
        XCTAssertNil(DictationActivation.consume("Привет, Роки", waitingForActivation: true))
    }
}
