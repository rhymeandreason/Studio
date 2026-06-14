// appicon <app-bundle-path> <size> <output-png>
//
// Renders an application's icon (NSWorkspace) to a PNG of the given size.

import AppKit

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count >= 4 else {
    fail("usage: appicon <app-bundle-path> <size> <output-png>", 2)
}
let appPath = CommandLine.arguments[1]
let size = CGFloat(Double(CommandLine.arguments[2]) ?? 128)
let outputPath = CommandLine.arguments[3]

let icon = NSWorkspace.shared.icon(forFile: appPath)
let targetSize = NSSize(width: size, height: size)

let image = NSImage(size: targetSize)
image.lockFocus()
icon.draw(
    in: NSRect(origin: .zero, size: targetSize),
    from: .zero,
    operation: .copy,
    fraction: 1.0
)
image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let png = bitmap.representation(using: .png, properties: [:])
else {
    fail("failed to render icon", 3)
}

do {
    try png.write(to: URL(fileURLWithPath: outputPath))
} catch {
    fail("failed to write \(outputPath): \(error)", 4)
}
