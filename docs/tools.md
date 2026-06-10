# Tools

"Tools" are small single-purpose widgets (unit converter, bento grid maker,
git diff viewer, icon maker, …) that don't belong as panels in Studio's main
window but are still useful to have one click away.

## How it works

- Drop a self-contained `.html` file into `~/Projects/Tools/` (plain HTML +
  inline `<style>`/`<script>`, no build step).
- It appears in the **tray menu** (🔧 *name*).
- Clicking it opens the file in its **own native window** (a Tauri
  `WebviewWindow` pointed at the local `file://` path) — not a browser tab.
  Clicking again focuses the existing window instead of opening a duplicate.
- The list refreshes automatically when `~/Projects/Tools/` changes (same
  FSEvents watcher that refreshes the project list).

Implementation: `scan_tools` / `open_tool_window` in
[`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs).

## Choosing which tools show (`Tools.json`)

By default every `*.html` file in `~/Projects/Tools/` shows up, sorted
alphabetically. To control which tools appear and in what order, edit
[`Tools.json`](../Tools.json) at the root of the Studio project:

```json
[
  { "file": "bento-grid.html", "name": "Bento Grid" },
  { "file": "unit-converter.html" }
]
```

- `file` — filename relative to `~/Projects/Tools/` (required).
- `name` — label shown in the tray menu (optional; defaults to the filename
  without `.html`).
- Entries are shown in the order listed. Files not in the list are hidden.
- If `Tools.json` is missing or invalid, Studio falls back to scanning all
  `*.html` files.

`Tools.json` is bundled as a Tauri resource (see `bundle.resources` in
`src-tauri/tauri.conf.json`), so **changes require a rebuild/restart of
Studio** to take effect — unlike `~/Projects/Tools/*.html` itself, which is
picked up live.

## Other options considered

For future tools that outgrow a single HTML file, options in increasing
order of effort:

1. **Tray-launched HTML window (current approach)** — zero build step, just
   drop a file in `~/Projects/Tools/`. Best for quick, self-contained
   widgets with no native/Rust needs.
2. **System default browser** — `open`/`tauri-plugin-opener` on the file.
   Even simpler, but it's a browser tab with browser chrome, not an app
   window.
3. **Separate standalone Tauri app** — its own folder/repo, own
   `src-tauri/`, built and run independently. Worth it only if a tool needs
   real native capabilities (filesystem access beyond reading itself,
   subprocesses, etc.) that a sandboxed `file://` window can't get.

Start with (1); reach for (3) only when a tool's needs outgrow what a static
HTML file can do inside a webview.
