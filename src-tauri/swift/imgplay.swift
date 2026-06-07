// imgplay — headless Image Playground generator (Apple Intelligence).
//This doesn't work in the background at of Jun 7 2026, revisit later
//
// Usage:  imgplay <input-image> <style> <output.png>
//   style: animation | illustration | sketch
//
// Generates one stylized image seeded by the input photo via the on-device
// ImageCreator API and writes it to <output.png>. Used to evaluate whether
// Image Playground's photo-seeding is useful for Studio. Stylized only.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ImagePlayground
import UniformTypeIdentifiers

func die(_ msg: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

func loadCGImage(_ path: String) -> CGImage? {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { return nil }
    return img
}

// Downscale so the longest side is <= max (ImageCreator dislikes huge inputs).
func downscale(_ img: CGImage, max maxSide: Int) -> CGImage {
    let w = img.width
    let h = img.height
    let scale = min(1.0, Double(maxSide) / Double(Swift.max(w, h)))
    if scale >= 1.0 { return img }
    let nw = Int(Double(w) * scale)
    let nh = Int(Double(h) * scale)
    guard
        let ctx = CGContext(
            data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return img }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: nw, height: nh))
    return ctx.makeImage() ?? img
}

func writePNG(_ image: CGImage, to path: String) -> Bool {
    let url = URL(fileURLWithPath: path)
    guard
        let dest = CGImageDestinationCreateWithURL(
            url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { return false }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest)
}

@available(macOS 15.4, *)
func run() async {
    let args = CommandLine.arguments
    guard args.count >= 4 else {
        die(
            "usage: imgplay <input-image | -> <animation|illustration|sketch> <output.png> [prompt]",
            2)
    }
    let inPath = args[1]
    let styleName = args[2].lowercased()
    let outPath = args[3]
    let prompt = args.count >= 5 ? args[4] : ""

    // ImageCreator refuses to run from a background process
    // (backgroundCreationForbidden), so let activation settle first.
    try? await Task.sleep(nanoseconds: 400_000_000)

    // Build the concepts: optional source image (`-` = none) + optional text.
    var concepts: [ImagePlaygroundConcept] = []
    if inPath != "-" {
        guard let cg = loadCGImage(inPath) else { die("could not read input image: \(inPath)") }
        concepts.append(.image(downscale(cg, max: 1024)))
    }
    if !prompt.isEmpty { concepts.append(.text(prompt)) }
    guard !concepts.isEmpty else { die("need a source image and/or a prompt", 2) }

    do {
        // Throws if Image Playground isn't available (Apple Intelligence off,
        // unsupported device, models not downloaded).
        let creator = try await ImageCreator()
        let style: ImagePlaygroundStyle
        switch styleName {
        case "illustration": style = .illustration
        case "sketch": style = .sketch
        default: style = .animation
        }

        let stream = creator.images(for: concepts, style: style, limit: 1)
        for try await created in stream {
            if writePNG(created.cgImage, to: outPath) {
                print(outPath)
                exit(0)
            }
            die("failed to write output: \(outPath)")
        }
        die("no image produced")
    } catch {
        die("ImageCreator error: \(error)")
    }
}

// ImageCreator only generates for a foreground app, so run as a real (regular)
// app: activate ourselves, then kick off generation once the event loop is up.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        if #available(macOS 15.4, *) {
            Task { await run() }  // run() calls exit() on every path
        } else {
            die("requires macOS 15.4 or later")
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
