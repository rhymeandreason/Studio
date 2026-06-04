// bgremove <input-image> <output-png>
//
// Removes the background from an image using Apple's Vision framework
// (VNGenerateForegroundInstanceMaskRequest — the same "subject lifting" tech
// behind Finder's Quick Actions → Remove Background). Writes a transparent PNG.
// Requires macOS 14+.

import Foundation
import Vision
import CoreImage
import AppKit

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count >= 3 else {
    fail("usage: bgremove <input-image> <output-png>", 2)
}
let inputPath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]

guard #available(macOS 14.0, *) else {
    fail("background removal requires macOS 14 or later", 5)
}

guard
    let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: inputPath) as CFURL, nil),
    let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
    fail("could not read input image: \(inputPath)", 3)
}

let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
} catch {
    fail("vision request failed: \(error.localizedDescription)", 4)
}

guard let observation = request.results?.first else {
    fail("no foreground subject found", 6)
}

do {
    // Masked image: original pixels where the subject is, transparent elsewhere.
    let masked = try observation.generateMaskedImage(
        ofInstances: observation.allInstances,
        from: handler,
        croppedToInstancesExtent: false
    )
    let ciImage = CIImage(cvPixelBuffer: masked)
    let context = CIContext()
    guard let outCG = context.createCGImage(ciImage, from: ciImage.extent) else {
        fail("could not render masked image", 7)
    }
    let rep = NSBitmapImageRep(cgImage: outCG)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        fail("could not encode PNG", 8)
    }
    try png.write(to: URL(fileURLWithPath: outputPath))
} catch {
    fail("masking failed: \(error.localizedDescription)", 9)
}
