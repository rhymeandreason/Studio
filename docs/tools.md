# Tools

"Tools" are small single-purpose widgets (bento grid maker,
git diff viewer…) that don't belong as panels in Studio's main
window but are still useful to have one click away.

 For how tools, Claude, and the designer collaborate through shared **artifacts**, see [docs/artifacts.md](artifacts.md).

## Using the design-system kit

Every tool must link these in `<head>`, in order:

```html
<link rel="stylesheet" href="../tokens.css" />
<link rel="stylesheet" href="../kit/kit.css" />
<script type="module" src="../kit/components.js"></script>
```

Then a local `<style>` for tool-specific overrides only — never rewrite what kit already provides. Endeavor to use the kit styles. Don't make override styles that are only a little different.

**Kit classes:** `.btn` / `.btn-primary` / `.btn-ghost` / `.btn-icon` · `.field` (input, select, textarea) · `.range` · `.card` · `.label` · `.eyebrow` · `.title-strip` · `.text-body` / `.text-muted` / `.text-xs` / `.text-mono`

**Components:** `<studio-color>` — Coloris color picker with `.value` + `input`/`change` events.

**Motion:** `import { enter, exit, enterStagger, pop } from "../kit/motion.js"`

**Tokens over hardcoding:** use `var(--bg)`, `var(--surface)`, `var(--text)`, `var(--accent)`, `var(--radius)` etc. for colors and radii — never hardcode them. (There is no `--space-*` scale; follow the kit and use raw px for spacing.)

**Icons:** `<span class="material-symbols-rounded">icon_name</span>` (font loaded by `tokens.css`).

[`kit-gallery.html`](../src/tools/kit-gallery.html) (Tools → Design System) is the living reference. 

## How it works

- Drop a self-contained `.html` file into [`src/tools/`](../src/tools)
  (plain HTML + inline `<style>`/`<script>`, no build step).
- It appears under the **wrench (🔧) tray icon's** dropdown menu (🔧 *name*).
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

## Window style (title bar / chrome)

**One source of truth.** A tool's window look is decided by the `tool_style(filename)`
table in `src-tauri/src/lib.rs`, returning a `ToolStyle { w, h, empty_title,
chrome, tint }`. All three tool-window builders (`open_tool_window_near`,
`open_tool_window_with_color`, `open_tool`) route through `apply_tool_chrome()`,
so the style can't drift between them. To restyle a tool you edit *one* table
entry — never the builders.

`Chrome` has three variants:

- **`Native`** (default) — plain OS title bar showing the file's stem
  (`bento-grid.html` → "Bento Grid").
- **`NativeTint`** — transparent native title bar tinted to `tint`
  (`Tint::Paper` = `--bg`, or `Tint::Project` = the active project's color). The
  webview starts *below* the bar; the page can't draw into it. Used by the
  paper tools (Daily Notes, RAM, etc.) and Code Preview.
- **`Custom`** — fully custom: no native bar or traffic lights. The page paints
  its own draggable bar, close control, and rounded corners via the shared kit
  module (below). This is the target style for most project tools.

### Custom chrome (the `Custom` recipe)

Two halves — flip the table entry **and** convert the HTML; do both or the tool
opens with no way to drag or close it.

1. **Rust:** set the tool's `chrome` to `Chrome::Custom` in `tool_style`, with a
   `tint` (`Project` for project-scoped tools, `Paper`/`None` for globals) and
   `empty_title: true`. `apply_tool_chrome` then builds it with
   `decorations(false).transparent(true).shadow(false)` and passes the resolved
   color through as `?color=`. `cargo check` after.

   > `shadow(false)` is required: the native macOS shadow is drawn around the
   > *square* window bounds and reads as a 1px black border / square corners.

2. **HTML:** opt into the kit window chrome —

   ```html
   <link rel="stylesheet" href="../kit/window-chrome.css" />
   ...
   <script type="module" src="../kit/window-chrome.js"></script>
   ```

   and mark the tool's top bar element `data-window-bar`. The module reads
   `?color=` → sets `--titlebar-tint`/`--window-color`, makes the bar a Tauri
   drag region (buttons inside still click), injects a `.window-close` dot at
   the bar's left edge, wires Cmd/Ctrl+W, and rounds the corners. Tools that
   retint dynamically (Code Editor, per open file) just set `--titlebar-tint`
   themselves later.

3. **Rounded corners gotcha:** a background on `html`/`body` propagates to the
   square viewport (CSS "canvas background" quirk) and **ignores
   border-radius** — so corners stay square. Keep `html`/`body` **transparent**
   (window-chrome.css does this) and paint the opaque surface on the content
   rows *inside* body (e.g. Code Editor sets `#main { background: var(--bg) }`);
   body's `overflow:hidden` clip then rounds them, and the transparent corner
   pixels reveal the desktop.

The needed window permissions (`core:window:allow-start-dragging`,
`allow-close`, `allow-minimize`) are already granted to all `tool-*` windows in
`src-tauri/capabilities/tools.json`.

### Color / tint

`Tint::Project` resolves to the active project's accent (`active_git_color_hex`,
which prefers the workspace `color`, falling back to legacy per-repo
`git_color`). The color is encoded into the URL as `?color=<hex>` so the page
can paint its bar on the first frame — it can't be updated on the native bar
after `build()`, which is why `NativeTint` tools must resolve it up front too.

Code Editor / Preview are a paired example: the editor reads `?color=` and also
retints per open file (`git_color_for_path`), forwarding the color to the
Preview window over the Tauri event bus.

## "Spotlight" tools: global-shortcut transparent overlays

A handful of tools aren't tray-launched at all — they're full-screen
transparent overlays summoned by a global keyboard shortcut, with a
floating card/text centered on an otherwise-transparent window. Examples:

- **Spotlight launcher** — `src/tools/spotlight.html`, Option+Space.
  Lists tools (`list_tools`) + projects (`list_projects`), filtered
  client-side, launches via `open_tool` / `open_project`.
- **Mode switcher** — `src/tools/mode-switcher.html`, Ctrl+Space. Giant
  text list of the active project's Workspace Modes; arrows + Enter applies
  a mode's window layout via `apply_window_layout`.

They share the same plumbing. **The transparent + undecorated +
always-on-top window style needs the `macos-private-api` Cargo feature and
`"macOSPrivateApi": true` in `tauri.conf.json`** — already enabled, so new
overlays of this kind need no change there.

### To add a new Spotlight-type tool (e.g. `my-overlay.html`)

1. **HTML/CSS** — transparent page, content in a centered floating element
   (`#panel` in spotlight, `#circle` + `#list` in mode-switcher). Keep
   unfilled space transparent so only your card shows. Use these Tauri JS
   globals (no kit needed):

   ```js
   const { invoke } = window.__TAURI__.core;
   const { listen } = window.__TAURI__.event;
   const { getCurrentWindow } = window.__TAURI__.window;
   const win = getCurrentWindow();
   ```

   **Keyboard focus gotcha:** an undecorated transparent window won't deliver
   `keydown` unless a real, focusable, *visible* element holds focus. Give your
   selectable items `tabIndex = 0` and `.focus()` the active one (mode-switcher
   pattern) — a zero-opacity/1px hidden input is *not* reliable in WKWebView.
   Bind `Escape` to `win.hide()`.

2. **Rust toggle fn** (`src-tauri/src/lib.rs`) — copy `toggle_spotlight_window`:
   build once with `.transparent(true).decorations(false).always_on_top(true)
   .shadow(false).skip_taskbar(true).center().visible(false)`, then on later
   presses show/focus/hide and `emit("my-overlay-shown", ())` so the page can
   reload its data each open.

3. **Register the shortcut** in `.setup()` next to the existing
   `global_shortcut().register(...)` calls, and route it in the shared
   `with_handler` closure (match on `shortcut.mods` / `shortcut.key` to pick
   which overlay to toggle — see the Option+Space vs Ctrl+Space branch).

4. **Hide on focus loss** — add your label to the `on_window_event` check
   (`window.label() == "spotlight" || window.label() == "mode-switcher" …`)
   so clicking away dismisses it, like real Spotlight.

5. **Capability / permissions** — these windows do *not* match `tool-*`, so
   they don't inherit `src-tauri/capabilities/tools.json`. They share
   [`src-tauri/capabilities/spotlight.json`](../src-tauri/capabilities/spotlight.json).
   **Add your window label to its `"windows"` array**, or `win.hide()` (and any
   other `core:window:*` call) throws *"window.hide not allowed on window …"*
   at runtime:

   ```json
   "windows": ["spotlight", "mode-switcher", "my-overlay"],
   "permissions": ["core:default", "core:event:default", "core:window:allow-hide"]
   ```

   Add any extra perms your overlay needs (e.g. `core:window:allow-close`).
   **Capability changes need a full `npm run tauri dev` restart**, not just a
   window reload — easy to forget when debugging "why won't it close".

These overlays bypass `open_tool`/`Tools.json`, so they stay hidden from the
wrench-tray dropdown by default.

**Not yet included in Spotlight: Claude and Git.** Both open through separate
commands that don't fit the tools/projects list — `open_claude_window` takes
an optional per-project path, `open_git_window` needs a specific repo path,
with no single "list all repos" source today. Worth revisiting if Spotlight
should cover them too.

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

## Workspace Modes (record/play) need to know how to reopen your window

Workspace's record/play Modes (see [docs/workspace.md](workspace.md)) can
save a tool window as part of a layout and reopen it later — including on a
fresh Studio launch, before the user has opened that tool this session, when
the window doesn't exist yet to be found by label.

If your tool opens via `open_tool` (the generic command), or the existing
`open_tool_window`/`open_tool_window_near`/`open_tool_window_with_color`
helpers, **you don't need to do anything** — they already call
`track_tool_window(label, file, extra, kind)` internally, which is all
Workspace Modes needs.

You only need to act if you write a **fully custom window opener** — a new
`#[tauri::command]` that calls `WebviewWindowBuilder::new` directly instead
of going through those helpers (e.g. because your tool needs a bespoke label
scheme, like `open_git_pulse`'s repo-slug labels, or extra open-time
arguments, like `open_video_window`'s project path). In that case:

1. Call `track_tool_window(&label, file_or_blank, extra, "your-kind")` right
   after computing the window's label (before the "already open? just
   show/focus" early return, so re-opening keeps the entry fresh too).
2. Add a matching arm to the `match target.tool_kind.as_deref()` block in
   `apply_window_layout` (`src-tauri/src/lib.rs`) that calls your opener with
   whatever `extra` (stored as `tool_query`) holds.

Skipping this isn't a hard error — Play just silently does nothing for that
window if it wasn't already open, the same bug this was added to fix for
Code Editor, Code Preview, Git Pulse, the Claude window, Scheduled Tasks,
and the Video editor.

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

## Re-entrant render functions (avoid duplicated content on re-render)

If a `main()`/`render()` clears a container and rebuilds it with `await
invoke(...)`, and it can be triggered more than once that overlaps — initial
load plus a Tauri event listener (`project-activated`, etc.) — a slow call can
still be mid-`await` when a newer call clears and rebuilds too. Both then
append, duplicating the content (bit File Directory's tree this way).

**Fix:** a generation counter, checked after every `await` before touching the DOM:

```js
let renderGeneration = 0;

async function main() {
  const generation = ++renderGeneration;
  const data = await invoke('get_some_data');
  if (generation !== renderGeneration) return; // superseded by a newer call

  container.innerHTML = '';
  container.appendChild(buildSomething(data));
}
```

Only needed for render functions reachable from more than one trigger.

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


