// winowner
//
// Prints the name of the app owning the topmost window under the mouse cursor
// *right now* — used to decide whether a native drag-out landed in Finder.
// Prints "Finder" when the cursor is over the bare Desktop (no window under it),
// and an empty line if the lookup fails.
//
// Reads the live cursor rather than taking coordinates, so callers don't have
// to reconcile AppKit's bottom-left origin with CoreGraphics' top-left one —
// or get it wrong on a secondary display.

import Cocoa

// NSEvent.mouseLocation is global, bottom-left origin. CGWindow bounds are
// global, top-left origin, anchored to the PRIMARY display — so flipping by the
// primary screen's height is correct for every monitor, not just the main one.
let mouse = NSEvent.mouseLocation
guard let primary = NSScreen.screens.first else {
    print("")
    exit(0)
}
let point = CGPoint(x: mouse.x, y: primary.frame.maxY - mouse.y)

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    print("")
    exit(0)
}

for win in list {
    let layer = win[kCGWindowLayer as String] as? Int ?? 99
    // layer 0 = normal app windows, 3 = floating; above 5 is menus/Dock/status
    // bar, which are never a drop destination.
    guard layer <= 5 else { continue }

    let app = win[kCGWindowOwnerName as String] as? String ?? ""
    guard !app.isEmpty, app != "Window Server", app != "Dock" else { continue }

    guard let bounds = win[kCGWindowBounds as String] as? [String: Any],
          let x = bounds["X"] as? CGFloat,
          let y = bounds["Y"] as? CGFloat,
          let w = bounds["Width"] as? CGFloat,
          let h = bounds["Height"] as? CGFloat else { continue }

    if CGRect(x: x, y: y, width: w, height: h).contains(point) {
        print(app)
        exit(0)
    }
}

// Nothing under the cursor — the drop landed on the Desktop, which is Finder.
print("Finder")
