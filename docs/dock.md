# Studio Dock

A full-height black strip pinned to the **right edge of the primary display**,
drawn *above* the system menu bar, in a surface that reads as screen bezel rather
than as a window. It's a **project notes reader** — the thing the main app gets
used for most — with the parts of the menu bar that actually get used (clock,
Wi-Fi, battery) replacing what it covers.

Open it from the **Studio tray menu → "Studio Dock"** (toggles).

`STRIP_W` (290px) is set by **covering the right end of the menu bar** — the
system clock and Control Center disappear behind the Dock rather than sitting
above it — not by the content.

Top to bottom: the **3 most recently touched projects**, the selected one's **10
latest notes**, then Wi-Fi / Battery rows and the clock. The notes list is the
only flexible region, so a long note expands inside it rather than pushing the
clock off the screen.

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
| Wi-Fi / Battery | [`src/tools/system-controls.html`](../src/tools/system-controls.html) |
| (Tools menu only) | [`src/tools/projects.html`](../src/tools/projects.html) |

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

## Projects + notes (the main surface)

The Dock's primary job is reading notes — the thing the main app gets used for
most. No Rust was needed for it: `list_projects` and `read_notes` already exist.

- **Projects** — the 3 most recently *visited*, from the `project-visits` store
  (see below), each with its workspace color as a dot. Selecting one **only
  swaps the notes list**; it deliberately does *not* activate the project, so no
  apps launch and no Mode layout snaps just to glance at notes. The list
  re-orders on the `project-activated` event, so it's never a refresh stale.
- **Notes** — the 10 most recent from that project's `notes.json`, sorted by
  `createdAt`. Notes carry no *updated* timestamp, and a handful have no
  `createdAt` at all; those sort last rather than to the top.
- **Rows** show the title, falling back to the body's first line (dimmed) since
  many notes are untitled — a row is never blank. Image notes get a thumbnail
  via `convertFileSrc`; checklists and tables get an icon.
- **Clicking expands in place** and collapses on a second click, so reading a
  note never leaves the Dock. Rows are `div[role=button]`, not `<button>`: the
  expanded body contains `<div>`/`<ul>`/`<img>`, which a button may not contain.

### Refreshing

The Dock is always on screen, so it polls (`REFRESH_MS`, 5s) to pick up notes
written in the main app or by Claude, plus `visibilitychange`/`focus` to catch up
the moment it comes back into view, plus the `project-activated` event for the
visit order.

**Both renders are change-gated** — a signature over what's actually displayed —
because rendering is destructive (`innerHTML`) and a naive poll would fight the
user: dropping hover states, collapsing the expanded note, and resetting scroll
every few seconds. An idle tick touches no DOM at all (verified: tagged nodes
survive multiple cycles). `renderNotes` also carries `scrollTop` across a real
re-render, and a refresh never re-selects a project while one is already selected.

**Cmd+R reloads the Dock.** It has no chrome and no menu, and the tray item only
hides/shows the existing window — without this there's no way to pick up an edit
to `index.html` short of restarting Studio.

The standalone `projects.html` tool is still there and still in the Tools menu;
the Dock no longer opens it.

## Visit history (`project-visits`)

`record_project_visit` in `lib.rs` appends to a `project-visits` store on every
activation: most recent first, one entry per project (`{path, at}`), capped at 20.

It hooks **`activate_project_ex`**, not the Mode switcher's page, so every route
to a project is recorded — Mode switcher, tray menu, Projects overview — and none
can bypass it.

**Why it exists:** folder mtime is a poor proxy for "recently worked on". A
directory's mtime only moves when an entry is added, removed or renamed inside
it, and `save_notes` rewrites an existing `notes.json` in place — so editing
notes never touches the project folder's mtime. On the author's real projects
that put two of the three most-recently-noted projects (one 40 days stale, one
32) outside the Dock's top three. Projects with no recorded visit fall back to
folder-mtime order behind those that have one.

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
