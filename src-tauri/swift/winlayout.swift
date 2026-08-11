// winlayout
//
// Two modes, selected by argv[1]:
//   list    — print a JSON array of every on-screen window (app, title, x, y,
//             w, h), same filtering as winbounds (skips menus/Dock/tiny
//             windows), but across the whole screen, not just the frontmost.
//   apply   — read a JSON array of the same shape from stdin. For each entry,
//             launch the app if it isn't running (and wait for its first
//             window), then move/resize/un-minimize/unhide the matching
//             window via the Accessibility API — including windows that are
//             currently minimized, which CGWindowList can't see. Finally
//             hide (or, where an app has a mix of target and non-target
//             windows, minimize) every on-screen window that wasn't part of
//             the layout.
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
            "title": axTitle(for: win),
            "x": Int(win.x),
            "y": Int(win.y),
            "w": Int(win.w),
            "h": Int(win.h),
        ])
    }
    let data = try! JSONSerialization.data(withJSONObject: items)
    FileHandle.standardOutput.write(data)
}

// One window as the Accessibility API sees it: the element, its real title
// and its current frame.
struct AXWin {
    let el: AXUIElement
    let title: String
    let frame: CGRect
}

func axAttr<T>(_ el: AXUIElement, _ attr: String) -> T? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else { return nil }
    return value as? T
}

func axFrame(_ win: AXUIElement) -> CGRect {
    var pos = CGPoint.zero
    var size = CGSize.zero
    if let v: AnyObject = axAttr(win, kAXPositionAttribute as String) {
        AXValueGetValue(v as! AXValue, .cgPoint, &pos)
    }
    if let v: AnyObject = axAttr(win, kAXSizeAttribute as String) {
        AXValueGetValue(v as! AXValue, .cgSize, &size)
    }
    return CGRect(origin: pos, size: size)
}

// Returns the AX windows of a process. AX is asked once per pid and cached:
// every call crosses a process boundary, and both modes hit the same pids
// repeatedly.
var axWindowCache: [pid_t: [AXWin]] = [:]

func axWindows(pid: pid_t) -> [AXWin] {
    if let hit = axWindowCache[pid] { return hit }
    let appEl = AXUIElementCreateApplication(pid)
    let windows: [AXUIElement] = axAttr(appEl, kAXWindowsAttribute as String) ?? []
    let result = windows.map { win in
        AXWin(el: win, title: axAttr(win, kAXTitleAttribute as String) ?? "", frame: axFrame(win))
    }
    // Empty is never cached: `launchAndWaitForWindows` polls this while an
    // app is starting up, and a cached "no windows" would never clear.
    if !result.isEmpty { axWindowCache[pid] = result }
    return result
}

// How far apart two frames are, as the sum of their edge offsets. Used both
// to pair a CGWindowList window with its AX twin and to fall back to the
// nearest-shaped window when titles don't match on apply.
func frameDistance(_ a: CGRect, _ b: CGRect) -> CGFloat {
    abs(a.origin.x - b.origin.x) + abs(a.origin.y - b.origin.y)
        + abs(a.width - b.width) + abs(a.height - b.height)
}

// The real title of a recorded window, read through AX.
//
// CGWindowList's kCGWindowName is blank unless the calling app holds Screen
// Recording permission, so recording straight from it saved a layout full of
// empty titles — and two windows of the same app (Safari's browser window and
// its Web Inspector, say) became indistinguishable on apply. AX only needs
// the Accessibility permission this helper already requires to move windows
// at all, so ask it instead, pairing CG windows to AX windows by frame.
// Falls back to whatever CG gave us if the pairing fails.
func axTitle(for win: WinInfo) -> String {
    let cgFrame = CGRect(x: win.x, y: win.y, width: win.w, height: win.h)
    let best = axWindows(pid: win.pid)
        .map { ($0, frameDistance($0.frame, cgFrame)) }
        .min { $0.1 < $1.1 }
    // A window whose frame is off by more than a couple of points isn't the
    // same window (AX and CG agree exactly for on-screen windows).
    if let (axWin, distance) = best, distance <= 4, !axWin.title.isEmpty {
        return axWin.title
    }
    return win.title
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
func launchAndWaitForWindows(app: String, timeout: Double = 6.0) -> [AXWin] {
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
        let pid = runningPid(forApp: app)
        if let pid, let runningApp = NSRunningApplication(processIdentifier: pid) {
            runningApp.unhide()
        }
        var windows = pid.map(axWindows(pid:)) ?? []
        if windows.isEmpty {
            windows = launchAndWaitForWindows(app: app)
        }

        while let idx = remainingTargets.firstIndex(where: { ($0["app"] as? String) == app }) {
            let target = remainingTargets[idx]
            let title = target["title"] as? String ?? ""
            let x = (target["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (target["y"] as? NSNumber)?.doubleValue ?? 0
            let w = (target["w"] as? NSNumber)?.doubleValue ?? 0
            let h = (target["h"] as? NSNumber)?.doubleValue ?? 0
            let saved = CGRect(x: x, y: y, width: w, height: h)

            // Exact title first. Failing that, the window closest to where
            // this one was saved — a document title drifts (Safari retitles
            // itself on every navigation), but a Web Inspector docked below a
            // browser window still has roughly the inspector's shape, so
            // shape-matching beats the old "just take the first window",
            // which handed the browser's frame to whichever window AX
            // happened to list first.
            let matchIdx = windows.firstIndex(where: { $0.title == title })
                ?? windows.indices.min { frameDistance(windows[$0].frame, saved) < frameDistance(windows[$1].frame, saved) }
            guard let mi = matchIdx else { break }
            let axWin = windows.remove(at: mi).el
            remainingTargets.remove(at: idx)

            setMinimized(axWin, false)
            setFrame(axWin, x: CGFloat(x), y: CGFloat(y), w: CGFloat(w), h: CGFloat(h))
            consumedWindows.append(axWin)
        }
    }

    // Then get every on-screen window that wasn't part of the layout out of
    // the way. Matched by pid only, not title: CGWindowList's kCGWindowName
    // is blank without Screen Recording permission while AX's
    // kAXTitleAttribute still returns the real title, so title-matching here
    // (unlike the restore loop above, which falls back to "first window"
    // when titles disagree) would silently skip every window and never
    // hide/minimize anything.
    //
    // Prefer hiding the whole app (NSRunningApplication.hide(), the Cmd+H
    // equivalent) over minimizing each window: it's instant, while AX
    // minimize plays the genie animation per window, which is slow with
    // several windows. Only fall back to per-window minimize when some of
    // the app's windows are layout targets (consumed) and others aren't —
    // hiding is app-wide so it would also hide the windows we just placed.
    var seenPids = Set<pid_t>()
    for win in onScreenWindows() where !seenPids.contains(win.pid) {
        seenPids.insert(win.pid)
        let axWins = axWindows(pid: win.pid)
        let unconsumed = axWins.filter { w in !consumedWindows.contains(where: { CFEqual($0, w.el) }) }
        if unconsumed.isEmpty { continue }

        if unconsumed.count == axWins.count, let runningApp = NSRunningApplication(processIdentifier: win.pid) {
            runningApp.hide()
        } else {
            for w in unconsumed {
                setMinimized(w.el, true)
            }
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
