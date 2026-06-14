// Native video exporter for Studio's video editor.
//
// Reads a resolved edit spec (JSON, path passed as argv[1]) and renders an
// H.264 MP4 to `output`: clips are trimmed + concatenated via an
// AVMutableComposition, scaled/letterboxed into the preset render size, and the
// text/caption layers are baked in as animated Core Animation layers via
// AVVideoCompositionCoreAnimationTool.
//
// Progress is printed as `PROGRESS <0..1>` lines; the final line is
// `DONE <path>` or `ERROR <message>`. See docs/video-plan.md.

import AVFoundation
import AppKit
import ImageIO
import QuartzCore

// ── Spec ────────────────────────────────────────────────────────────────────
struct Spec: Decodable {
    let output: String
    let width: Int
    let height: Int
    let fit: String?  // "contain" (letterbox, default) | "cover" (crop to fill)
    let clips: [Clip]
    let text: [Layer]
}
struct Clip: Decodable {
    let src: String
    let `in`: Double
    let out: Double
    let rotate: Double?  // extra clockwise rotation in degrees (0/90/180/270)
}
// A caption: a pre-rendered PNG (data URL, rendered by the frontend at output
// resolution) plus geometry + animation. Text/color/font all live in the image.
struct Layer: Decodable {
    let image: String        // "data:image/png;base64,…"
    let w: Double            // image logical size, output px
    let h: Double
    let x: Double?           // normalized center, y measured from top
    let y: Double?
    let start: Double
    let end: Double
    let anim: String?
    let from: String?
    let edges: [Double]?     // word-boundary x-fractions for "words" reveal
}

func fail(_ msg: String) -> Never {
    print("ERROR \(msg)")
    exit(1)
}

// Decode a "data:image/png;base64,…" URL into a CGImage.
func decodeDataURL(_ s: String) -> CGImage? {
    guard let comma = s.firstIndex(of: ",") else { return nil }
    let b64 = String(s[s.index(after: comma)...])
    guard let data = Data(base64Encoded: b64),
        let src = CGImageSourceCreateWithData(data as CFData, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { return nil }
    return img
}

// ── Read spec ────────────────────────────────────────────────────────────────
guard CommandLine.arguments.count >= 2 else { fail("usage: vidExport <spec.json>") }
guard let specData = FileManager.default.contents(atPath: CommandLine.arguments[1]) else {
    fail("cannot read spec")
}
let spec: Spec
do { spec = try JSONDecoder().decode(Spec.self, from: specData) }
catch { fail("bad spec: \(error)") }

let renderSize = CGSize(width: spec.width, height: spec.height)
if spec.clips.isEmpty { fail("no clips") }

// ── Build composition ────────────────────────────────────────────────────────
let composition = AVMutableComposition()
guard
    let vTrack = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
    let aTrack = composition.addMutableTrack(
        withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
else { fail("cannot create tracks") }

var instructions: [AVMutableVideoCompositionInstruction] = []
var cursor = CMTime.zero
let scale: CMTimeScale = 600

for clip in spec.clips {
    let asset = AVURLAsset(url: URL(fileURLWithPath: clip.src))
    guard let srcV = asset.tracks(withMediaType: .video).first else {
        fail("no video track in \(clip.src)")
    }
    let start = CMTime(seconds: clip.in, preferredTimescale: scale)
    let end = CMTime(seconds: clip.out, preferredTimescale: scale)
    let range = CMTimeRange(start: start, end: end)

    do {
        try vTrack.insertTimeRange(range, of: srcV, at: cursor)
        if let srcA = asset.tracks(withMediaType: .audio).first {
            try aTrack.insertTimeRange(range, of: srcA, at: cursor)
        }
    } catch { fail("insert failed: \(error)") }

    // Build the source→render transform: preferred orientation, then the user's
    // extra rotation, then fit (contain/cover) and center into the render frame.
    let pf = srcV.preferredTransform
    let natural = srcV.naturalSize
    let theta = (clip.rotate ?? 0) * .pi / 180
    let base = pf.concatenating(CGAffineTransform(rotationAngle: theta))
    let oriented = CGRect(origin: .zero, size: natural).applying(base)
    let s = spec.fit == "cover"
        ? max(renderSize.width / oriented.width, renderSize.height / oriented.height)
        : min(renderSize.width / oriented.width, renderSize.height / oriented.height)
    let scaled = base.concatenating(CGAffineTransform(scaleX: s, y: s))
    let placed = CGRect(origin: .zero, size: natural).applying(scaled)
    let tx = (renderSize.width - placed.width) / 2 - placed.minX
    let ty = (renderSize.height - placed.height) / 2 - placed.minY
    let transform = scaled.concatenating(CGAffineTransform(translationX: tx, y: ty))

    let layerInstr = AVMutableVideoCompositionLayerInstruction(assetTrack: vTrack)
    layerInstr.setTransform(transform, at: cursor)

    let instr = AVMutableVideoCompositionInstruction()
    instr.timeRange = CMTimeRange(start: cursor, duration: range.duration)
    instr.layerInstructions = [layerInstr]
    instructions.append(instr)

    cursor = cursor + range.duration
}
let totalDur = cursor

// ── Caption / title overlay layers ───────────────────────────────────────────
let parentLayer = CALayer()
parentLayer.frame = CGRect(origin: .zero, size: renderSize)
let videoLayer = CALayer()
videoLayer.frame = CGRect(origin: .zero, size: renderSize)
parentLayer.addSublayer(videoLayer)

// Core Animation's video timeline treats beginTime 0 specially.
func beginTime(_ t: Double) -> CFTimeInterval { t <= 0 ? AVCoreAnimationBeginTimeAtZero : t }

// Composition length; animations span this and place their window via keyTimes.
let T = max(0.001, totalDur.seconds)
func frac(_ t: Double) -> Double { max(0, min(1, t / T)) }

// Force keyTimes strictly increasing in [0,1] (CAKeyframeAnimation requires it).
func sanitize(_ times: [Double], _ values: [Double]) -> ([NSNumber], [NSNumber]) {
    var t = times
    for i in 1..<t.count where t[i] <= t[i - 1] {
        t[i] = min(1, t[i - 1] + 1e-4)
    }
    return (t.map { NSNumber(value: $0) }, values.map { NSNumber(value: $0) })
}

for l in spec.text {
    guard let img = decodeDataURL(l.image) else { continue }
    let dur = max(0.05, l.end - l.start)
    let contW = CGFloat(l.w)
    let contH = CGFloat(l.h)

    // Container holds the caption image; animations apply here / to the image.
    let container = CALayer()
    container.bounds = CGRect(x: 0, y: 0, width: contW, height: contH)
    // Normalized x,y are center-anchored, y measured from the TOP (matches the
    // editor preview); Core Animation's origin is bottom-left.
    let cx = (l.x ?? 0.5) * renderSize.width
    let cy = (1 - (l.y ?? 0.85)) * renderSize.height
    container.position = CGPoint(x: cx, y: cy)

    let textLayer = CALayer()
    textLayer.contents = img
    textLayer.frame = CGRect(x: 0, y: 0, width: contW, height: contH)
    let imgW = contW
    let imgH = contH
    container.addSublayer(textLayer)

    let anim = l.anim ?? "none"
    let into = min(0.4, dur / 3)
    container.opacity = 0  // hidden until the spanning animation reveals it

    // All animations span the WHOLE composition (begin at zero, duration = T)
    // with keyTimes placing the visible window. The Core Animation tool's
    // offline renderer doesn't reliably honor a future beginTime + backwards
    // fill, so a single full-length keyframe track is the robust approach.
    let s = frac(l.start)
    let e = frac(l.end)

    // Opacity envelope: 0 → 1 (in) → 1 → 0 (out), 0 elsewhere.
    let onAt = (anim == "fade" || anim == "slide") ? frac(l.start + into) : s + 1e-4
    let offAt = (anim == "fade") ? frac(l.end - into) : e - 1e-4
    let (oTimes, oVals) = sanitize([0, s, onAt, offAt, e, 1], [0, 0, 1, 1, 0, 0])
    let op = CAKeyframeAnimation(keyPath: "opacity")
    op.duration = T
    op.beginTime = AVCoreAnimationBeginTimeAtZero
    op.keyTimes = oTimes
    op.values = oVals
    op.isRemovedOnCompletion = false
    op.fillMode = .forwards
    container.add(op, forKey: "opacity")

    if anim == "slide" {
        let off: CGFloat = renderSize.height * 0.03
        let from = l.from ?? "bottom"
        var dx: CGFloat = 0, dy: CGFloat = 0
        switch from {
        case "left": dx = -off
        case "right": dx = off
        case "top": dy = off      // CA y is bottom-up: "top" starts higher → +y
        default: dy = -off        // bottom
        }
        let fromP = NSValue(point: CGPoint(x: cx + dx, y: cy + dy))
        let toP = NSValue(point: CGPoint(x: cx, y: cy))
        let (pTimes, _) = sanitize([0, s, frac(l.start + into), 1], [0, 0, 0, 0])
        let pos = CAKeyframeAnimation(keyPath: "position")
        pos.duration = T
        pos.beginTime = AVCoreAnimationBeginTimeAtZero
        pos.keyTimes = pTimes
        pos.values = [fromP, fromP, toP, toP]
        pos.isRemovedOnCompletion = false
        pos.fillMode = .forwards
        container.add(pos, forKey: "position")
    } else if anim == "words" || anim == "typewriter" {
        // Reveal left-to-right by clipping the image layer itself (left-anchored,
        // masksToBounds, growing its own bounds.width). Animating the layer's
        // own bounds is honored offline; animating a .mask sublayer is not.
        let leftX = (contW - imgW) / 2
        textLayer.anchorPoint = CGPoint(x: 0, y: 0.5)
        textLayer.position = CGPoint(x: leftX, y: contH / 2)
        textLayer.bounds = CGRect(x: 0, y: 0, width: 0, height: imgH)
        textLayer.masksToBounds = true
        textLayer.contentsGravity = .left

        let reveal = CAKeyframeAnimation(keyPath: "bounds.size.width")
        reveal.duration = T
        reveal.beginTime = AVCoreAnimationBeginTimeAtZero
        reveal.isRemovedOnCompletion = false
        reveal.fillMode = .forwards
        if anim == "typewriter" {
            let (rt, rv) = sanitize([0, s, e, 1], [0, 0, Double(imgW), Double(imgW)])
            reveal.keyTimes = rt
            reveal.values = rv
        } else {
            // Step at each word boundary (x-fractions from the frontend), so the
            // reveal lands exactly on word edges as in the preview.
            let edges = l.edges ?? [1]
            let n = edges.count
            var times: [Double] = [0, s]
            var widths: [Double] = [0, 0]
            for i in 0..<n {
                times.append(frac(l.start + (l.end - l.start) * Double(i + 1) / Double(n)))
                widths.append(Double(imgW) * edges[i])
            }
            times.append(1)
            widths.append(widths.last ?? 0)
            let (rt, rv) = sanitize(times, widths)
            reveal.keyTimes = rt
            reveal.values = rv
            reveal.calculationMode = .discrete
        }
        textLayer.add(reveal, forKey: "reveal")
    }

    parentLayer.addSublayer(container)
}

// ── Video composition ────────────────────────────────────────────────────────
let videoComposition = AVMutableVideoComposition()
videoComposition.renderSize = renderSize
videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
videoComposition.instructions = instructions
videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
    postProcessingAsVideoLayer: videoLayer, in: parentLayer)

// ── Export ────────────────────────────────────────────────────────────────────
let outURL = URL(fileURLWithPath: spec.output)
try? FileManager.default.removeItem(at: outURL)

guard
    let export = AVAssetExportSession(
        asset: composition, presetName: AVAssetExportPresetHighestQuality)
else { fail("cannot create export session") }
export.outputURL = outURL
export.outputFileType = .mp4
export.videoComposition = videoComposition
export.timeRange = CMTimeRange(start: .zero, duration: totalDur)

let sem = DispatchSemaphore(value: 0)
let timer = DispatchSource.makeTimerSource(queue: .global())
timer.schedule(deadline: .now(), repeating: .milliseconds(200))
timer.setEventHandler {
    print("PROGRESS \(export.progress)")
    fflush(stdout)
}
timer.resume()

export.exportAsynchronously {
    timer.cancel()
    switch export.status {
    case .completed:
        print("PROGRESS 1.0")
        print("DONE \(spec.output)")
    case .failed:
        print("ERROR \(export.error?.localizedDescription ?? "export failed")")
    case .cancelled:
        print("ERROR cancelled")
    default:
        print("ERROR unexpected status \(export.status.rawValue)")
    }
    fflush(stdout)
    sem.signal()
}
sem.wait()
