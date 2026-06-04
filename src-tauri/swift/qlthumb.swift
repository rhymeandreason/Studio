// qlthumb <input-file> <size> <output-png>
//
// Generates a QuickLook thumbnail for any file type (images, video, PDF, audio,
// etc.) and writes it as a PNG. Uses the same OS thumbnail service as Finder.

import Foundation
import QuickLookThumbnailing
import AppKit

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count >= 4 else {
    fail("usage: qlthumb <input-file> <size> <output-png>", 2)
}
let inputPath = CommandLine.arguments[1]
let size = Double(CommandLine.arguments[2]) ?? 512
let outputPath = CommandLine.arguments[3]

let request = QLThumbnailGenerator.Request(
    fileAt: URL(fileURLWithPath: inputPath),
    size: CGSize(width: size, height: size),
    scale: 1.0,
    representationTypes: .thumbnail
)

let semaphore = DispatchSemaphore(value: 0)
var code: Int32 = 0

QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { rep, error in
    defer { semaphore.signal() }
    guard let rep = rep else {
        code = 6
        return
    }
    let bitmap = NSBitmapImageRep(cgImage: rep.cgImage)
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        code = 7
        return
    }
    do {
        try png.write(to: URL(fileURLWithPath: outputPath))
    } catch {
        code = 8
    }
}

semaphore.wait()
exit(code)
