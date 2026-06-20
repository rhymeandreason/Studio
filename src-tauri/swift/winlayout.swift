// winlayout
//
// Two modes, selected by argv[1]:
//   list    — print a JSON array of every on-screen window (app, title, x, y,
//             w, h), same filtering as winbounds (skips menus/Dock/tiny
//             windows), but across the whole screen, not just the frontmost.
//   apply   — read a JSON array of the same shape from stdin. For each entry,
//             launch the app if it isn't running (and wait for its first
//             window), then move/resize/un-minimize the matching window via
//             the Accessibility API — including windows that are currently
//             minimized, which CGWindowList can't see. Finally minimize every
//             on-screen window that wasn't part of the layout.
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

// Studio (our parent process — winlayout is always invoked as its
// subprocess) handles its own windows natively via Tauri, not through here;
// skip them so this helper never fights with or duplicates that.
let studioPid = getppid()

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
        guard pid != studioPid else { continue }

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

// Maps owner app name → pid using CGWindowList (kCGWindowListOptionAll, so
// minimized/hidden windows count too), the same source `app` names in a
// saved layout come from. Deliberately not NSWorkspace.runningApplications:
// its `localizedName` can disagree with kCGWindowOwnerName for unbundled
// processes (e.g. Studio itself under `tauri dev`), which would make a
// running app look "not running" and launch a duplicate instance.
func runningPid(forApp app: String) -> pid_t? {
    guard let list = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for win in list {
        guard (win[kCGWindowOwnerName as String] as? String) == app else { continue }
        return win[kCGWindowOwnerPID as String] as? pid_t
    }
    return nil
}

// Launches an app the layout references but that isn't running, then blocks
// (briefly) until both the process and at least one AX window of it exist —
// app launch and first-window creation are async.
func launchAndWaitForWindows(app: String, timeout: Double = 6.0) -> [(AXUIElement, String)] {
    Process.launchedProcess(launchPath: "/usr/bin/open", arguments: ["-a", app])
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if let pid = runningPid(forApp: app) {
            let windows = axWindows(pid: pid)
            if !windows.isEmpty { return windows }
        }
        usleep(200_000)
    }
    if let pid = runningPid(forApp: app) { return axWindows(pid: pid) }
    return []
}

func applyMode() {
    let inputData = FileHandle.standardInput.readDataToEndOfFile()
    guard let targets = try? JSONSerialization.jsonObject(with: inputData) as? [[String: Any]] else {
        exit(1)
    }

    // Restore every saved window first — by app, not by what's currently
    // onscreen, so minimized windows (excluded from CGWindowList) and apps
    // that aren't running yet both get handled.
    var remainingTargets = targets
    var consumedWindows: [AXUIElement] = []
    let targetApps = NSOrderedSet(array: targets.compactMap { $0["app"] as? String }).array as! [String]

    for app in targetApps {
        var windows = runningPid(forApp: app).map(axWindows(pid:)) ?? []
        if windows.isEmpty {
            windows = launchAndWaitForWindows(app: app)
        }

        while let idx = remainingTargets.firstIndex(where: { ($0["app"] as? String) == app }) {
            let target = remainingTargets[idx]
            let title = target["title"] as? String ?? ""
            let matchIdx = windows.firstIndex(where: { $0.1 == title }) ?? (windows.isEmpty ? nil : 0)
            guard let mi = matchIdx else { break }
            let (axWin, _) = windows.remove(at: mi)
            remainingTargets.remove(at: idx)

            let x = (target["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (target["y"] as? NSNumber)?.doubleValue ?? 0
            let w = (target["w"] as? NSNumber)?.doubleValue ?? 0
            let h = (target["h"] as? NSNumber)?.doubleValue ?? 0
            setMinimized(axWin, false)
            setFrame(axWin, x: CGFloat(x), y: CGFloat(y), w: CGFloat(w), h: CGFloat(h))
            consumedWindows.append(axWin)
        }
    }

    // Then minimize every on-screen window that wasn't part of the layout.
    // Matched by pid only, not title: CGWindowList's kCGWindowName is blank
    // without Screen Recording permission while AX's kAXTitleAttribute still
    // returns the real title, so title-matching here (unlike the restore
    // loop above, which falls back to "first window" when titles disagree)
    // would silently skip every window and never minimize anything.
    var seenPids = Set<pid_t>()
    for win in onScreenWindows() where !seenPids.contains(win.pid) {
        seenPids.insert(win.pid)
        for (axWin, _) in axWindows(pid: win.pid) {
            if consumedWindows.contains(where: { CFEqual($0, axWin) }) { continue }
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
