// winbounds
//
// Prints "AppName,WindowTitle,x,y,w,h" for the topmost on-screen window,
// skipping Studio's own floating windows (incl. this tool) and system
// processes (Window Server, Dock).
// Uses CGWindowListCopyWindowInfo so it works regardless of focus/key-window
// state — returns windows in compositor Z-order, frontmost first.

import Cocoa

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    print(",,0,0,0,0")
    exit(0)
}

for win in list {
    let layer = win[kCGWindowLayer as String] as? Int ?? 99
    // layer 0 = normal app windows, 3 = floating (NSFloatingWindowLevel)
    // skip anything above 5 (menus, status bar, Dock, etc.)
    guard layer <= 5 else { continue }

    // Skip Studio's own floating windows (the always-on-top Window Size tool
    // itself, the Camera Bubble…) by owner — Studio is our parent process.
    // Matching on the title stopped working once tool windows got empty native
    // titles (the page paints its own bar), and titles need Screen Recording
    // permission anyway. Studio's normal windows (layer 0) stay measurable.
    let pid = win[kCGWindowOwnerPID as String] as? Int32 ?? -1
    guard !(pid == getppid() && layer > 0) else { continue }

    let title = win[kCGWindowName as String] as? String ?? ""
    guard title != "Window Size" else { continue }

    let app = win[kCGWindowOwnerName as String] as? String ?? ""
    guard !app.isEmpty, app != "Window Server", app != "Dock" else { continue }

    guard let bounds = win[kCGWindowBounds as String] as? [String: Any],
          let x = bounds["X"] as? CGFloat,
          let y = bounds["Y"] as? CGFloat,
          let w = bounds["Width"] as? CGFloat,
          let h = bounds["Height"] as? CGFloat,
          w >= 50, h >= 50 else { continue }

    // Escape commas in title so the caller can split on the last 4 commas
    let safeTitle = title.replacingOccurrences(of: ",", with: "‚") // uses Unicode comma
    print("\(app),\(safeTitle),\(Int(x)),\(Int(y)),\(Int(w)),\(Int(h))")
    exit(0)
}

print(",,0,0,0,0")
