import Foundation
import simd

enum RokiEmotion: String, CaseIterable, Identifiable {
    case calm, attentive, thinking, happy, concerned
    var id: String { rawValue }
    var title: String {
        switch self {
        case .calm: return "Спокойствие"
        case .attentive: return "Внимание"
        case .thinking: return "Размышление"
        case .happy: return "Радость"
        case .concerned: return "Забота"
        }
    }
    /// Conservative presentation hints for *assistant replies*, never a user emotion diagnosis.
    static func reply(_ text: String) -> Self {
        let lower = text.lowercased()
        if ["ошиб", "не удалось", "сожал", "sorry", "failed", "error"].contains(where: lower.contains) { return .concerned }
        if ["проверю", "подума", "разбер", "checking", "let me think"].contains(where: lower.contains) { return .thinking }
        if ["готово", "рада", "отлично", "спасибо", "привет", "thank", "done", "hello"].contains(where: lower.contains) { return .happy }
        return .calm
    }
    static func context(dictation: String, callActive: Bool, hasError: Bool) -> Self {
        if hasError { return .concerned }
        if ["preparing", "stopping", "undoing", "submitting"].contains(dictation) { return .thinking }
        if dictation == "listening" || callActive { return .attentive }
        return .calm
    }
}

enum RokiGesture: String, CaseIterable, Identifiable {
    case none, wave, nod, shrug
    var id: String { rawValue }
    var title: String {
        switch self { case .none: return "Покой"; case .wave: return "Приветствие"; case .nod: return "Кивок"; case .shrug: return "Плечами" }
    }
}

struct RokiPose {
    var sway = 0.0, head = 0.0, nod = 0.0, arm = 0.0, shoulders = 0.0, skirt = 0.0
    var braidLeft = 0.0, braidRight = 0.0, ripple = 0.0
    static func sample(time: Double, emotion: RokiEmotion, gesture: RokiGesture, gestureTime: Double, reduced: Bool) -> Self {
        guard !reduced else { return Self() }
        let envelope = gestureTime >= 0 && gestureTime < 2.4 ? pow(sin(.pi * gestureTime / 2.4), 2) : 0
        var pose = Self(sway: sin(time * 1.05) * 0.003,
                        head: sin(time * 0.63) * 0.015,
                        nod: sin(time * 1.7) * 0.0012,
                        arm: sin(time * 1.05 + 0.5) * 0.0015,
                        shoulders: 0,
                        skirt: pow(max(0, sin(time * 0.38)), 4) * sin(time * 2.8) * 0.024,
                        braidLeft: sin(time * 1.6) * 0.007,
                        braidRight: sin(time * 1.6 - 0.7) * 0.007,
                        ripple: sin(time * 3.4) * 0.004)
        switch emotion {
        case .calm: break
        case .attentive: pose.head += 0.035
        case .thinking: pose.head -= 0.045
        case .happy: pose.sway *= 1.6; pose.nod += sin(time * 2.3) * 0.002
        case .concerned: pose.head += 0.025; pose.shoulders = 0.003
        }
        switch gesture {
        case .none: break
        case .wave: pose.arm += envelope * (0.042 + sin(gestureTime * 11) * 0.009)
        case .nod: pose.nod += envelope * sin(gestureTime * 8) * 0.009
        case .shrug: pose.shoulders += envelope * 0.018
        }
        return pose
    }
    func blended(toward other: Self, fraction: Double) -> Self {
        let f = min(1, max(0, fraction))
        func mix(_ a: Double, _ b: Double) -> Double { a + (b - a) * f }
        return Self(sway: mix(sway, other.sway), head: mix(head, other.head), nod: mix(nod, other.nod), arm: mix(arm, other.arm), shoulders: mix(shoulders, other.shoulders), skirt: mix(skirt, other.skirt), braidLeft: mix(braidLeft, other.braidLeft), braidRight: mix(braidRight, other.braidRight), ripple: mix(ripple, other.ripple))
    }
    /// Continuous skin deformation of the existing portrait. Feet remain planted.
    /// Coordinates have their origin at the bottom left, as in SpriteKit.
    func map(_ p: SIMD2<Float>) -> SIMD2<Float> {
        let x = Double(p.x), y = Double(p.y)
        func smooth(_ lo: Double, _ hi: Double, _ value: Double) -> Double {
            let t = min(1, max(0, (value - lo) / (hi - lo)))
            return t * t * (3 - 2 * t)
        }
        let upper = smooth(0.10, 0.73, y)
        let headWeight = smooth(0.75, 0.86, y)
        let dx = x - 0.51, dy = (y - 0.78) * 1.9075
        let hx = (dx * cos(head) - dy * sin(head) - dx) * headWeight
        let hy = (dx * sin(head) + dy * cos(head) - dy) / 1.9075 * headWeight
        let armWeight = smooth(0.63, 0.82, x) * smooth(0.29, 0.40, y) * (1 - smooth(0.64, 0.76, y))
        let shoulderWeight = smooth(0.17, 0.30, abs(x - 0.5)) * smooth(0.30, 0.48, y) * (1 - smooth(0.72, 0.80, y))
        let skirtWeight = smooth(0.37, 0.41, y) * (1 - smooth(0.42, 0.59, y)) * (1 - smooth(0.28, 0.37, abs(x - 0.50)))
        let braidTip = smooth(0.74, 0.78, y) * (1 - smooth(0.78, 0.965, y))
        let left = (1 - smooth(0.28, 0.37, x)) * smooth(0.08, 0.15, x) * braidTip
        let right = smooth(0.64, 0.72, x) * (1 - smooth(0.88, 0.94, x)) * braidTip
        let hair = braidLeft * left + braidRight * right
        return SIMD2(Float(x + sway * upper + hx + arm * armWeight + skirt * skirtWeight + hair),
                     Float(y + hy + nod * headWeight + arm * armWeight * 0.70 + shoulders * shoulderWeight + ripple * skirtWeight * sin(x * 22)))
    }
}

struct RokiSpring {
    var value = 0.0, velocity = 0.0
    mutating func advance(target: Double, delta: Double) -> Double {
        let dt = min(0.05, max(0, delta))
        velocity += ((target - value) * 32 - velocity * 7) * dt
        value += velocity * dt
        return value
    }
}

struct RokiAudioClip {
    let wav: Data
    let levels: [Float]
    let duration: Double
    static let interval = 0.02
    func level(at seconds: Double, playing: Bool) -> Float {
        guard playing, seconds.isFinite, seconds >= 0, seconds < duration, !levels.isEmpty else { return 0 }
        return levels[min(levels.count - 1, Int(seconds / Self.interval))]
    }
    static func make(samples: [Float], rate: Int) -> Self? {
        guard (8000...96000).contains(rate), !samples.isEmpty, samples.count <= rate * 60 else { return nil }
        let clean = samples.map { $0.isFinite ? min(1, max(-1, $0)) : 0 }
        let hop = max(1, Int(Double(rate) * interval))
        var rms: [Float] = []
        for start in stride(from: 0, to: clean.count, by: hop) {
            let end = min(start + hop, clean.count)
            let energy = clean[start..<end].reduce(Float(0)) { $0 + $1 * $1 }
            rms.append(sqrt(energy / Float(end - start)))
        }
        let peak = max(0.015, rms.max() ?? 0)
        let levels = rms.map { $0 < 0.003 ? Float(0) : min(1, sqrt($0 / peak)) }
        var data = Data()
        func ascii(_ s: String) { data.append(contentsOf: s.utf8) }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        ascii("RIFF"); u32(UInt32(36 + clean.count * 2)); ascii("WAVEfmt "); u32(16); u16(1); u16(1)
        u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16); ascii("data"); u32(UInt32(clean.count * 2))
        for value in clean { u16(UInt16(bitPattern: Int16(value * 32767))) }
        return Self(wav: data, levels: levels, duration: Double(clean.count) / Double(rate))
    }
}
