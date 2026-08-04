# Studio Dock

A full-height black strip pinned to the **right edge of the primary display**,
drawn *above* the system menu bar. It's a prototype replacement for the parts of
the menu bar that actually get used — clock, Wi-Fi, volume, battery — plus a few
Studio tool buttons, in a surface that reads as screen bezel rather than as a
window.

Open it from the **Studio tray menu → "Studio Dock"** (toggles).

- Window + native commands: [`src-tauri/src/dock.rs`](../src-tauri/src/dock.rs)
- Page: [`src/dock/index.html`](../src/dock/index.html)

## Why a normal always-on-top window isn't enough

`always_on_top(true)` gives `NSFloatingWindowLevel` (3), which sits **below** the
menu bar (24) — the strip would be clipped along the top of the screen. `elevate()`
in `dock.rs` reaches the `NSWindow` and sets:

| Property | Value | Why |
|---|---|---|
| `level` | `25` (`NSStatusWindowLevel`) | above the menu bar |
| `collectionBehavior` | `canJoinAllSpaces \| stationary \| fullScreenAuxiliary` | follows you between Spaces, doesn't drift in Mission Control, survives fullscreen apps |
| `hidesOnDeactivate` | `NO` | otherwise it vanishes whenever another app is focused |

Geometry comes from `[[NSScreen screens] firstObject]` — the primary display,
whose origin is (0,0), so it maps straight onto Tauri's logical coordinates. It
uses the full `frame`, not `visibleFrame`, so the strip runs past the menu bar
and the Dock.

## The width trick

Flyouts (volume slider, Wi-Fi panel) need to draw *left* of the 56px strip, but a
webview can't paint outside its own window. Making the window permanently wide and
transparent would swallow clicks meant for whatever is underneath — so instead the
page calls `dock_expand(true)` to widen the window to 260px only while a panel is
open, and `dock_expand(false)` to shrink back. `place()` re-pins the right edge on
every resize.

## Native controls (no Control Center required)

You can't open Control Center's own popover programmatically, so the strip builds
its own — which is better anyway, since it matches Runes.

| What | How |
|---|---|
| Volume read/write, mute | `osascript` — `get volume settings` / `set volume output volume N` |
| Wi-Fi power, SSID | `networksetup -getairportpower` / `-setairportpower` / `-getairportnetwork` |
| Wi-Fi interface name | parsed from `networksetup -listallhardwareports` — it isn't always `en0` |
| Battery % + charging | `pmset -g batt` |
| System Settings panes | `open x-apple.systempreferences:<pane-id>` |

`dock_status` bundles all of it into one call because the page polls it (every 10s
— each field shells out, so it's deliberately lazy).

## Styling

The Dock is the **one surface that doesn't use the Runes paper palette**: it needs
to read as bezel, so `index.html` defines a local near-black scale (`--dock-bg`,
`--dock-text`, `--dock-dim`…). It still uses `tokens.css` for type (`--sans`),
Material Symbols (`.mi`), radii and motion easings. It has no window chrome —
`kit/window-chrome.js` is deliberately *not* loaded, since there's no bar, no close
dot and no dragging.

## Known limits (prototype)

- **No reserved space.** macOS only reserves screen edges for the menu bar and the
  Dock; there's no public API to claim a column. Maximized windows slide
  underneath. The real fix is nudging windows via the Accessibility API (what
  tiling managers do) — not attempted yet.
- **Primary display only.** No repositioning on display change.
- **Activating.** It's an `NSWindow`, not a non-activating `NSPanel`, so clicking
  the strip pulls focus to Studio. Fixing this properly means a custom panel class.
- The system menu bar is unchanged — auto-hide it (System Settings → Control
  Center) and ⌘-drag unwanted status icons off the bar to get the intended effect.
