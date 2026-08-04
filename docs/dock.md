# Studio Dock

A full-height black strip pinned to the **right edge of the primary display**,
drawn *above* the system menu bar. It's a prototype replacement for the parts of
the menu bar that actually get used — clock, Wi-Fi, volume, battery — plus a few
Studio tool buttons, in a surface that reads as screen bezel rather than as a
window.

Open it from the **Studio tray menu → "Studio Dock"** (toggles).

- Window + native commands: [`src-tauri/src/dock.rs`](../src-tauri/src/dock.rs)
- Strip: [`src/dock/index.html`](../src/dock/index.html)

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

## Views open as tool windows

**The strip is only the strip.** Anything it needs to *show* is a normal tool in
`src/tools/`, opened with `open_tool` exactly like every other Studio tool:

| Button | Tool |
|---|---|
| Projects | [`src/tools/projects.html`](../src/tools/projects.html) |
| Wi-Fi / Sound / Battery | [`src/tools/system-controls.html`](../src/tools/system-controls.html) |

**Follow this pattern for any new Dock view.** It was not the first design:
flyout panels were tried in a dedicated borderless window, built hidden and
revealed with `show()` — first sized to its measured content, then at fixed
size. Neither ever appeared, while tool windows in the same app worked every
time. The structural difference is that tool windows are built **visible** in
one step (`apply_tool_chrome` + `build()`, no `visible(false)`, no deferred
`show()`). Don't reintroduce a bespoke hidden-then-shown window for this.

Two things were learned along the way and are worth keeping in mind:

- **Never resize the strip window.** An early version widened it to make room
  for panels. Resizing a transparent, elevated, full-screen-height window makes
  macOS repaint that whole surface — a hard flicker down the entire edge of the
  screen. The flash *is* the resize; no DOM-side sequencing hides it.
- The strip window re-asserts its geometry after `build()`, since the
  window-state plugin restores a saved size/position for every window and would
  otherwise override it on any launch after the first.

## Projects tool

Lists everything under `~/Projects` with each project's workspace color as a dot
and the active one checked. Picking one calls `activate_project_full`, which
activates the way the **tray menu** does — saved Mode layout included — rather
than the main window's browse-only `open_project`. The header button opens the
main Studio window. Being a normal tool, it also shows up in the Tools menu.

## Native controls (no Control Center required)

You can't open Control Center's own popover programmatically, so the Dock builds
its own (the `system-controls` tool) — better anyway, since it matches Runes.

| What | How |
|---|---|
| Volume read/write, mute | `osascript` — `get volume settings` / `set volume output volume N` |
| Wi-Fi power, SSID | `networksetup -getairportpower` / `-setairportpower` / `-getairportnetwork` |
| Wi-Fi interface name | parsed from `networksetup -listallhardwareports` — it isn't always `en0` |
| Battery % + charging | `pmset -g batt` |
| System Settings panes | `open x-apple.systempreferences:<pane-id>` |

`dock_status` bundles all of it into one call because both the strip (for its
icons) and the controls tool poll it every 10s — each field shells out, so it's
deliberately lazy.

## Styling

The strip is the **one surface that doesn't use the Runes paper palette**: it needs
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
