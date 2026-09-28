// screenrec x y w h out.mov — records one rect of the screen to an H.264 .mov
// with ScreenCaptureKit until SIGINT/SIGTERM (or until Studio, the parent,
// goes away). The rect is in global points, top-left origin — the same space
// as AppleScript window bounds. Studio's own windows are left out of the
// capture. Prints "recording" once frames are flowing, and the output path on
// a clean finish; errors go to stderr with a non-zero exit.
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count == 6,
      let x = Double(args[1]), let y = Double(args[2]),
      let w = Double(args[3]), let h = Double(args[4]), w > 0, h > 0
else { fail("usage: screenrec x y w h out.mov") }
let rect = CGRect(x: x, y: y, width: w, height: h)
let outURL = URL(fileURLWithPath: args[5])
let studioPID = getppid()

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    var writer: AVAssetWriter!
    var input: AVAssetWriterInput!
    var started = false
    var stopping = false
    let queue = DispatchQueue(label: "screenrec.frames")

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let center = CGPoint(x: rect.midX, y: rect.midY)
        guard let display = content.displays.first(where: { $0.frame.contains(center) }) ?? content.displays.first
        else { fail("No display found.") }
        let studio = content.applications.filter { $0.processID == studioPID }
        let filter = SCContentFilter(display: display, excludingApplications: studio, exceptingWindows: [])

        // Pixel size at the display's native scale; encoders want even sizes.
        let scale = CGFloat(filter.pointPixelScale)
        let pw = Int((rect.width * scale).rounded()) & ~1
        let ph = Int((rect.height * scale).rounded()) & ~1

        let cfg = SCStreamConfiguration()
        cfg.sourceRect = rect.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        cfg.width = pw
        cfg.height = ph
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = true
        cfg.queueDepth = 6

        try? FileManager.default.removeItem(at: outURL)
        writer = try AVAssetWriter(outputURL: outURL, fileType: .mov)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: pw,
            AVVideoHeightKey: ph,
            AVVideoCompressionPropertiesKey: [
                // ~0.2 bits/pixel at 60fps: crisp UI text without huge files.
                AVVideoAverageBitRateKey: Int(Double(pw * ph) * 60 * 0.2),
                AVVideoExpectedSourceFrameRateKey: 60,
            ],
        ])
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        guard writer.startWriting() else { fail(writer.error?.localizedDescription ?? "Couldn't start writing.") }

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s
        print("recording")
        fflush(stdout)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        // Only complete frames carry pixels; idle/blank ones are just status.
        guard type == .screen, !stopping, sb.isValid,
              let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = atts.first?[.status] as? Int,
              SCFrameStatus(rawValue: raw) == .complete
        else { return }
        if !started {
            writer.startSession(atSourceTime: sb.presentationTimeStamp)
            started = true
        }
        if input.isReadyForMoreMediaData { input.append(sb) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("Capture stopped: \(error.localizedDescription)")
    }

    func stop() async {
        if stopping { return }
        try? await stream?.stopCapture()
        queue.sync { stopping = true }
        guard started else { fail("No frames were captured.") }
        // ScreenCaptureKit only sends frames when the screen changes, so end
        // the movie at "now", not at the last frame, to keep a still tail.
        writer.endSession(atSourceTime: CMClockGetTime(CMClockGetHostTimeClock()))
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { fail(writer.error?.localizedDescription ?? "Couldn't finish the movie.") }
        print(outURL.path)
        fflush(stdout)
        exit(0)
    }
}

let recorder = Recorder()
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { Task { await recorder.stop() } }
    src.resume()
    signalSources.append(src)
}
// Studio quit or crashed mid-recording: finish the file instead of recording forever.
let orphanTimer = Timer(timeInterval: 1, repeats: true) { _ in
    if getppid() != studioPID { Task { await recorder.stop() } }
}
RunLoop.main.add(orphanTimer, forMode: .common)

Task {
    do { try await recorder.start() } catch { fail(error.localizedDescription) }
}
RunLoop.main.run()
