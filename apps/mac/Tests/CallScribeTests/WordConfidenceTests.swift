import XCTest
@testable import CallScribe
final class WordConfidenceTests: XCTestCase {
 func testReviewDoesNotSilentlyReplaceTranscript() {
  var doc = TranscriptDocument()
  doc.append(channel: .call, session: "s", segment: 1, seconds: 0, text: "Проверь докер")
  let review = WordConfidenceReview(original: "Проверь докер", text: "Проверь Docker", words: [.init(word: "докер", probability: 0.3)], changes: [.init(index: 1, from: "докер", to: "Docker")], elapsedSeconds: 1, rechecked: true)
  XCTAssertTrue(review.valid)
  XCTAssertTrue(doc.attachWordReview(id: "call:s:1", review: review))
  XCTAssertEqual(doc.lines[0].text, "Проверь докер")
  XCTAssertEqual(doc.lines[0].wordReview?.text, "Проверь Docker")
 }
 func testInvalidAndStaleEvidenceRejected() {
  var doc = TranscriptDocument()
  doc.append(channel: .call, session: "s", segment: 1, seconds: 0, text: "Привет")
  let review = WordConfidenceReview(original: "другое", text: "Docker", words: [.init(word: "x", probability: 2)], changes: [], elapsedSeconds: 1, rechecked: true)
  XCTAssertFalse(review.valid)
  XCTAssertFalse(doc.attachWordReview(id: "call:s:1", review: review))
 }
}
