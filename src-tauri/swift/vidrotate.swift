// Losslessly rotates a video file by rewriting its track transform via an
// AVFoundation passthrough export (remux only, no re-encode/quality loss) —
// the same trick QuickTime/Finder use for "Rotate" on a video clip.
//
// Usage: vidrotate <src> <degrees> <tmpOutput>
// `degrees` is an *additional* clockwise rotation (90/180/270) stacked on top
// of the track's existing preferredTransform. Prints `DONE <path>` or
// `ERROR <message>`; the caller is responsible for swapping tmpOutput in over
// the original file.

import AVFoundation
import Foundation

func fail(_ msg: String) -> Never {
    print("ERROR \(msg)")
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 4, let degrees = Double(args[2]) else {
    fail("usage: vidrotate <src> <degrees> <tmpOutput>")
}
let srcURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[3])
try? FileManager.default.removeItem(at: outURL)

let asset = AVURLAsset(url: srcURL)
guard let videoTrack = asset.tracks(withMediaType: .video).first else {
    fail("no video track")
}

let composition = AVMutableComposition()
guard
    let compVideo = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
else { fail("cannot create composition video track") }

let range = CMTimeRange(start: .zero, duration: asset.duration)
do {
    try compVideo.insertTimeRange(range, of: videoTrack, at: .zero)
    if let audioTrack = asset.tracks(withMediaType: .audio).first,
        let compAudio = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
    {
        try compAudio.insertTimeRange(range, of: audioTrack, at: .zero)
    }
} catch {
    fail("compose failed: \(error)")
}

let radians = degrees * .pi / 180
let rotation = CGAffineTransform(rotationAngle: CGFloat(radians))
compVideo.preferredTransform = videoTrack.preferredTransform.concatenating(rotation)

guard
    let exporter = AVAssetExportSession(
        asset: composition, presetName: AVAssetExportPresetPassthrough)
else { fail("cannot create exporter") }
exporter.outputURL = outURL
exporter.outputFileType = outURL.pathExtension.lowercased() == "mp4" ? .mp4 : .mov

let sem = DispatchSemaphore(value: 0)
exporter.exportAsynchronously {
    sem.signal()
}
sem.wait()

switch exporter.status {
case .completed:
    print("DONE \(outURL.path)")
case .failed, .cancelled:
    fail(exporter.error?.localizedDescription ?? "export failed or was cancelled")
default:
    fail("unexpected export status \(exporter.status.rawValue)")
}
