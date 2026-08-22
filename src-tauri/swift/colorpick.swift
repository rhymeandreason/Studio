// colorpick
//
// Shows macOS's built-in screen color sampler (NSColorSampler — the same
// magnifier loupe the system color panel's eyedropper uses) and prints the
// picked color as `#rrggbb` on stdout. Exits 1 with no output if the pick was
// cancelled (Esc / click outside).
//
// NSColorSampler samples any pixel on any display without Screen Recording
// permission, so Studio gets a global eyedropper for free. It needs a run loop,
// hence the NSApplication — `.accessory` keeps the helper out of the Dock.

import Cocoa

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

func finish(_ color: NSColor?) -> Never {
    guard let c = color?.usingColorSpace(.sRGB) else { exit(1) }
    let r = Int((c.redComponent * 255).rounded())
    let g = Int((c.greenComponent * 255).rounded())
    let b = Int((c.blueComponent * 255).rounded())
    print(String(format: "#%02x%02x%02x", r, g, b))
    exit(0)
}

if #available(macOS 10.15, *) {
    // Sampling starts as soon as the app finishes launching; showing it before
    // the run loop is up leaves the loupe without a window server connection.
    DispatchQueue.main.async {
        NSApp.activate(ignoringOtherApps: true)
        NSColorSampler().show { finish($0) }
    }
    app.run()
} else {
    exit(1)
}
