import XCTest
@testable import CallScribe

final class DictationFormattingTests: XCTestCase {
    func testInsertionBetweenWordsKeepsBothBoundaries() {
        XCTAssertEqual(DictationFormatting.join("new", after: "Hello ", before: "world"), "new ")
        XCTAssertEqual(DictationFormatting.join("мир", after: "Привет", before: "снова"), " мир ")
    }
    func testPunctuationWhitespaceAndParentheses() {
        XCTAssertEqual(DictationFormatting.join("API", after: "(", before: ")"), "API")
        XCTAssertEqual(DictationFormatting.join("да", after: "\n", before: ", конечно"), "да")
        XCTAssertEqual(DictationFormatting.join("нет", after: "да ", before: " потом"), "нет")
        XCTAssertEqual(DictationFormatting.join(",", after: "да"), ",")
    }
    func testNamesNegationNumbersAndMixedTechnicalTermsAreUnchanged() {
        XCTAssertEqual(DictationFormatting.join("Не меняй API v2.1 и 42,5 — Иван 👨‍💻", after: ""), "Не меняй API v2.1 и 42,5 — Иван 👨‍💻")
        XCTAssertEqual(DictationFormatting.join("   ", after: "a", before: "b"), "")
    }
}
