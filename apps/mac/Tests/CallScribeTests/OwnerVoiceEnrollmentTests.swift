import XCTest
@testable import CallScribe

final class OwnerVoiceEnrollmentTests: XCTestCase {
    private func pcm(_ count: Int) -> Data { Array(repeating: Float(0.1), count: count).withUnsafeBytes { Data($0) } }
    func testCaptureIsBoundedAndRequiresEnoughAudio() throws {
        let buffer = OwnerVoiceSample()
        buffer.append(pcm(8000), rate: 8000)
        XCTAssertThrowsError(try buffer.snapshot())
        for _ in 0..<20 { buffer.append(pcm(8000), rate: 8000) }
        let (data, rate) = try buffer.snapshot()
        XCTAssertEqual(rate, 8000); XCTAssertEqual(data.count, 12 * 8000 * 4)
    }
    func testFormatChangesAndCaptureErrorsCannotProduceOwnerProfile() {
        let changed = OwnerVoiceSample()
        changed.append(pcm(32000), rate: 8000); changed.append(pcm(16000), rate: 16000)
        XCTAssertThrowsError(try changed.snapshot())
        let failed = OwnerVoiceSample(); failed.append(pcm(32000), rate: 8000)
        failed.fail("Microphone disconnected")
        XCTAssertThrowsError(try failed.snapshot())
    }
}
