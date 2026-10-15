import XCTest
@testable import CallScribe

final class RokiVoiceIntegrationTests: XCTestCase {
    @MainActor func testInstalledVoiceRealPlaybackEnvelopePauseResumeAndStop() async throws {
        guard ProcessInfo.processInfo.environment["LOCALSPEECH_TEST_SYSTEM_VOICE"] == "1" else {
            throw XCTSkip("Opt in to audible system-voice integration with LOCALSPEECH_TEST_SYSTEM_VOICE=1")
        }
        let voice = RokiVoice()
        let originalStyle = voice.style
        voice.style = ProcessInfo.processInfo.environment["LOCALSPEECH_TEST_ESPEAK_VOICE"] == "1" ? .espeakFemale : .system
        let qwen = ProcessInfo.processInfo.environment["LOCALSPEECH_TEST_QWEN_VOICE"] == "1"
        let streamed = qwen && ProcessInfo.processInfo.environment["LOCALSPEECH_TEST_QWEN_STREAM"] == "1"
        if qwen {
            let assets = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Assets")
            let runtime = try XCTUnwrap(RokiQwenRuntime.installed(resources: assets))
            if streamed {
                voice.streamWorker = RokiQwenStream(runtime: runtime)
                voice.warmVoice()
                let deadline = Date().addingTimeInterval(120)
                while !voice.warmReady && Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
                XCTAssertTrue(voice.warmReady)
            } else { voice.makeQwenJob = { RokiQwenJob(runtime: runtime) } }
            voice.style = .qwen
        }
        defer { voice.shutdownVoice(); voice.style = originalStyle }
        voice.speak("Привет. Я Роки. Помогу с планами, напомню о встрече и подожду, пока вы закончите разговор.")
        let deadline = Date().addingTimeInterval(qwen ? 110 : 24)
        while voice.preparing && Date() < deadline { try await Task.sleep(nanoseconds: 25_000_000) }
        XCTAssertNil(voice.error)
        XCTAssertTrue(voice.speaking)
        XCTAssertGreaterThan(voice.duration, streamed ? 0.5 : 2)
        if streamed { XCTAssertTrue(voice.streamGenerating, "Playback starts before generation ends") }
        var maximum: Float = 0
        for _ in 0..<50 {
            maximum = max(maximum, voice.mouthLevel)
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTAssertGreaterThan(maximum, 0.1, "Actual playing PCM must open the mouth")
        voice.togglePause()
        XCTAssertTrue(voice.paused)
        XCTAssertEqual(voice.mouthLevel, 0)
        let pausedTime = voice.playbackTime
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(voice.playbackTime, pausedTime, accuracy: 0.02)
        voice.togglePause()
        XCTAssertTrue(voice.speaking)
        var maximumDuration = voice.duration
        while voice.busy && Date() < deadline { maximumDuration = max(maximumDuration, voice.duration); try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertGreaterThan(maximumDuration, 2)
        if streamed { XCTAssertEqual(voice.streamUnderruns, 0) }
        XCTAssertFalse(voice.busy)
        XCTAssertNil(voice.error)
        XCTAssertEqual(voice.mouthLevel, 0)
        voice.speak("Этот ответ будет отменён сразу.")
        voice.stop()
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertFalse(voice.busy, "Late synthesis callbacks must not restart stopped playback")
        XCTAssertEqual(voice.mouthLevel, 0)
    }
}
