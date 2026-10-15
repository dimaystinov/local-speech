import XCTest
@testable import CallScribe

final class DictationSubmitPolicyTests: XCTestCase {
    private func button(_ labels: [String], role: String? = "AXButton", enabled: Bool? = true,
                        actions: [String] = ["AXPress"]) -> DictationSubmitPolicy.Candidate {
        .init(role: role, enabled: enabled, labels: labels, actions: actions)
    }

    func testOnlyExactExplicitSendLabelsMatch() {
        for label in ["Send", "SEND MESSAGE", "Отправить", "отправить сообщение", " Send "] {
            XCTAssertTrue(DictationSubmitPolicy.matches(button([label])), label)
        }
        for label in ["Send feedback", "Send and delete", "Send money", "Отправить отзыв", "Resend", "Submit", "", "↵"] {
            XCTAssertFalse(DictationSubmitPolicy.matches(button([label])), label)
        }
    }

    func testRequiresEnabledButtonWithPressActionAndConsistentLabels() {
        XCTAssertFalse(DictationSubmitPolicy.matches(button(["Send"], role: "AXMenuItem")))
        XCTAssertFalse(DictationSubmitPolicy.matches(button(["Send"], enabled: false)))
        XCTAssertFalse(DictationSubmitPolicy.matches(button(["Send"], enabled: nil)))
        XCTAssertFalse(DictationSubmitPolicy.matches(button(["Send"], actions: ["AXShowMenu"])))
        XCTAssertFalse(DictationSubmitPolicy.matches(button(["Send", "Delete message"])))
        XCTAssertTrue(DictationSubmitPolicy.matches(button(["↑", "Send message"])))
        XCTAssertTrue(DictationSubmitPolicy.matches(button(["Send", "Отправить сообщение"])))
    }

    func testAmbiguityRejectsInsteadOfChoosingFirstButton() throws {
        XCTAssertNil(try DictationSubmitPolicy.uniqueIndex(in: [button(["Cancel"])]))
        XCTAssertEqual(try DictationSubmitPolicy.uniqueIndex(in: [button(["Cancel"]), button(["Send"])]), 1)
        XCTAssertThrowsError(try DictationSubmitPolicy.uniqueIndex(in: [button(["Send"]), button(["Отправить"])]))
        XCTAssertEqual(try DictationSubmitPolicy.uniqueIndex(in: [button(["Send"], enabled: false), button(["Send message"])]), 1)
    }

    func testLookupDoesNotDescendIntoMenusFieldsOrWholeApplications() {
        for role in ["AXMenu", "AXMenuBar", "AXMenuItem", "AXTextField", "AXTextArea", "AXApplication"] {
            XCTAssertTrue(DictationSubmitPolicy.skipsSubtree(role: role))
        }
        XCTAssertFalse(DictationSubmitPolicy.skipsSubtree(role: "AXGroup"))
        XCTAssertFalse(DictationSubmitPolicy.skipsSubtree(role: "AXWebArea"))
    }
}
