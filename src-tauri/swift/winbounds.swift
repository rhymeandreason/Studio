// winbounds
//
// Prints "AppName,WindowTitle,x,y,w,h" for the topmost on-screen window,
// skipping the Window Size tool and system processes (Window Server, Dock).
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
