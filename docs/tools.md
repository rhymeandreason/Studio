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

**Tokens over hardcoding:** use `var(--space-*)`, `var(--bg)`, `var(--surface)`, `var(--ink)`, `var(--radius)` etc. — never hardcode colors, spacing, or border-radius.

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

### Fully frameless style (no titlebar, no traffic lights, no shadow)

No native chrome at all.

1. In `open_tool_window_near` (`src-tauri/src/lib.rs`):

   ```rust
   if filename == "my-tool.html" {
       builder = builder
           .decorations(false)
           .shadow(false)
           .background_color(tauri::webview::Color(0xf7, 0xf5, 0xf0, 0xff)); // --bg
   }
   ```

2. Dragging needs a real `data-tauri-drag-region` element (CSS
   `-webkit-app-region: drag` alone doesn't work here) — put it on a spacer
   that fills empty header space, not on the header itself, so it doesn't
   swallow clicks on buttons/tabs:

   ```html
   <div class="tabstrip">
     <!-- tabs -->
     <div class="tabstrip-spacer" data-tauri-drag-region></div>
   </div>
   ```

3. No traffic lights means no close button — bind one:

   ```js
   window.addEventListener("keydown", (e) => {
     if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "w")) {
       getCurrentWindow().close();
     }
   });
   ```

4. Add to `src-tauri/capabilities/tools.json`:
   `core:window:allow-start-dragging`, `core:window:allow-close`.

5. `cargo check`, then restart `npm run tauri dev` (capability changes need a restart).

### Colored title bar style (Code Editor / Preview pattern)

The native title bar is transparent, `background_color` provides the color, and
the window title is the tool name rendered by macOS. The webview starts *below*
the title bar — you cannot draw into that zone from HTML, so there is no in-page
drag strip.

**When to use:** tools that want a project-tinted chrome (e.g. matching the repo's
Git window color) without a custom in-page header.

**Key insight:** `background_color` on `WebviewWindowBuilder` must be set at
window-creation time with the correct color — it cannot be updated later. So the
color must be resolved in Rust *before* `build()` is called, and passed to the
HTML as a `?color=` URL param so the page body matches it on first paint too.

#### To apply this style to a new tool:

1. Add `open_tool_window_with_color` call site in Rust, passing the color you
   want (e.g. via `git_color_for_path` or a stored workspace color):

   ```rust
   // In your open_* function:
   let color = git_color_for_path(app.clone(), file.clone());
   open_tool_window_with_color(&app, "tools/my-tool.html", &color);
   ```

   `open_tool_window_with_color` (in `src-tauri/src/lib.rs`) sets
   `TitleBarStyle::Transparent`, `background_color`, a non-empty title (derived
   from the filename), and appends `?color=<hex>` to the URL.

2. Keep the tool HTML free of any `#titlebar` div. The native title bar handles
   the text and drag; the webview starts at the toolbar. No `cargo check` changes
   needed beyond step 1.

3. If the tool is opened by another tool (like Preview is opened by Code Editor),
   accept a `color: Option<String>` parameter in the Rust command and forward it:

   ```rust
   #[tauri::command]
   fn open_my_preview(app: AppHandle, color: Option<String>) {
       match color.filter(|c| !c.is_empty()) {
           Some(c) => open_tool_window_with_color(&app, "tools/my-preview.html", &c),
           None    => open_tool_window(&app, "tools/my-preview.html"),
       }
   }
   ```

   Then pass the color from the calling tool's JS:
   ```js
   invoke("open_my_preview", { color: titleColor });
   ```

## Global-shortcut access (Spotlight launcher)

`src/tools/spotlight.html` is opened by a global keyboard shortcut
(Option+Space) instead of the tray, via `toggle_spotlight_window` in
`src-tauri/src/lib.rs` (registered through `tauri-plugin-global-shortcut`
in `.setup()`). It doesn't go through `open_tool`/`Tools.json`, so it's
hidden from the wrench-tray dropdown by default.

It's also the only window that's transparent + undecorated +
always-on-top, which needs the `macos-private-api` Cargo feature and
`"macOSPrivateApi": true` in `tauri.conf.json`. The page itself stays
visually empty except for a floating card (`#panel`), so unfilled window
space reads as transparent; losing focus hides the window
(`on_window_event` checks `window.label() == "spotlight"`). It has its own
capability file (`src-tauri/capabilities/spotlight.json`) rather than
reusing `tool-*`.

It lists both tools (`list_tools` command, wrapping `scan_tools`) and
projects (`list_projects`), merged and filtered client-side, launching via
`open_tool` / `open_project` depending on which was picked.

**Not yet included: Claude and Git.** Both are opened through separate
commands that don't fit the tools/projects list — `open_claude_window`
takes an optional per-project path, and `open_git_window` needs a specific
repo path, with no single "list all repos" source today. Worth revisiting
if Spotlight should cover them too.

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


