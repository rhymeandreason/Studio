# Tools

"Tools" are small single-purpose widgets (unit converter, bento grid maker,
git diff viewer, icon maker, …) that don't belong as panels in Studio's main
window but are still useful to have one click away.

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
  { "file": "unit-converter.html" }
]
```

- `file` — filename relative to `src/tools/` (required).
- `name` — label shown in the tray menu (optional; defaults to the filename
  without `.html`).
- Entries are shown in the order listed. Files not in the list are hidden.
- If `Tools.json` is missing or invalid, Studio falls back to scanning all
  `*.html` files in `tools/`.

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

## Title bar conventions

By default tool windows get a normal title bar showing the file's stem (e.g.
`bento-grid.html` → "bento-grid"). A tool can opt into a custom look by
special-casing its filename in `open_tool_window_near`
(`src-tauri/src/lib.rs`):

- **Untitled / blank title bar** — pass an empty string to `.title(...)`.
  Used by `daily-notes.html` since "daily-notes" adds nothing for a small
  utility window.
- **Title bar tinted to match the tool's background** — set
  `.title_bar_style(TitleBarStyle::Transparent)` and
  `.background_color(Color(r, g, b, 255))` to the tool's own `--bg`. This
  makes the traffic-light area blend into the page instead of showing the
  default black/white bar; pair it with extra top padding (~34px) on the
  tool's first visible element so content doesn't sit under the traffic
  lights, and `data-tauri-drag-region` on that element so the window is still
  draggable.

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

## Other options considered

For future tools that outgrow a single HTML file, options in increasing
order of effort:

1. **Tray-launched HTML window (current approach)** — zero build step, just
   drop a file in `src/tools/`. Best for quick, self-contained widgets that
   want project-aware saves via `save_tool_export`.
2. **System default browser** — `open`/`tauri-plugin-opener` on the file.
   Even simpler, but it's a browser tab with browser chrome, no IPC, and no
   project-aware save.
3. **Separate standalone Tauri app** — its own folder/repo, own
   `src-tauri/`, built and run independently. Worth it only if a tool needs
   real native capabilities (filesystem access beyond its own files,
   subprocesses, etc.) beyond what a `tauri://` webview window can get.

Start with (1); reach for (3) only when a tool's needs outgrow what a
webview window can do.
