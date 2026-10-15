import XCTest
import AVFoundation
@testable import CallScribe
final class TranscriptTests: XCTestCase {
    func testReadableCopyPreservesWordsSpeakersAndMarksUnfinishedText() {
        var doc = TranscriptDocument()
        doc.title = "План проекта"
        doc.append(channel: .microphone, session: "s", segment: 1, seconds: 2, text: "Не удаляй 15 файлов. API v2.")
        doc.append(channel: .call, session: "s", segment: 1, seconds: 3, text: "Согласен.")
        let text = doc.readableText(partials: [.call: "Ещё проверим", .microphone: "  "])
        XCTAssertEqual(text, "План проекта\n\n[00:02] Я\nНе удаляй 15 файлов. API v2.\n\n[00:03] Собеседники\nСогласен.\n\nСобеседники · незавершённая фраза\nЕщё проверим")
        XCTAssertFalse(text.contains("Голоса по времени"))
        XCTAssertEqual(doc.lines.count, 2)
    }
    func testSeparateChannelsAndDuplicateFinals() {
        var doc = TranscriptDocument()
        doc.append(channel: .microphone, session: "a", segment: 1, seconds: 2, text: "Не удаляй 15 файлов")
        doc.append(channel: .microphone, session: "a", segment: 1, seconds: 3, text: "duplicate")
        doc.append(channel: .call, session: "a", segment: 1, seconds: 3, text: "Согласен")
        XCTAssertEqual(doc.lines.count, 2); XCTAssertTrue(doc.plainText.contains("Не удаляй 15 файлов"))
        XCTAssertTrue(doc.plainText.contains("[00:03] Собеседники"))
    }
    func testFinalsAreOrderedByAudioTimeAndKeepEqualTimeOrder() {
        var doc = TranscriptDocument()
        doc.append(channel: .call, session: "s", segment: 2, seconds: 10, text: "Later")
        doc.append(channel: .microphone, session: "s", segment: 1, seconds: 1, text: "Earlier")
        doc.append(channel: .call, session: "s", segment: 1, seconds: 1, text: "Same time")
        XCTAssertEqual(doc.lines.map(\.text), ["Earlier", "Same time", "Later"])
    }
    func testUnsupportedRateIsReported() {
        let format = AVAudioFormat(standardFormatWithSampleRate: 192000, channels: 1)!
        let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 10)!; pcm.frameLength = 10
        var errors: [String] = []
        let packets = AudioPacketizer(emit: { _, _, _ in XCTFail("Unsupported rate was emitted") }, error: { errors.append($0) })
        packets.append(pcm, channel: .call)
        XCTAssertEqual(errors.count, 1)
    }
    func testArchiveRoundtripAndInvalidID() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let archive = TranscriptArchive(directory: url); var doc = TranscriptDocument()
        doc.append(channel: .call, session: "1", segment: 2, seconds: 0, text: "Текст")
        try archive.save(doc); XCTAssertEqual(archive.latest()?.lines, doc.lines)
        doc.id = "../escape"; XCTAssertThrowsError(try archive.save(doc))
    }
    func testPacketizerPreservesShortTailAndAveragesStereo() throws {
        let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 2)!
        let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1700)!; pcm.frameLength = 1700
        for i in 0..<1700 { pcm.floatChannelData![0][i] = 0.6; pcm.floatChannelData![1][i] = 0.2 }
        var chunks = [Data](); let packets = AudioPacketizer(emit: { _, data, _ in chunks.append(data) }, error: { XCTFail($0) })
        packets.append(pcm, channel: .call); XCTAssertEqual(chunks.count, 1); packets.flush()
        XCTAssertEqual(chunks.map(\.count), [6400, 400])
        XCTAssertEqual(chunks[0].withUnsafeBytes { $0.loadUnaligned(as: Float.self) }, 0.4, accuracy: 0.0001)
    }
}
