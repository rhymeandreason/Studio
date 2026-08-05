//! Studio Dock — a full-height black strip pinned to the right edge of the
//! primary display, above the menu bar. It replaces the parts of the system
//! menu bar the author actually uses (clock, Wi-Fi, volume, battery) with
//! Studio-styled equivalents, plus quick access to Studio itself.
//!
//! Two things make it read as "outside the desktop" rather than as a window:
//! an elevated window level (`NSStatusWindowLevel`, above the menu bar's 24),
//! and no chrome at all — borderless, shadowless, square corners, pure black.
//!
//! ## Views open as tool windows
//!
//! The strip is only the strip. Anything it needs to *show* — the project
//! switcher, the system controls — is a normal tool in `src/tools/`, opened via
//! `open_tool`, exactly like every other Studio tool.
//!
//! This was not the first design. Flyout panels were tried in a dedicated
//! borderless window built hidden and revealed with `show()`, first sized to its
//! measured content and then at fixed size. Neither ever appeared. Tool windows,
//! which are built **visible** in one step, work reliably — so new Dock views
//! should follow that pattern rather than growing another bespoke window.
//!
//! Not handled yet (deliberate, prototype): the strip does not reserve screen
//! space, so maximized windows slide underneath it.

use std::process::Command;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const DOCK_LABEL: &str = "studio-dock";

/// Wide enough to cover the right end of the menu bar — the system clock and
/// Control Center — so they're hidden behind the Dock rather than sitting above
/// it. (The strip is at `NSStatusWindowLevel`, so it genuinely covers them.)
const STRIP_W: f64 = 290.0;

// ---------------------------------------------------------------- window ----

/// Logical size of the primary display — `[[NSScreen screens] firstObject]`,
/// which is the one whose origin is (0,0) and which owns the menu bar. That
/// matches Tauri's logical coordinate space, so no origin flipping is needed.
///
/// Note this is the *full* frame, not `visibleFrame`: the dock deliberately
/// runs edge to edge, past the menu bar and the Dock.
#[cfg(target_os = "macos")]
fn primary_screen_size() -> Option<(f64, f64)> {
    use cocoa::base::id;
    use cocoa::foundation::NSRect;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let screens: id = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            return None;
        }
        let screen: id = msg_send![screens, firstObject];
        if screen.is_null() {
            return None;
        }
        let frame: NSRect = msg_send![screen, frame];
        Some((frame.size.width as f64, frame.size.height as f64))
    }
}

#[cfg(not(target_os = "macos"))]
fn primary_screen_size() -> Option<(f64, f64)> {
    None
}

/// Lift the window above the menu bar and make it survive Space switches.
///
/// `always_on_top(true)` alone is not enough: that is `NSFloatingWindowLevel`
/// (3), which sits *below* the menu bar (24), so the strip would be clipped at
/// the top of the screen. 25 is `NSStatusWindowLevel`.
#[cfg(target_os = "macos")]
fn elevate(win: &tauri::WebviewWindow) {
    use cocoa::base::{id, NO};
    use objc::{msg_send, sel, sel_impl};
    let Ok(ptr) = win.ns_window() else { return };
    let ns = ptr as id;
    unsafe {
        let _: () = msg_send![ns, setLevel: 25i64];
        // canJoinAllSpaces (1) — follow the user between Spaces rather than
        // living on one; stationary (16) — don't slide around during Mission
        // Control; fullScreenAuxiliary (256) — stay visible over fullscreen
        // apps instead of being hidden with the menu bar.
        let _: () = msg_send![ns, setCollectionBehavior: 1u64 | 16 | 256];
        // Without this the strip vanishes whenever another app is focused,
        // which is most of the time.
        let _: () = msg_send![ns, setHidesOnDeactivate: NO];
    }
}

#[cfg(not(target_os = "macos"))]
fn elevate(_win: &tauri::WebviewWindow) {}

/// Place the dock flush against the right edge, spanning the full screen
/// height. Called on open and again on every expand/collapse, since widening
/// has to move the left edge to keep the right edge pinned.
fn place(win: &tauri::WebviewWindow, width: f64) {
    let Some((sw, sh)) = primary_screen_size() else { return };
    let _ = win.set_size(tauri::LogicalSize::new(width, sh));
    let _ = win.set_position(tauri::LogicalPosition::new(sw - width, 0.0));
}

/// Show the dock, building it on first use. Toggles closed if already open.
pub fn toggle_studio_dock(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(DOCK_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
        }
        return;
    }

    let url = WebviewUrl::App("dock/index.html".into());
    if let Ok(win) = WebviewWindowBuilder::new(app, DOCK_LABEL, url)
        .inner_size(STRIP_W, 1000.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()
    {
        elevate(&win);
        place(&win, STRIP_W);
        let _ = win.show();
    }
}

#[tauri::command]
pub fn toggle_dock(app: AppHandle) {
    toggle_studio_dock(&app);
}

// --------------------------------------------------------------- status -----

fn sh(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn osascript(script: &str) -> String {
    sh("osascript", &["-e", script])
}

/// The BSD name of the Wi-Fi interface. Usually `en0`, but not on every Mac
/// (Thunderbolt/Ethernet adapters shuffle the numbering), so ask rather than
/// hardcode. Parses `networksetup -listallhardwareports`, which prints
/// "Hardware Port: Wi-Fi" followed by "Device: enN".
fn wifi_device() -> Option<String> {
    let out = sh("networksetup", &["-listallhardwareports"]);
    let mut lines = out.lines();
    while let Some(line) = lines.next() {
        if line.trim_start().starts_with("Hardware Port:") && line.contains("Wi-Fi") {
            for next in lines.by_ref() {
                if let Some(dev) = next.trim().strip_prefix("Device:") {
                    return Some(dev.trim().to_string());
                }
            }
        }
    }
    None
}

#[derive(serde::Serialize, Default)]
pub struct DockStatus {
    wifi_on: bool,
    /// Empty when Wi-Fi is off, not associated, or macOS withheld the name
    /// (recent versions gate SSID reads behind Location Services).
    ssid: String,
    volume: i32,
    muted: bool,
    /// Battery percentage, or -1 on a machine without one.
    battery: i32,
    charging: bool,
}

/// One round-trip for everything the strip displays — the page polls this on a
/// timer, so it should stay a single call rather than four.
#[tauri::command]
pub fn dock_status() -> DockStatus {
    let mut s = DockStatus { battery: -1, ..Default::default() };

    if let Some(dev) = wifi_device() {
        s.wifi_on = sh("networksetup", &["-getairportpower", &dev]).ends_with("On");
        if s.wifi_on {
            let out = sh("networksetup", &["-getairportnetwork", &dev]);
            if let Some(name) = out.split_once(": ") {
                s.ssid = name.1.trim().to_string();
            }
        }
    }

    let vol = osascript("output volume of (get volume settings)");
    s.volume = vol.parse().unwrap_or(0);
    s.muted = osascript("output muted of (get volume settings)") == "true";

    // `pmset -g batt` prints e.g. " -InternalBattery-0 (id=...)  87%; discharging; 4:12 remaining".
    let batt = sh("pmset", &["-g", "batt"]);
    if let Some(pct) = batt.split('%').next().and_then(|s| {
        s.rsplit(|c: char| !c.is_ascii_digit())
            .next()
            .filter(|d| !d.is_empty())
            .map(str::to_string)
    }) {
        s.battery = pct.parse().unwrap_or(-1);
    }
    s.charging = batt.contains("AC Power");

    s
}

#[tauri::command]
pub fn dock_set_volume(level: i32) {
    let level = level.clamp(0, 100);
    osascript(&format!("set volume output volume {level}"));
    // Setting a level while muted is silent otherwise — nudging a slider is an
    // unambiguous "I want to hear this".
    if level > 0 {
        osascript("set volume without output muted");
    }
}

#[tauri::command]
pub fn dock_toggle_mute() {
    let muted = osascript("output muted of (get volume settings)") == "true";
    osascript(if muted {
        "set volume without output muted"
    } else {
        "set volume with output muted"
    });
}

#[tauri::command]
pub fn dock_toggle_wifi(on: bool) {
    if let Some(dev) = wifi_device() {
        sh(
            "networksetup",
            &["-setairportpower", &dev, if on { "on" } else { "off" }],
        );
    }
}

/// Open a System Settings pane by its extension id — the escape hatch for
/// anything the strip's own controls don't cover.
#[tauri::command]
pub fn dock_open_settings(pane: String) {
    sh("open", &[&format!("x-apple.systempreferences:{pane}")]);
}
