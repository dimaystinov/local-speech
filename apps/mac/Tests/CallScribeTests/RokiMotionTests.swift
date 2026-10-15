import XCTest
@testable import CallScribe

final class RokiMotionTests: XCTestCase {
    func testReducedMotionKeepsPortraitStillForEveryEmotionAndGesture() {
        for emotion in RokiEmotion.allCases {
            for gesture in RokiGesture.allCases {
                let pose = RokiPose.sample(time: 8, emotion: emotion, gesture: gesture, gestureTime: 1, reduced: true)
                XCTAssertEqual(pose.map(SIMD2(0.12, 0.8)), SIMD2(0.12, 0.8))
            }
        }
    }
    func testFeetPlantedAndMeshHasNoInvertedCellsDuringGestures() {
        func cross(_ a: SIMD2<Float>, _ b: SIMD2<Float>, _ c: SIMD2<Float>) -> Float {
            let ab = b - a, ac = c - a
            return ab.x * ac.y - ab.y * ac.x
        }
        for emotion in RokiEmotion.allCases {
            for gesture in RokiGesture.allCases {
                for step in 0...12 {
                    let pose = RokiPose.sample(time: Double(step) * 0.6, emotion: emotion, gesture: gesture, gestureTime: Double(step) * 0.2, reduced: false)
                    XCTAssertEqual(pose.map(SIMD2(0.3, 0.05)), SIMD2(0.3, 0.05))
                    for row in 0..<38 {
                        for column in 0..<22 {
                            let a = pose.map(SIMD2(Float(column) / 22, Float(row) / 38))
                            let b = pose.map(SIMD2(Float(column + 1) / 22, Float(row) / 38))
                            let c = pose.map(SIMD2(Float(column) / 22, Float(row + 1) / 38))
                            let d = pose.map(SIMD2(Float(column + 1) / 22, Float(row + 1) / 38))
                            XCTAssertTrue(a.x.isFinite && a.y.isFinite)
                            XCTAssertGreaterThan(cross(a, b, c), 0)
                            XCTAssertGreaterThan(cross(b, d, c), 0)
                        }
                    }
                }
            }
        }
    }
    func testSpringLagsHeadMotionAndReturnsToRestWithoutExplosion() {
        var spring = RokiSpring()
        XCTAssertLessThan(spring.advance(target: 0.04, delta: 1.0 / 30), 0.04)
        for _ in 0..<60 { _ = spring.advance(target: 0.04, delta: 1.0 / 30) }
        XCTAssertEqual(spring.value, 0.04, accuracy: 0.001)
        for _ in 0..<150 { _ = spring.advance(target: 0, delta: 1.0 / 30) }
        XCTAssertEqual(spring.value, 0, accuracy: 0.0001)
    }
    func testContextConcernPrecedesListeningAndReplyHintsAreConservative() {
        XCTAssertEqual(RokiEmotion.context(dictation: "listening", callActive: false, hasError: true), .concerned)
        XCTAssertEqual(RokiEmotion.context(dictation: "preparing", callActive: false, hasError: false), .thinking)
        XCTAssertEqual(RokiEmotion.reply("Не удалось, но спасибо за помощь"), .concerned)
        XCTAssertEqual(RokiEmotion.reply("Встреча в 16:00"), .calm)
    }
    func testMouthEnvelopeFollowsAudioSilenceAndStopsAtPauseAndEnd() throws {
        let rate = 16000
        let samples: [Float] = Array(repeating: 0, count: 320) + Array(repeating: 0.4, count: 320) + Array(repeating: 0, count: 320)
        let clip = try XCTUnwrap(RokiAudioClip.make(samples: samples, rate: rate))
        XCTAssertEqual(clip.level(at: 0, playing: true), 0)
        XCTAssertGreaterThan(clip.level(at: 0.03, playing: true), 0.9)
        XCTAssertEqual(clip.level(at: 0.03, playing: false), 0)
        XCTAssertEqual(clip.level(at: 0.05, playing: true), 0)
        XCTAssertEqual(clip.level(at: clip.duration, playing: true), 0)
        XCTAssertEqual(clip.level(at: .nan, playing: true), 0)
        XCTAssertEqual(clip.wav.prefix(4), Data("RIFF".utf8))
        XCTAssertEqual(clip.wav.count, 44 + samples.count * 2)
    }
    func testPCMValidationAndSanitizing() throws {
        XCTAssertNil(RokiAudioClip.make(samples: [], rate: 16000))
        XCTAssertNil(RokiAudioClip.make(samples: [1], rate: 0))
        let clip = try XCTUnwrap(RokiAudioClip.make(samples: [.nan, .infinity, -2, 2], rate: 16000))
        XCTAssertTrue(clip.levels.allSatisfy { $0.isFinite && (0...1).contains($0) })
    }
    func testRobotTimbrePreservesLengthAndSilenceAndDiffersFromSystem() {
        let samples = (0..<1600).map { Float(sin(Double($0) * 0.08) * 0.5) }
        let robotic = RokiVoiceStyle.robot.process(samples, rate: 16000)
        XCTAssertEqual(robotic.count, samples.count)
        XCTAssertNotEqual(robotic, samples)
        XCTAssertTrue(robotic.allSatisfy { $0.isFinite && abs($0) <= 0.98 })
        XCTAssertEqual(RokiVoiceStyle.system.process(samples, rate: 16000), samples)
        XCTAssertEqual(RokiVoiceStyle.robot.process(Array(repeating: 0, count: 200), rate: 16000), Array(repeating: 0, count: 200))
    }
    @MainActor func testVoiceCannotStartWhileCaptureOwnsAudioAndStopClearsMouth() {
        let voice = RokiVoice()
        voice.canSpeak = { false }
        voice.speak("Это не должно прозвучать")
        XCTAssertFalse(voice.busy)
        XCTAssertNotNil(voice.error)
        voice.stop()
        XCTAssertEqual(voice.mouthLevel, 0)
    }
}
