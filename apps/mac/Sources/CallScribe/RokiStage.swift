import AppKit
import SpriteKit
import SwiftUI

/// Local 2D skin rig. It deforms the approved portrait, without generating video frames.
struct RokiStage: NSViewRepresentable {
    var voice: RokiVoice
    var emotion: RokiEmotion
    var gesture: RokiGesture
    var gestureID: Int
    var reduced: Bool
    var followPointer: Bool

    func makeNSView(context: Context) -> SKView {
        let view = SKView()
        view.allowsTransparency = true; view.preferredFramesPerSecond = 30
        view.ignoresSiblingOrder = false
        let scene = RokiScene(size: CGSize(width: 220, height: 400))
        scene.scaleMode = .aspectFit; scene.backgroundColor = .clear
        view.presentScene(scene)
        return view
    }
    func updateNSView(_ view: SKView, context: Context) {
        guard let scene = view.scene as? RokiScene else { return }
        scene.voice = voice; scene.emotion = emotion
        scene.reduced = reduced; scene.followPointer = followPointer
        if scene.gestureID != gestureID {
            scene.gestureID = gestureID; scene.gesture = gesture; scene.gestureStart = nil
        }
        scene.isPaused = reduced && !voice.speaking
        if scene.isPaused { scene.drawRest() }
    }
    static func dismantleNSView(_ view: SKView, coordinator: ()) { view.presentScene(nil) }
}

private final class RokiScene: SKScene {
    weak var voice: RokiVoice?
    var emotion: RokiEmotion = .calm
    var gesture: RokiGesture = .none
    var gestureID = 0
    var gestureStart: TimeInterval?
    var reduced = false, followPointer = true
    private let rig = SKNode()
    private let body = SKSpriteNode()
    private let mouth = SKNode(), eye = SKNode()
    private let mouthSprite = SKSpriteNode(), eyeSprite = SKSpriteNode()
    private var previousMouthKey = "", previousEyeKey = ""
    private var pose = RokiPose(), leftSpring = RokiSpring(), rightSpring = RokiSpring()
    private var previousTime = 0.0, origin: Double?
    private var nextBlink = 2.8, blinkStart = -10.0
    private var nextGaze = 2.0, gazeUntil = 0.0
    private var gaze = CGPoint.zero, targetGaze = CGPoint.zero
    private var level = 0.0
    private let portraitSize = CGSize(width: 194, height: 370)
    private let grid = SKWarpGeometryGrid(columns: 22, rows: 38)

    override func didMove(to view: SKView) {
        guard rig.parent == nil else { return }
        addChild(rig); rig.position = CGPoint(x: size.width / 2, y: size.height / 2)
        if let url = Bundle.main.url(forResource: "roki-assistant", withExtension: "png"), let image = NSImage(contentsOf: url) {
            body.texture = SKTexture(image: image); body.texture?.filteringMode = .linear
        }
        body.size = portraitSize; body.zPosition = 0; body.warpGeometry = grid
        // Outline follows alpha and the deformation, including both braids and moving hem.
        body.shader = SKShader(source: """
        void main() {
            vec2 p = v_tex_coord;
            vec2 d = vec2(0.0077, 0.0041);
            vec4 c = texture2D(u_texture, p);
            float a = 0.0;
            a = max(a, texture2D(u_texture, p + vec2(d.x,0.0)).a);
            a = max(a, texture2D(u_texture, p - vec2(d.x,0.0)).a);
            a = max(a, texture2D(u_texture, p + vec2(0.0,d.y)).a);
            a = max(a, texture2D(u_texture, p - vec2(0.0,d.y)).a);
            a = max(a, texture2D(u_texture, p + d).a);
            a = max(a, texture2D(u_texture, p - d).a);
            a = max(a, texture2D(u_texture, p + vec2(d.x,-d.y)).a);
            a = max(a, texture2D(u_texture, p + vec2(-d.x,d.y)).a);
            float edge = a * (1.0 - c.a) * 0.93;
            gl_FragColor = vec4(c.rgb + vec3(0.88,0.95,1.0) * edge, c.a + edge);
        }
        """)
        rig.addChild(body)
        mouth.zPosition = 3; eye.zPosition = 3
        rig.addChild(mouth); rig.addChild(eye)
        mouthSprite.size = CGSize(width: 22, height: 18)
        eyeSprite.size = CGSize(width: 25, height: 29)
        mouth.addChild(mouthSprite); eye.addChild(eyeSprite)
        drawRest()
    }
    func drawRest() {
        pose = RokiPose(); body.warpGeometry = grid; gaze = .zero; level = 0
        drawFace(blink: 0, mouthLevel: 0)
    }
    override func update(_ currentTime: TimeInterval) {
        if origin == nil { origin = currentTime }
        let t = currentTime - (origin ?? currentTime)
        let dt = previousTime == 0 ? 1.0 / 30 : min(0.05, max(0, currentTime - previousTime))
        previousTime = currentTime
        if gestureStart == nil { gestureStart = currentTime }
        var target = RokiPose.sample(time: t, emotion: emotion, gesture: gesture, gestureTime: currentTime - (gestureStart ?? currentTime), reduced: reduced)
        if !reduced && followPointer {
            if t >= nextGaze {
                // Position only: no screen capture, OCR, accessibility reads, or event tap.
                if let window = view?.window {
                    let mouse = NSEvent.mouseLocation
                    let frame = window.frame
                    targetGaze = CGPoint(x: max(-1, min(1, (mouse.x - frame.midX) / 550)),
                                         y: max(-1, min(1, (mouse.y - frame.midY) / 450)))
                }
                gazeUntil = t + Double.random(in: 1.3...2.4)
                nextGaze = t + Double.random(in: 4.5...8)
            }
            if t > gazeUntil { targetGaze = .zero }
        } else { targetGaze = .zero }
        gaze.x += (targetGaze.x - gaze.x) * min(1, dt * 5)
        gaze.y += (targetGaze.y - gaze.y) * min(1, dt * 5)
        target.head -= Double(gaze.x) * 0.045
        target.braidLeft += leftSpring.advance(target: -target.head * 0.32 - target.sway * 2, delta: dt)
        target.braidRight += rightSpring.advance(target: -target.head * 0.30 - target.sway * 2, delta: dt * 0.9)
        pose = reduced ? RokiPose() : pose.blended(toward: target, fraction: dt * 8)
        let positions = (0..<grid.vertexCount).map { pose.map(grid.sourcePosition(at: $0)) }
        body.warpGeometry = grid.replacingByDestinationPositions(positions: positions)
        if !reduced && t >= nextBlink {
            blinkStart = t
            nextBlink = t + (Bool.random() && Int(t) % 3 == 0 ? 0.30 : Double.random(in: 2.8...6.7))
        }
        let phase = t - blinkStart
        let blink = !reduced && phase >= 0 && phase < 0.20 ? sin(.pi * phase / 0.20) : 0
        let incoming = Double(voice?.mouthLevel ?? 0)
        level += (incoming - level) * min(1, dt * (incoming > level ? 24 : 18))
        if voice?.speaking != true { level = 0 }
        drawFace(blink: blink, mouthLevel: level)
    }
    private func point(_ x: Float, _ y: Float) -> CGPoint {
        let p = pose.map(SIMD2(x, y))
        return CGPoint(x: (Double(p.x) - 0.5) * portraitSize.width, y: (Double(p.y) - 0.5) * portraitSize.height)
    }
    private func texture(width: Int, height: Int, draw: (CGContext) -> Void) -> SKTexture? {
        let scale = 4
        guard let context = CGContext(data: nil, width: width * scale, height: height * scale,
            bitsPerComponent: 8, bytesPerRow: width * scale * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
        context.translateBy(x: CGFloat(width) / 2, y: CGFloat(height) / 2)
        draw(context)
        return context.makeImage().map(SKTexture.init(cgImage:))
    }
    private func drawFace(blink: Double, mouthLevel: Double) {
        mouth.position = point(0.513, 0.827); mouth.zRotation = pose.head
        eye.position = point(0.513, 0.900); eye.zRotation = pose.head
        let mouthKey = "\(emotion.rawValue):\(Int(mouthLevel * 24))"
        if mouthKey != previousMouthKey {
            previousMouthKey = mouthKey
            mouthSprite.texture = texture(width: 22, height: 18) { context in
                context.setFillColor(CGColor(gray: 0.025, alpha: 1))
                context.fill(CGRect(x: -9.5, y: -7, width: 19, height: 14))
                let smile: Double = emotion == .happy ? 2.5 : emotion == .concerned ? -0.8 : 1.0
                let width: Double = emotion == .happy ? 8 : 7
                let height = 0.8 + mouthLevel * 6
                context.move(to: CGPoint(x: -width, y: smile))
                context.addCurve(to: CGPoint(x: width, y: smile), control1: CGPoint(x: -3, y: 3), control2: CGPoint(x: 3, y: 3))
                context.addQuadCurve(to: CGPoint(x: -width, y: smile), control: CGPoint(x: 0, y: -height - 3))
                context.closePath(); context.setFillColor(CGColor(red: 0.87, green: 0.045, blue: 0.10, alpha: 1)); context.fillPath()
                context.move(to: CGPoint(x: -width + 1.6, y: smile - 0.2))
                context.addQuadCurve(to: CGPoint(x: width - 1.6, y: smile - 0.2), control: CGPoint(x: 0, y: 1.6))
                context.addQuadCurve(to: CGPoint(x: -width + 1.6, y: smile - 0.2), control: CGPoint(x: 0, y: -height - 0.7))
                context.closePath(); context.setFillColor(CGColor(gray: 0.015, alpha: 1)); context.fillPath()
                context.setFillColor(CGColor(gray: 0.96, alpha: 1))
                context.fill(CGRect(x: -4.7, y: smile - 1, width: 9.4, height: 1.1))
            }
        }
        let eyeKey = "\(emotion.rawValue):\(Int(blink * 16)):\(Int(gaze.x * 12)):\(Int(gaze.y * 12))"
        if eyeKey != previousEyeKey {
            previousEyeKey = eyeKey
            eyeSprite.texture = texture(width: 25, height: 29) { context in
                context.setFillColor(CGColor(gray: 0.025, alpha: 1))
                context.fillEllipse(in: CGRect(x: -8.5, y: -8.5, width: 17, height: 17))
                context.setStrokeColor(CGColor(gray: 0.3, alpha: 1)); context.setLineWidth(0.6)
                context.strokeEllipse(in: CGRect(x: -8.5, y: -8.5, width: 17, height: 17))
                let iris = CGRect(x: -6 + gaze.x * 2, y: -6 + gaze.y * 1.7, width: 12, height: 12)
                context.setFillColor(CGColor(red: 0.025, green: 0.055, blue: 0.075, alpha: 1)); context.fillEllipse(in: iris)
                context.setStrokeColor(CGColor(red: 0.22, green: 0.47, blue: 0.52, alpha: 1)); context.strokeEllipse(in: iris)
                context.setFillColor(CGColor(gray: 1, alpha: 0.9))
                context.fillEllipse(in: CGRect(x: iris.midX - 3.5, y: iris.midY + 1.2, width: 3.5, height: 3.5))
                context.saveGState(); context.addEllipse(in: CGRect(x: -8.5, y: -8.5, width: 17, height: 17)); context.clip()
                let relaxed = emotion == .thinking ? 0.22 : emotion == .concerned ? 0.12 : 0
                let closure = max(blink, relaxed)
                context.setFillColor(CGColor(gray: 0.13, alpha: 1))
                context.fill(CGRect(x: -9, y: 8.5 - 17 * closure, width: 18, height: 17 * closure))
                context.restoreGState()
                let tilt: Double = emotion == .concerned ? 2.4 : emotion == .thinking ? -1.6 : 0
                context.move(to: CGPoint(x: -8, y: 10 - tilt))
                context.addQuadCurve(to: CGPoint(x: 8, y: 10 + tilt), control: CGPoint(x: 0, y: emotion == .happy ? 14 : 12))
                context.setStrokeColor(CGColor(gray: 0.55, alpha: 1)); context.setLineWidth(1.1); context.strokePath()
            }
        }
    }
}
