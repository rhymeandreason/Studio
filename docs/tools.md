# Tools

"Tools" are small single-purpose widgets (bento grid maker,
git diff viewer…) that don't belong as panels in Studio's main
window but are still useful to have one click away.

 For how tools, Claude, and the designer collaborate through shared **artifacts**, see [docs/artifacts.md](artifacts.md).

## Using the design-system kit

Tools should look like Studio without re-inventing primitives. The shared kit
lives in [`src/kit/`](../src/kit) and is built on the tokens in `src/tokens.css`:

```html
<link rel="stylesheet" href="../tokens.css" />   <!-- Runes tokens + icon font -->
<link rel="stylesheet" href="../kit/kit.css" />   <!-- .btn / .field / .card / … -->
<script type="module" src="../kit/components.js"></script>  <!-- <studio-*> elements -->
```

- **`kit.css`** — component classes: `.btn` (`.btn-primary`/`.btn-ghost`/
  `.btn-icon`), `.field` (text, number, styled-native `<select>`, textarea),
  `.range`, `.card`, `.label`, `.title-strip`.
- **`components.js`** — custom elements with a native-like contract (`.value` +
  `input`/`change`). First one: `<studio-color>` (Coloris-backed color field).
- **`motion.js`** — `import { enter, exit, enterStagger, pop } from
  "../kit/motion.js"` for consistent animation (reads the `--dur-*`/`--ease-*`
  tokens; wraps the vendored Motion One).

[`kit-gallery.html`](../src/tools/kit-gallery.html) is the living styleguide —
open it (Tools → Kit Gallery) to see every class/component in use. For the
broader design-system plan (vendored libs, `<studio-*>` roadmap, host-injected
kit), see [tools-dynamic-loading.md](tools-dynamic-loading.md).

## How it works

- Drop a self-contained `.html` file into [`src/tools/`](../src/tools)
  (plain HTML + inline `<style>`/`<script>`, no build step).
- It appears in the **tray menu** (🔧 *name*).
- Clicking it opens the file in its **own native window**, loaded via
  `tauri://localhost/tools/<file>` (the same `tauri://` protocol the main
  window uses, since `src/` is `frontendDist`) — not a browser tab and not
  `file://`. Clicking again focuses the existing window instead of opening a
  duplicate.
- `file://` was tried first but doesn't work: those windows send
  `Origin: null`, which Tauri's IPC rejects with "Origin header not valid
  URL", so `invoke()` (and thus `save_tool_export`) can't be called.

`src/tools/` is also bundled as a Tauri resource (`bundle.resources` in
`src-tauri/tauri.conf.json`, alongside `Tools.json`) so the Rust side can
list available tools via `resource_dir()`. **Adding/editing tools requires a
rebuild/restart of Studio** — there's no live FSEvents refresh like the
project list has.

Implementation: `scan_tools` / `open_tool_window` in
[`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs).

## Choosing which tools show (`Tools.json`)

By default every `*.html` file in `src/tools/` shows up, sorted
alphabetically. To control which tools appear and in what order, edit
[`Tools.json`](../Tools.json) at the root of the Studio project:

```json
[
  { "file": "bento-grid.html", "name": "Bento Grid" },
  { "file": "unit-converter.html", "name": "Unit Converter" }
]
```

- `file` — filename relative to `src/tools/` (required).
- `name` — label shown in the tray menu (optional; defaults to the filename
  without `.html`).
- Entries are shown in the order listed. Files not in the list are hidden.
- If `Tools.json` is missing or invalid, Studio falls back to scanning all
  `*.html` files in `tools/`.



## Saving exports to the active project

Tool windows load over `tauri://localhost` (not `file://`), so browser save
dialogs (`showSaveFilePicker`) still aren't available in that context.
Instead, tool windows are granted the `core:default` Tauri capability (see
[`src-tauri/capabilities/tools.json`](../src-tauri/capabilities/tools.json),
matching window label `tool-*`) and can call:

```js
const path = await window.__TAURI__.core.invoke('save_tool_export', {
  filename: 'bento-grid.html', // no slashes, no leading dot
  content: '...',              // string content to write
});
```

If a project is active, this writes into its **`designs/` folder** (see
`save_tool_export` in `src-tauri/lib.rs`) and returns the saved path. If
**no project is active**, it opens a native save dialog
(`tauri-plugin-dialog`, `dialog:default` permission) and writes there
instead; if the user cancels that dialog, the command rejects with
`"__cancelled__"`, which `bento-grid.html`'s `saveFile()` treats as a no-op
(matching the old `AbortError` cancel behavior).

Falls back to `showSaveFilePicker` / browser download when not running
inside Studio (e.g. opened directly in a browser for testing).

## Window size

Tools default to 900×640. To override, call `setSize` at the top of the tool's
script — no Rust change needed:

```js
if (window.__TAURI__) {
  const { getCurrentWindow } = window.__TAURI__.window;
  const { LogicalSize } = window.__TAURI__.dpi;
  getCurrentWindow().setSize(new LogicalSize(1280, 700));
}
```

The `core:window:allow-set-size` permission is already granted to all `tool-*`
windows in `src-tauri/capabilities/tools.json`.

## Title bar conventions

By default tool windows get a normal title bar showing the file's stem (e.g.
`bento-grid.html` → "Bento Grid"). The user may ask for the 'Minimal window style', instructions below:

### Minimal window style

Empty native title + transparent `--bg`-tinted title bar, so OS chrome
disappears and the page owns the whole window. The tool provides its own title
in an in-page drag strip. To apply to a tool (e.g. `my-tool.html`):

1. In `open_tool_window_near` (`src-tauri/src/lib.rs`), add the filename to
   the `title` blank-string branch and add a `background_color` block:

   ```rust
   // title
   let title = if filename == "daily-notes.html" || filename == "my-tool.html" { … }

   // background color
   if filename == "my-tool.html" {
       builder = builder
           .title_bar_style(tauri::TitleBarStyle::Transparent)
           .background_color(tauri::webview::Color(0xf7, 0xf5, 0xf0, 0xff)); // --bg
   }
   ```

2. In the tool's HTML, add a drag strip as the **first element inside
   `<body>`**. Put any in-page title text inside it:

   ```html
   <div class="titlebar" data-tauri-drag-region>
     <div class="page-title">My Tool</div>
   </div>
   ```

   ```css
   .titlebar {
     height: 52px;          /* enough room for traffic lights + heading */
     display: flex;
     align-items: flex-end;
     padding-bottom: 10px;
     -webkit-app-region: drag;
   }
   .page-title { font-size: 16px; font-weight: 600; }
   ```

   Remove any top `padding` from `body` — the titlebar div provides the
   spacing instead. Run `cargo check` after the Rust edit.

## Dedicated tray icon + positioning

A tool can get its own tray icon (next to Studio's) instead of living only in
the Tools submenu — see the `"daily-notes-tray"` `TrayIconBuilder` in
`src-tauri/src/lib.rs`. Clicking it calls `open_tool_window_near(app, path,
Some(rect))`, where `rect` is the tray icon's rect from
`TrayIconEvent::Click`. `position_below_tray_icon` then places the window's
top-right corner at the icon's bottom-right, so the window opens directly
under the icon that was clicked (matching the usual macOS menu-bar-app
pattern). Reuses/refocuses the existing window (and re-positions it) if
already open, rather than opening a duplicate.

### Text-label tray icon (RAM overview)

A tray icon can also show a live **text label** in the menu bar instead of
(or alongside) an icon — see the `"ram-tray"` `TrayIconBuilder` in
`src-tauri/src/lib.rs`, used by `src/tools/ram-overview.html`. It's built
with `.title("X.X GB")` (macOS renders this as text next to the icon) and
`icon_as_template(true)` so the icon blends with light/dark menu bars. A
background thread (`start_ram_label_refresh`) calls `tray.set_title(...)`
every 5s with the current `get_memory_stats().system_used_gb`. Clicking the
icon opens `ram-overview.html` via `open_tool_window_near`, same
positioning as above — the small window shows the fuller breakdown (Studio
app RAM, dev server RAM, swap, top processes by RSS) and refreshes itself
every 5s while open.

### Configuring icon + order (`TrayItems.json`)

Studio's three menu-bar items — `"studio"` (main menu), `"ram"` (RAM
overview), and `"daily-notes"` — can be reordered and given custom icons via
[`TrayItems.json`](../TrayItems.json) at the root of the Studio project:

```json
[
  { "id": "studio" },
  { "id": "ram", "icon": "my-ram-icon.png" },
  { "id": "daily-notes" }
]
```

- Array order is left-to-right in the menu bar. macOS adds new items to the
  *left* of existing ones, so `build_studio_tray`/`build_ram_tray`/
  `build_daily_notes_tray` are called in **reverse** of this list at startup.
- `icon` is optional — a filename resolved against `src-tauri/icons/`
  (bundled as the `"tray-icons"` resource). Omit it to use each item's
  default icon.
- If `TrayItems.json` is missing/invalid, falls back to the default order
  `["studio", "ram", "daily-notes"]` with default icons.

Implementation: `tray_item_order` / `tray_item_icon` in
[`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs). Like `Tools.json`,
changes require a rebuild/restart of Studio — they're read once at startup
from the bundled resource copy, and tray icons are created during app
setup. Quitting and relaunching `npm run tauri dev` re-copies resources, so
that's usually enough without a full rebuild; if not, touch any `.rs` file
to force one.

**Future idea — hot reload**: watch `TrayItems.json` and `tray-icons/` (like
`start_watching` does for `~/Projects`) and, on change, destroy and rebuild
the affected tray icon(s) via `tray_by_id` + a fresh `build_*_tray` call,
instead of requiring a restart.

## How advanced is the tool?

1. **Tray-launched HTML window (current approach)** — zero build step, just
   drop a file in `src/tools/`. Best for quick, self-contained widgets that
   want project-aware saves via `save_tool_export`.
2. **Separate standalone Tauri app** — its own folder/repo, own
   `src-tauri/`, built and run independently. Worth it only if a tool needs
   real native capabilities (filesystem access beyond its own files,
   subprocesses, etc.) beyond what a `tauri://` webview window can get. Currently Studio Claude is built this way.

Start with (1); reach for (2) only when a tool's needs outgrow what a
webview window can do.

## Always-on-top / floating tools

A tool can float above all other windows by calling `setAlwaysOnTop(true)` from
JS — no Rust change needed:

```js
if (window.__TAURI__) {
  const { getCurrentWindow } = window.__TAURI__.window;
  getCurrentWindow().setAlwaysOnTop(true);
  getCurrentWindow().setResizable(false);
}
```

The `core:window:allow-set-always-on-top` permission is already granted to all
`tool-*` windows in `src-tauri/capabilities/tools.json`.

**Caveat:** always-on-top windows sit at `NSFloatingWindowLevel`, so they appear
first in the macOS compositor's window Z-order even when another window has
keyboard focus. Don't use AppleScript / Accessibility `first window` queries from
a floating tool — you'll get the tool itself back. Use `winbounds` instead (see
below).

## Querying on-screen window bounds (`winbounds`)

`src-tauri/swift/winbounds.swift` is a compiled Swift helper (built by `build.rs`,
exposed as `WINBOUNDS_BIN`) that calls `CGWindowListCopyWindowInfo` and prints the
topmost non-"Window Size" window as `AppName,Title,x,y,w,h` (compositor Z-order,
frontmost first). The Tauri command `get_focused_window_bounds` wraps it.

Use this instead of AppleScript when you need window positions/sizes from a
floating tool — CGWindowListCopyWindowInfo reads directly from the compositor and
isn't confused by window levels or key-window state.

**Permissions:** `CGWindowListCopyWindowInfo` requires Screen Recording permission
on macOS 10.15+ to return window *titles*. Bounds and app names are available
without it.

**Example** (`src/tools/window-size.html`) — polls every 500 ms, repositions
itself above the frontmost window, closes on Esc:

```js
const result = await invoke('get_focused_window_bounds'); // "App,Title,x,y,w,h"
const parts = result.split(',');
const [x, y, w, h] = parts.slice(-4).map(Number);
```

## Ideas

For the design discussion on adding tools **without a rebuild** and giving tools explicit **categories**, see [docs/tools-dynamic-loading.md](tools-dynamic-loading.md). 
For a brainstorm of tools to build next, see [docs/tool-ideas.md](tool-ideas.md).

## Custom tools from outside the repo

Not currently supported — only `*.html` files under `src/tools/` (bundled
into `frontendDist`) can be opened, because IPC/`save_tool_export` requires
the `tauri://localhost` protocol, and that protocol only serves embedded
`frontendDist` content.

To let users import a tool from an arbitrary folder later, the path is a
**custom URI scheme** (e.g. `tool://`) backed by a Rust handler that reads
from a user directory (e.g. `~/Library/Application Support/Studio/tools/`)
and serves it with a real origin — analogous to what `tauri://` does for
`frontendDist`. Windows using that scheme would need the same `tool-*`
capability grant for `save_tool_export` to keep working. Until that's built,
new tools have to live in `src/tools/` and ship with Studio.
