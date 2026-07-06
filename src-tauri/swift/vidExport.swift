// Native video exporter for Studio's video editor.
//
// Reads a resolved edit spec (JSON, path passed as argv[1]) and renders an
// H.264 MP4 to `output`. Video clips are trimmed + concatenated via an
// AVMutableComposition (shader "gap" segments become empty time ranges), then
// the frames are pulled through an AVAssetReader and each one is composited
// with the matching overlay PNG from `framesDir` — text animations and shader
// backgrounds pre-rendered at output resolution by the editor webview
// (src/video/effects.js + shaders.js), so export is pixel-identical to the
// preview. Frames the reader doesn't produce (gap segments, trailing shader
// clips) are synthesized black + overlay.
//
// Overlay frames are named f%06d.png at `fps`; a missing index means "fully
// transparent". Progress is printed as `PROGRESS <0..1>` lines; the final
// line is `DONE <path>` or `ERROR <message>`. See docs/video.md.

import AVFoundation
import AppKit
import ImageIO

// ── Spec ────────────────────────────────────────────────────────────────────
struct Spec: Decodable {
    let output: String
    let width: Int
    let height: Int
    let fit: String?  // "contain" (letterbox, default) | "cover" (crop to fill)
    let fps: Int?
    let framesDir: String?
    let clips: [Clip]
}
struct Clip: Decodable {
    let kind: String?  // "video" (default) | "gap" (shader segment)
    let src: String?
    let `in`: Double?
    let out: Double?
    let rotate: Double?  // extra clockwise rotation in degrees (0/90/180/270)
    let dur: Double?  // gap duration
}

func fail(_ msg: String) -> Never {
    print("ERROR \(msg)")
    exit(1)
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
let fps = spec.fps ?? 30
let frameDur = 1.0 / Double(fps)
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
var hasVideo = false
var hasAudio = false

for clip in spec.clips {
    if clip.kind == "gap" {
        // Shader segment: the overlay PNGs carry the pixels; the composition
        // just reserves the time (black video, silent audio).
        let d = CMTime(seconds: max(0.1, clip.dur ?? 5), preferredTimescale: scale)
        let range = CMTimeRange(start: cursor, duration: d)
        vTrack.insertEmptyTimeRange(range)
        aTrack.insertEmptyTimeRange(range)
        let instr = AVMutableVideoCompositionInstruction()
        instr.timeRange = range
        instr.layerInstructions = []  // renders the background (black)
        instructions.append(instr)
        cursor = cursor + d
        continue
    }

    guard let src = clip.src else { fail("video clip without src") }
    let asset = AVURLAsset(url: URL(fileURLWithPath: src))
    guard let srcV = asset.tracks(withMediaType: .video).first else {
        fail("no video track in \(src)")
    }
    let start = CMTime(seconds: clip.in ?? 0, preferredTimescale: scale)
    let end = CMTime(seconds: clip.out ?? 0, preferredTimescale: scale)
    let range = CMTimeRange(start: start, end: end)

    do {
        try vTrack.insertTimeRange(range, of: srcV, at: cursor)
        if let srcA = asset.tracks(withMediaType: .audio).first {
            try aTrack.insertTimeRange(range, of: srcA, at: cursor)
            hasAudio = true
        } else {
            aTrack.insertEmptyTimeRange(CMTimeRange(start: cursor, duration: range.duration))
        }
    } catch { fail("insert failed: \(error)") }
    hasVideo = true

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
let totalSecs = totalDur.seconds
let totalFrames = max(1, Int(ceil(totalSecs * Double(fps))))

let videoComposition = AVMutableVideoComposition()
videoComposition.renderSize = renderSize
videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))
videoComposition.instructions = instructions

// ── Overlay frames (rendered by the editor webview) ─────────────────────────
func overlayImage(_ idx: Int) -> CGImage? {
    guard let dir = spec.framesDir else { return nil }
    let path = String(format: "%@/f%06d.png", dir, idx)
    guard FileManager.default.fileExists(atPath: path),
        let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { return nil }
    return img
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let bitmapInfo =
    CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

// CGContext over a locked BGRA pixel buffer. A full-frame draw lands
// right-side up (buffer row 0 = top scanline = CG y = height).
func context(for pb: CVPixelBuffer) -> CGContext? {
    CGContext(
        data: CVPixelBufferGetBaseAddress(pb),
        width: CVPixelBufferGetWidth(pb),
        height: CVPixelBufferGetHeight(pb),
        bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
        space: sRGB,
        bitmapInfo: bitmapInfo)
}

// Draw the overlay for time `t` (a frame midpoint) onto a pixel buffer in
// place. floor(midpoint × fps) recovers the frame index exactly.
func composite(_ pb: CVPixelBuffer, t: Double) {
    let idx = Int((t * Double(fps)).rounded(.down))
    guard let img = overlayImage(idx) else { return }
    CVPixelBufferLockBaseAddress(pb, [])
    defer { CVPixelBufferUnlockBaseAddress(pb, []) }
    guard let ctx = context(for: pb) else { return }
    ctx.draw(img, in: CGRect(origin: .zero, size: renderSize))
}

// ── Reader + writer ──────────────────────────────────────────────────────────
if !hasAudio { composition.removeTrack(aTrack) }

let outURL = URL(fileURLWithPath: spec.output)
try? FileManager.default.removeItem(at: outURL)

let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4) }
catch { fail("cannot create writer: \(error)") }

let videoInput = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: spec.width,
        AVVideoHeightKey: spec.height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: max(4_000_000, spec.width * spec.height * 4)
        ],
    ])
videoInput.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: videoInput,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: spec.width,
        kCVPixelBufferHeightKey as String: spec.height,
    ])
writer.add(videoInput)

var audioInput: AVAssetWriterInput?
if hasAudio {
    let ai = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 160_000,
        ])
    ai.expectsMediaDataInRealTime = false
    writer.add(ai)
    audioInput = ai
}

var reader: AVAssetReader?
var videoOutput: AVAssetReaderVideoCompositionOutput?
var audioOutput: AVAssetReaderAudioMixOutput?
if hasVideo {
    do {
        let r = try AVAssetReader(asset: composition)
        let vo = AVAssetReaderVideoCompositionOutput(
            videoTracks: composition.tracks(withMediaType: .video),
            videoSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ])
        vo.videoComposition = videoComposition
        vo.alwaysCopiesSampleData = false
        guard r.canAdd(vo) else { fail("cannot add video output") }
        r.add(vo)
        if hasAudio {
            let ao = AVAssetReaderAudioMixOutput(
                audioTracks: composition.tracks(withMediaType: .audio),
                audioSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
            guard r.canAdd(ao) else { fail("cannot add audio output") }
            r.add(ao)
            audioOutput = ao
        }
        reader = r
        videoOutput = vo
    } catch { fail("cannot create reader: \(error)") }
}

guard writer.startWriting() else {
    fail("writer failed: \(writer.error?.localizedDescription ?? "unknown")")
}
if let r = reader, !r.startReading() {
    fail("reader failed: \(r.error?.localizedDescription ?? "unknown")")
}
writer.startSession(atSourceTime: .zero)

func waitReady(_ input: AVAssetWriterInput) {
    while !input.isReadyForMoreMediaData {
        if writer.status == .failed { fail(writer.error?.localizedDescription ?? "write failed") }
        Thread.sleep(forTimeInterval: 0.005)
    }
}

var appended = 0
func reportProgress() {
    if appended % 15 == 0 || appended >= totalFrames {
        print("PROGRESS \(min(1.0, Double(appended) / Double(totalFrames)))")
        fflush(stdout)
    }
}

// Generate black+overlay frames for time ranges the reader doesn't produce
// (gap segments and trailing shader clips — empty ranges yield no samples).
var nextPTS = 0.0
func synthesize(upTo end: Double) {
    while nextPTS < end - frameDur * 0.5 {
        waitReady(videoInput)
        guard let pool = adaptor.pixelBufferPool else { return }
        var pbOpt: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pbOpt)
        guard let pb = pbOpt else { return }
        CVPixelBufferLockBaseAddress(pb, [])
        if let ctx = context(for: pb) {
            ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
            ctx.fill(CGRect(origin: .zero, size: renderSize))
            let idx = Int(((nextPTS + frameDur * 0.5) * Double(fps)).rounded(.down))
            if let img = overlayImage(idx) {
                ctx.draw(img, in: CGRect(origin: .zero, size: renderSize))
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        if !adaptor.append(pb, withPresentationTime: CMTime(seconds: nextPTS, preferredTimescale: scale)) {
            fail(writer.error?.localizedDescription ?? "append failed")
        }
        appended += 1
        reportProgress()
        nextPTS += frameDur
    }
}

let group = DispatchGroup()

group.enter()
DispatchQueue(label: "video").async {
    if let vo = videoOutput {
        while let sb = vo.copyNextSampleBuffer() {
            let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds
            synthesize(upTo: pts)  // fill any gap the reader skipped
            waitReady(videoInput)
            if let pb = CMSampleBufferGetImageBuffer(sb) {
                composite(pb, t: pts + frameDur * 0.5)
            }
            if !videoInput.append(sb) {
                fail(writer.error?.localizedDescription ?? "append failed")
            }
            appended += 1
            reportProgress()
            nextPTS = pts + frameDur
        }
        if reader?.status == .failed {
            fail(reader?.error?.localizedDescription ?? "read failed")
        }
    }
    synthesize(upTo: totalSecs)  // trailing gap / all-shader edit
    videoInput.markAsFinished()
    group.leave()
}

if let ao = audioOutput, let ai = audioInput {
    group.enter()
    DispatchQueue(label: "audio").async {
        while let sb = ao.copyNextSampleBuffer() {
            waitReady(ai)
            if !ai.append(sb) { break }
        }
        ai.markAsFinished()
        group.leave()
    }
} else {
    audioInput?.markAsFinished()
}

group.wait()

let sem = DispatchSemaphore(value: 0)
writer.finishWriting {
    sem.signal()
}
sem.wait()

if writer.status == .completed {
    print("PROGRESS 1.0")
    print("DONE \(spec.output)")
} else {
    print("ERROR \(writer.error?.localizedDescription ?? "export failed")")
}
fflush(stdout)
