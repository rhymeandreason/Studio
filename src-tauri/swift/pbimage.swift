// pbimage <output-png>
//
// Reads an image from the macOS clipboard (NSPasteboard) and writes it as PNG.
// Exits non-zero if the clipboard holds no image.

import AppKit
import Foundation

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count >= 2 else {
    fail("usage: pbimage <output-png>", 2)
}
let outputPath = CommandLine.arguments[1]

let pasteboard = NSPasteboard.general
guard
    let images = pasteboard.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage],
    let image = images.first,
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let png = bitmap.representation(using: .png, properties: [:])
else {
    fail("no image in clipboard", 6)
}

do {
    try png.write(to: URL(fileURLWithPath: outputPath))
} catch {
    fail("could not write output: \(error.localizedDescription)", 8)
}
