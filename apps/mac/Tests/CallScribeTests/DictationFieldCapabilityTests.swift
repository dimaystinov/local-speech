import XCTest
@testable import CallScribe

final class DictationFieldCapabilityTests: XCTestCase {
    private func field(role: String? = "AXTextArea", subrole: String? = nil, enabled: Bool? = nil,
                       range: Bool = true, selected: Bool = true, value: Bool = false) -> DictationFieldCapabilities {
        DictationFieldCapabilities(role: role, subrole: subrole, enabled: enabled,
                                   selectionWritable: range, selectedTextWritable: selected, valueWritable: value)
    }

    func testOrdinaryTextAreaCanOmitOptionalSubroleAndEnabledAttributes() throws {
        try field().validateEditableText()
        try field(role: "AXTextField", enabled: true).validateEditableText()
        XCTAssertTrue(field().selectedTextWritable)
    }

    func testExplicitSecureDisabledOrReadOnlyControlsStillReject() {
        for capabilities in [field(subrole: "AXSecureTextField"), field(enabled: false), field(range: false),
                             field(role: "AXGroup"), field(role: nil)] {
            XCTAssertThrowsError(try capabilities.validateEditableText())
        }
    }

    func testMissingSelectedTextSupportIsReportedAndNotInferredFromWritableWholeValue() throws {
        let capabilities = field(selected: false, value: true)
        try capabilities.validateEditableText()
        XCTAssertFalse(capabilities.selectedTextWritable)
        XCTAssertTrue(capabilities.diagnostic.contains("selectedWrite=false"))
        XCTAssertTrue(capabilities.diagnostic.contains("valueWrite=true"))
    }

    func testDiagnosticsNeverEchoArbitraryApplicationAttributes() {
        let capabilities = field(role: "PRIVATE DOCUMENT CONTENT", subrole: "SECRET USER VALUE", enabled: nil)
        XCTAssertFalse(capabilities.diagnostic.contains("PRIVATE"))
        XCTAssertFalse(capabilities.diagnostic.contains("SECRET"))
        XCTAssertTrue(capabilities.diagnostic.contains("role=other"))
        XCTAssertTrue(capabilities.diagnostic.contains("subrole=present"))
        XCTAssertTrue(capabilities.diagnostic.contains("enabled=missing"))
        XCTAssertThrowsError(try capabilities.validateEditableText()) { error in
            XCTAssertFalse(error.localizedDescription.contains("PRIVATE"))
            XCTAssertFalse(error.localizedDescription.contains("SECRET"))
        }
    }
}
