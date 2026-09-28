// webarea [--activate] [--inspector] <app name> [x y w h] — finds a browser's front window
// and the page area inside it (the AXWebArea that isn't a docked inspector)
// via the Accessibility API. With x y w h, first sets the window's frame and
// waits for the page to settle. Prints JSON, all in global points with a
// top-left origin: {"win":{x,y,w,h},"page":{x,y,w,h}|null,
// "screen":{x,y,w,h,scale}} — screen is the visible frame (no menu bar/Dock)
// of the display the window is on; "inspector" says whether a Web
// Inspector / DevTools is docked in the window. --inspector opens one from
// the app's menu first if none is. Problems print
// {"error": "..."}.
import AppKit
import ApplicationServices

func out(_ obj: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}
func rectJSON(_ r: CGRect) -> [String: Double] {
    ["x": r.minX, "y": r.minY, "w": r.width, "h": r.height]
}

var args = Array(CommandLine.arguments.dropFirst())
var activate = false, openInspector = false
while let flag = args.first, flag.hasPrefix("--") {
    if flag == "--activate" { activate = true }
    if flag == "--inspector" { openInspector = true }
    args.removeFirst()
}
guard let name = args.first else { out(["error": "usage: webarea [--activate] [--inspector] <app> [x y w h]"]) }
let target: CGRect? = args.count == 5
    ? CGRect(x: Double(args[1]) ?? 0, y: Double(args[2]) ?? 0, width: Double(args[3]) ?? 0, height: Double(args[4]) ?? 0)
    : nil

guard AXIsProcessTrusted() else {
    out(["error": "Studio needs Accessibility access: System Settings › Privacy & Security › Accessibility."])
}
guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == name }) else {
    out(["error": "\(name) isn’t running."])
}
if activate { app.activate() }
let ax = AXUIElementCreateApplication(app.processIdentifier)

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
    var v: AnyObject?
    AXUIElementCopyAttributeValue(e, a as CFString, &v)
    return v
}
func frame(_ e: AXUIElement) -> CGRect {
    var p = CGPoint.zero, s = CGSize.zero
    if let v = attr(e, kAXPositionAttribute) { AXValueGetValue(v as! AXValue, .cgPoint, &p) }
    if let v = attr(e, kAXSizeAttribute) { AXValueGetValue(v as! AXValue, .cgSize, &s) }
    return CGRect(origin: p, size: s)
}

// Chrome only builds its accessibility tree when an assistive app asks, via
// AXEnhancedUserInterface. But with it on, apps animate or ignore AX resizes
// (window managers like Rectangle switch it off around a resize too) — so
// it's on only while looking for the page (Chrome keeps the tree after).
let enhanced = "AXEnhancedUserInterface" as CFString
func setEnhanced(_ on: Bool) {
    AXUIElementSetAttributeValue(ax, enhanced, on ? kCFBooleanTrue : kCFBooleanFalse)
}

// Web areas are either the page or an inspector (Chrome DevTools is
// devtools://, Safari's Web Inspector is inspector-resource:).
func webArea(_ e: AXUIElement, inspector: Bool, _ depth: Int = 0) -> AXUIElement? {
    if (attr(e, kAXRoleAttribute) as? String) == "AXWebArea" {
        let url = (attr(e, "AXURL") as? URL)?.absoluteString ?? ""
        let isInspector = url.hasPrefix("devtools:") || url.hasPrefix("inspector-resource:")
        return isInspector == inspector ? e : nil
    }
    if depth > 25 { return nil }
    for k in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
        if let f = webArea(k, inspector: inspector, depth + 1) { return f }
    }
    return nil
}
func pageArea(_ e: AXUIElement) -> AXUIElement? { webArea(e, inspector: false) }
func inspectorDocked(in win: AXUIElement) -> Bool { webArea(win, inspector: true) != nil }

// Menu path that opens the inspector for the front tab. Chrome's item is a
// toggle, so it's only pressed when this window has none docked.
let inspectorMenu = name == "Safari"
    ? ["Develop", "Show Web Inspector"]
    : ["View", "Developer", "Developer Tools"]
func pressMenu(_ path: [String]) -> Bool {
    guard let bar = attr(ax, kAXMenuBarAttribute) else { return false }
    var el = bar as! AXUIElement
    for title in path {
        // Menu bar items and menu items hold their items inside an AXMenu child.
        var items = (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        if items.count == 1, (attr(items[0], kAXRoleAttribute) as? String) == "AXMenu" {
            items = (attr(items[0], kAXChildrenAttribute) as? [AXUIElement]) ?? []
        }
        guard let next = items.first(where: { (attr($0, kAXTitleAttribute) as? String) == title }) else { return false }
        el = next
    }
    return AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
}

// Front-most standard window that holds a page (skips an undocked inspector).
func browserWindow() -> (AXUIElement, AXUIElement?)? {
    let wins = (attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []
    let standard = wins.filter { (attr($0, kAXSubroleAttribute) as? String) == "AXStandardWindow" }
    for w in standard { if let p = pageArea(w) { return (w, p) } }
    return standard.first.map { ($0, nil) }
}

func find(retries: Int) -> (AXUIElement, AXUIElement?)? {
    var found = browserWindow()
    if found?.1 == nil, retries > 0 { setEnhanced(true) }
    var n = 0
    while n < retries, found?.1 == nil {
        usleep(100_000)
        found = browserWindow()
        n += 1
    }
    return found
}

guard var (win, page) = find(retries: 20) else { out(["error": "No \(name) window is open."]) }

if openInspector, page != nil, !inspectorDocked(in: win) {
    guard pressMenu(inspectorMenu) else {
        out(["error": name == "Safari"
            ? "Couldn't open the Web Inspector — turn on Safari › Settings › Advanced › Show features for web developers."
            : "Couldn't open Chrome's Developer Tools from the View menu."])
    }
    // Wait for it to appear and the page to relayout around it.
    for _ in 0..<30 {
        usleep(100_000)
        if let found = browserWindow(), found.1 != nil, inspectorDocked(in: found.0) { (win, page) = found; break }
    }
}
setEnhanced(false)

if let t = target {
    // Position, size, then position again: macOS clamps a size that would run
    // off-screen at the old position.
    var p = t.origin, s = t.size
    let pos = AXValueCreate(.cgPoint, &p)!, size = AXValueCreate(.cgSize, &s)!
    AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, pos)
    AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, size)
    AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, pos)
    // The page relayouts a beat after the window resizes: wait until it holds still.
    var last = CGRect.null
    for _ in 0..<15 {
        usleep(60_000)
        if let (w, p) = browserWindow(), let p {
            (win, page) = (w, p)
            let f = frame(p)
            if f == last { break }
            last = f
        }
    }
}

let wf = frame(win)
let screens = NSScreen.screens
let primaryH = screens[0].frame.height
let flip = { (f: CGRect) in CGRect(x: f.minX, y: primaryH - f.maxY, width: f.width, height: f.height) }
let center = CGPoint(x: wf.midX, y: wf.midY)
let screen = screens.first(where: { flip($0.frame).contains(center) }) ?? screens[0]
var scr: [String: Double] = rectJSON(flip(screen.visibleFrame))
scr["scale"] = screen.backingScaleFactor

var result: [String: Any] = ["win": rectJSON(wf), "screen": scr, "inspector": inspectorDocked(in: win)]
if let page { result["page"] = rectJSON(frame(page)) }
out(result)
