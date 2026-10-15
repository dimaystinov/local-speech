import XCTest
@testable import CallScribe

final class RokiESpeakTests: XCTestCase {
    func wave(channels: Int = 1, frames: Int = 800, placeholder: Bool = false) -> Data {
        var data = Data()
        func tag(_ text: String) { data.append(contentsOf: text.utf8) }
        func word(_ n: UInt16) { data.append(UInt8(n & 255)); data.append(UInt8(n >> 8)) }
        func long(_ n: UInt32) { word(UInt16(n & 65535)); word(UInt16(n >> 16)) }
        let size = frames * channels * 2
        tag("RIFF"); long(placeholder ? 0x7ffff024 : UInt32(36 + size)); tag("WAVEfmt "); long(16)
        word(1); word(UInt16(channels)); long(8000); long(UInt32(8000 * channels * 2)); word(UInt16(channels * 2)); word(16)
        tag("data"); long(placeholder ? 0x7ffff000 : UInt32(size))
        for i in 0..<(frames * channels) { word(UInt16(bitPattern: Int16(i % 2 == 0 ? 5000 : -5000))) }
        return data
    }
    func testFiniteAndStreamingPCMDecodeToBoundedProperWAV() throws {
        for placeholder in [false, true] {
            let clip = try RokiESpeakWAV.decode(wave(placeholder: placeholder))
            XCTAssertEqual(clip.duration, 0.1, accuracy: 0.00001)
            XCTAssertEqual(clip.wav.count, 1644)
            XCTAssertFalse(clip.levels.isEmpty)
        }
        let stereo = try RokiESpeakWAV.decode(wave(channels: 2))
        XCTAssertEqual(stereo.duration, 0.1, accuracy: 0.00001)
        XCTAssertEqual(stereo.wav.count, 1644)
    }
    func testMalformedAndTruncatedWAVRejected() {
        var bad = wave(); bad[20] = 3
        var badRate = wave(); badRate[24] = 1; badRate[25] = 0
        var badChannels = wave(); badChannels[22] = 3
        var badBits = wave(); badBits[34] = 8
        var badLength = wave(); badLength[40] = 255; badLength[41] = 255
        var odd = wave(placeholder: true); odd.removeLast()
        for data in [Data(), Data("RIFFbad".utf8), bad, badRate, badChannels, badBits, badLength, odd, wave().dropLast()] {
            XCTAssertThrowsError(try RokiESpeakWAV.decode(Data(data)))
        }
    }
    func testDurationAndOutputBoundsRejected() {
        XCTAssertThrowsError(try RokiESpeakWAV.decode(wave(frames: 8000 * 60 + 1)))
        XCTAssertThrowsError(try RokiESpeakWAV.decode(Data(repeating: 0, count: RokiESpeakWAV.byteLimit + 1)))
    }
    func testCancellationBeforeStartCompletesExactlyOnce() async {
        let done = expectation(description: "cancelled")
        done.assertForOverFulfill = true
        let job = RokiESpeakJob(); job.cancel(); job.cancel()
        job.start(text: "A cancelled synthetic test", voice: "en+m1") { result in
            if case .failure(let error) = result { XCTAssertEqual(error as? RokiESpeakError, .cancelled) }
            else { XCTFail("Cancelled job must not generate audio") }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 2)
        job.cancel()
    }
    func testRejectsInvalidInputWithoutEngine() async {
        let done = expectation(description: "invalid")
        RokiESpeakJob().start(text: "hello", voice: "en+m1; echo unsafe") { result in
            if case .failure(let error) = result { XCTAssertEqual(error as? RokiESpeakError, .invalidInput) }
            else { XCTFail("Voice must be allowlisted") }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 2)
    }
    func testInstalledEngineSynthesizesEnglishAndRussianWithoutPlayback() async throws {
        guard ProcessInfo.processInfo.environment["ROKI_ESPEAK_TEST"] == "1" else { throw XCTSkip("Opt-in actual local eSpeak synthesis") }
        for (voice, text) in [("en+m1", "Hello, this is Roki."), ("ru+m1", "Привет, это Роки."), ("en+f1", "Hello, this is Roki."), ("ru+f1", "Привет, это Роки.")] {
            let done = expectation(description: voice)
            let job = RokiESpeakJob()
            job.start(text: text, voice: voice) { result in
                switch result {
                case .success(let clip): XCTAssertGreaterThan(clip.duration, 0.2); XCTAssertLessThan(clip.duration, 20); XCTAssertTrue(clip.levels.contains { $0 > 0 })
                case .failure(let error): XCTFail(error.localizedDescription)
                }
                done.fulfill()
            }
            await fulfillment(of: [done], timeout: 22)
        }
    }
}
