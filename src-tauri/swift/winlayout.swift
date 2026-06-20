// winlayout
//
// Two modes, selected by argv[1]:
//   list    — print a JSON array of every on-screen window (app, title, x, y,
//             w, h), same filtering as winbounds (skips menus/Dock/tiny
//             windows), but across the whole screen, not just the frontmost.
//   apply   — read a JSON array of the same shape from stdin, move/resize and
//             un-minimize each matching window via the Accessibility API,
//             then minimize every other on-screen window not in the list.
//
// Moving/resizing/minimizing windows owned by *other* processes requires the
// Accessibility API (AXUIElement) — CGWindowList is read-only. First run
// prompts for Accessibility permission (System Settings > Privacy & Security
// > Accessibility); until granted, AX calls fail silently (no-op).

import Cocoa
import ApplicationServices

struct WinInfo {
    let app: String
    let title: String
    let pid: pid_t
    let x: CGFloat
    let y: CGFloat
    let w: CGFloat
    let h: CGFloat
}

func onScreenWindows() -> [WinInfo] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var result: [WinInfo] = []
    for win in list {
        let layer = win[kCGWindowLayer as String] as? Int ?? 99
        guard layer <= 5 else { continue }

        let title = win[kCGWindowName as String] as? String ?? ""
        guard title != "Window Size" else { continue }

        let app = win[kCGWindowOwnerName as String] as? String ?? ""
        guard !app.isEmpty, app != "Window Server", app != "Dock", app != "winlayout" else { continue }

        guard let pid = win[kCGWindowOwnerPID as String] as? pid_t else { continue }

        guard let bounds = win[kCGWindowBounds as String] as? [String: Any],
              let x = bounds["X"] as? CGFloat,
              let y = bounds["Y"] as? CGFloat,
              let w = bounds["Width"] as? CGFloat,
              let h = bounds["Height"] as? CGFloat,
              w >= 50, h >= 50 else { continue }

        result.append(WinInfo(app: app, title: title, pid: pid, x: x, y: y, w: w, h: h))
    }
    return result
}

func listMode() {
    let windows = onScreenWindows()
    var items: [[String: Any]] = []
    for win in windows {
        items.append([
            "app": win.app,
            "title": win.title,
            "x": Int(win.x),
            "y": Int(win.y),
            "w": Int(win.w),
            "h": Int(win.h),
        ])
    }
    let data = try! JSONSerialization.data(withJSONObject: items)
    FileHandle.standardOutput.write(data)
}

// Returns the AX windows of a process, paired with their AX title.
func axWindows(pid: pid_t) -> [(AXUIElement, String)] {
    let appEl = AXUIElementCreateApplication(pid)
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &value)
    guard err == .success, let windows = value as? [AXUIElement] else { return [] }
    return windows.map { win in
        var titleVal: AnyObject?
        AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleVal)
        return (win, (titleVal as? String) ?? "")
    }
}

func setMinimized(_ win: AXUIElement, _ minimized: Bool) {
    AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, minimized as CFBoolean)
}

func setFrame(_ win: AXUIElement, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) {
    var pos = CGPoint(x: x, y: y)
    var size = CGSize(width: w, height: h)
    if let posVal = AXValueCreate(.cgPoint, &pos) {
        AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, posVal)
    }
    if let sizeVal = AXValueCreate(.cgSize, &size) {
        AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, sizeVal)
    }
}

func applyMode() {
    let inputData = FileHandle.standardInput.readDataToEndOfFile()
    guard let targets = try? JSONSerialization.jsonObject(with: inputData) as? [[String: Any]] else {
        exit(1)
    }

    let onscreen = onScreenWindows()
    // Group onscreen windows by pid so we only touch AX for processes that
    // actually have a window on the desktop right now.
    var pidsByApp: [String: pid_t] = [:]
    for win in onscreen where pidsByApp[win.app] == nil {
        pidsByApp[win.app] = win.pid
    }

    // Track which (app,title) pairs are in the saved layout, and consume AX
    // windows as we match them so duplicate titles don't double-restore.
    var remainingTargets = targets
    var axCache: [pid_t: [(AXUIElement, String)]] = [:]

    func consumeTarget(app: String, title: String) -> [String: Any]? {
        guard let idx = remainingTargets.firstIndex(where: {
            ($0["app"] as? String) == app && ($0["title"] as? String) == title
        }) else { return nil }
        return remainingTargets.remove(at: idx)
    }

    for win in onscreen {
        guard let pid = pidsByApp[win.app] else { continue }
        let windows = axCache[pid] ?? axWindows(pid: pid)
        axCache[pid] = windows

        guard let (axWin, _) = windows.first(where: { $0.1 == win.title }) else { continue }

        if let target = consumeTarget(app: win.app, title: win.title) {
            let x = (target["x"] as? NSNumber)?.doubleValue ?? Double(win.x)
            let y = (target["y"] as? NSNumber)?.doubleValue ?? Double(win.y)
            let w = (target["w"] as? NSNumber)?.doubleValue ?? Double(win.w)
            let h = (target["h"] as? NSNumber)?.doubleValue ?? Double(win.h)
            setMinimized(axWin, false)
            setFrame(axWin, x: CGFloat(x), y: CGFloat(y), w: CGFloat(w), h: CGFloat(h))
        } else {
            setMinimized(axWin, true)
        }
    }
}

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "list"
switch mode {
case "list":
    listMode()
case "apply":
    applyMode()
default:
    FileHandle.standardError.write("usage: winlayout [list|apply]\n".data(using: .utf8)!)
    exit(1)
}
