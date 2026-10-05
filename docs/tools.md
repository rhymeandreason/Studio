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
<link rel="stylesheet" href="../kit/window-chrome.css" />
<script type="module" src="../kit/components.js"></script>
<script type="module" src="../kit/window-chrome.js"></script>
```

**Window chrome is required.** Every tool window keeps the native macOS
frame (system corner radius + shadow) but with an Overlay title bar and the
traffic lights hidden (`apply_tool_chrome` / `build_tool_window` in
`src-tauri/src/lib.rs`), so the page runs under the bar area and must paint
its own bar: mark the tool's top bar element with `data-window-bar`, and its
leading group with `data-window-close` — window-chrome.js injects the close
dot there and wires Cmd+W and window dragging. macOS rounds the corners; don't
add a page-level border-radius. `file-directory.html` is the
reference. A `"window"` block on the tool's `Tools.json` entry is only needed
for a non-default window size or a project-colored tint.

Then a local `<style>` for tool-specific overrides only — never rewrite what kit already provides. Endeavor to use the kit styles. Don't make override styles that are only a little different.

**Kit classes:** `.btn` / `.btn-primary` / `.btn-ghost` / `.btn-icon` · `.field` (input, select, textarea) · `.range` · `.card` · `.label` · `.eyebrow` · `.title-strip` · `.text-body` / `.text-muted` / `.text-xs` / `.text-mono`

**Components:** `<studio-color>` — Coloris color picker with `.value` + `input`/`change` events.

**Motion:** `import { enter, exit, enterStagger, pop } from "../kit/motion.js"`

**Helpers:** `import { hasTauri, invoke, listen, esc, toast } from "../kit/app.js"`
— don't hand-roll a `window.__TAURI__?.core?.invoke` shim, an HTML-escaper, or
a toast per tool. `invoke`/`listen` are always functions (safe stand-ins in a
browser preview), so branch on `hasTauri`, never on `invoke` truthiness.
`toast(msg)` shows a transient `.kit-toast` pill (styled in kit.css). Requires
the tool's main script to be `<script type="module">`.

**Tokens over hardcoding:** use `var(--bg)`, `var(--surface)`, `var(--text)`, `var(--accent)`, `var(--radius)` etc. for colors and radii — never hardcode them. (There is no `--space-*` scale; follow the kit and use raw px for spacing.)

**Icons:** [Phosphor](https://phosphoricons.com), vendored unmodified in
`src/vendor/phosphor/` and loaded by `tokens.css`. Use Phosphor's own class API
plus `.mi` for Studio sizing: `<span class="mi ph ph-plus"></span>` (add `.mi-sm`
for 16px). From JS, use `mi("plus")` from `dom.js`, or set
`el.className = "mi ph ph-" + name` — icons are classes, not text, so never set
`textContent`. For the "on" state of a toggle, swap `ph` for `ph-fill` (same
`ph-<name>`). A misspelled name renders nothing. An icon Phosphor doesn't have
goes in `src/vendor/icons/` as an SVG with a `.mi-<name>` class in `tokens.css`:
`<span class="mi mi-svg mi-blur-on"></span>`.

[`kit-gallery.html`](../src/tools/kit-gallery.html) (Tools → Design System) is the living reference. 

**Headless tools.** A tool that has no UI of its own (the Color Picker — it *is*
macOS's sampler loupe) has `"kind": "headless"` in its `Tools.json` window: its window
is built with `visible(false)`, so the page skips the window chrome entirely,
does its work, and closes itself. Re-launching while one is running is a no-op.

**Floating tools.** A tool that is just a shape on the desktop (the Camera
Bubble — a FaceTime-style camera circle/square/portrait for screencasts) is
`"kind": "floating"` in its `Tools.json` window: `apply_tool_chrome` builds it
borderless, transparent, shadowless, always on top and on every Space, with no
kit window chrome. The page paints its own shape + CSS shadow and sizes/moves
the native window around it (`setSize` + `setPosition`). Like headless tools,
closing really closes it (`tools::is_disposable_label`) — for the camera that's
what turns the green light off. Its Tab background replacement sends small
frames through `person_mask` (`personseg.rs`, a raw-bytes pipe) to the
long-running `personseg` Swift helper (Vision) and composites the mask in a
canvas over the bubble's colored fill.

## How it works

- Drop a self-contained `.html` file into [`src/tools/`](../src/tools)
  (plain HTML + inline `<style>`/`<script>`, no build step).
- **Add it to [`Tools.json`](../Tools.json)** (`{ "file": "my-tool.html",
  "name": "My Tool" }`) — that file exists, so it's the whole list: a tool
  not in it won't show anywhere. **No restart:** in dev, Studio reads
  `Tools.json` and `src/tools/` straight from the checkout and watches them
  (`tools::watch`), rebuilding the wrench menu as soon as the list changes.
- It appears under the **wrench (🔧) tray icon's** dropdown menu (🔧 *name*)
  and is available to Spotlight (which shows its own curated `PINNED` subset —
  add the file there too if it belongs in the launcher).
- Clicking it opens the file in its **own native window**, loaded via
  `tauri://localhost/tools/<file>` (the same `tauri://` protocol the main
  window uses, since `src/` is `frontendDist`) — not a browser tab and not
  `file://`. Clicking again focuses the existing window instead of opening a
  duplicate.
- `file://` was tried first but doesn't work: those windows send
  `Origin: null`, which Tauri's IPC rejects with "Origin header not valid
  URL", so `invoke()` (and thus `save_tool_export`) can't be called.

**What still needs a restart:** only Rust — a new `#[tauri::command]`, a new
Swift helper, a capability/permission change, a global shortcut, a tray icon.
A pure-HTML tool (new, renamed, resized, retinted) never does.

**Planned — read this if your tool needs native code.** Studio is the author's
all-day app, so the goal is that new tools don't need a restart.
Done: the live `Tools.json` registry, CSS swapped in place, dev dependencies at
opt-level 3. Next, in order:

1. **Generic native helpers. Do this *instead of* adding the next per-tool
   Swift helper.** Today each helper is compiled by `build.rs` and gets its
   own command (`person_mask`, `web_area`, the color picker…), so every new
   native capability is a Rust change + restart. Replace that with two
   generic commands: `helper_run(name, args, stdin)` for one-shot helpers and
   a streaming `helper_pipe(name)` for long-running ones (the `personseg`
   pattern). Compile `src-tauri/swift/*.swift` with a script (`npm run
   helpers`) into a helpers dir resolved by name at call time. A new helper
   is then a `.swift` file + compile, no restart. Accept bare names only,
   never paths (tool windows could otherwise launch anything). It's
   CLAUDE.md's "dumb generic proxy" rule (`instagram_fetch`) applied to
   helpers.
2. **Installed release shell with live pages.** Do this once a stretch
   passes without `lib.rs` changes. A plain `tauri build` would *freeze* the
   pages (`frontendDist` is compiled into the binary), so every tool edit
   would mean a rebuild — worse than dev. Instead: release Rust, with the
   webviews loading `src/` from the checkout via a custom protocol. That
   gives optimized Rust, launch at login and no `tauri dev` terminal, with
   pages still live; Rust changes ship when you choose to rebuild. Rust work
   then runs a dev copy alongside under its own identifier
   (`com.studio.app.dev`) with global shortcuts and the Dock off, so the two
   don't fight over Option+Space, tray icons and the `~/Projects` watcher.
   Needs the helpers bundled (BACKLOG → Packaging).
3. **Hot-reload `TrayItems.json`** — same pattern as `refresh_tools_tray`
   (see the end of *Configuring icon + order* below). Low value: it rarely
   changes.

Release builds have no checkout: `src/tools/` and `Tools.json` are bundled as
Tauri resources (`bundle.resources` in `src-tauri/tauri.conf.json`) and read
from `resource_dir()` instead, fixed at build time.

Implementation: [`src-tauri/src/tools.rs`](../src-tauri/src/tools.rs) (the
registry: `listed`, `style`, `watch`) and `open_tool_window` /
`refresh_tools_tray` in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs).

## The tool registry (`Tools.json`)

[`Tools.json`](../Tools.json) at the root of the Studio project is the one
place a tool is registered: which tools appear, in what order, and how each
one's window is built. Rust has no per-tool table. **It exists, so every new
tool must be added here** — the scan-everything fallback only applies when
the file is missing.

```json
[
  { "file": "bento-grid.html", "name": "Bento Grid" },
  { "file": "plan.html", "name": "Plan", "window": { "w": 350, "h": 760, "tint": "project" } },
  { "file": "camera-bubble.html", "name": "Camera Bubble", "window": { "w": 232, "h": 232, "kind": "floating" } },
  { "file": "code-preview.html", "menu": false, "window": { "tint": "project" } }
]
```

- `file` — filename relative to `src/tools/` (required).
- `name` — label shown in the tray menu (optional; defaults to the filename
  without `.html`).
- `menu` — `false` keeps a tool out of the wrench menu and Spotlight while
  its `window` still applies (tools opened from elsewhere: Code Preview, the
  Dock's popovers, Git Pulse). Default `true`.
- `window` — all optional: `w` / `h` (logical px, default 900×640), `tint`
  (`"paper"` default, or `"project"` for the active project's color — see
  below), `kind` (`"normal"` default, `"headless"`, `"floating"`).
- Menu entries are shown in the order listed. Files not in the list are hidden.
- A save that doesn't parse (a stray comma, `"tint": "Project"`) is logged to
  the `tauri dev` terminal and the last good version is kept. `cargo test
  tools::` checks the checked-in file parses and every `file` exists.
- If `Tools.json` is missing, Studio falls back to scanning all `*.html`
  files in `tools/`.



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

**One source of truth.** A tool's window size + tint + kind come from its
`"window"` in `Tools.json` (read by `tools::style`). Every tool window is
built through `build_tool_window()` (= `apply_tool_chrome()` + `.build()` +
`hide_traffic_lights()`), so the chrome can't drift between builders. To
resize or retint a tool, edit its `Tools.json` entry — never the builders.
Takes effect the next time the window is built (close it, reopen).

The chrome is the same for all tools: **native frame, custom bar.**
`title_bar_style(Overlay)` + `hidden_title(true)` keep the real NSWindow
frame — system corner radius, shadow, resize edges — while the webview fills
the whole window, bar area included. The traffic lights are hidden after
build; the page paints its own tinted bar and close dot via the kit module.
(Video + Claude windows use the same recipe inline. Floating overlays —
Spotlight, Mode switcher, task-notify, the Dock — stay borderless:
`decorations(false).transparent(true).shadow(false)`.)

### Custom bar — the recipe

1. **`Tools.json`:** only if the tool needs a non-default size or the
   project tint, give its entry a `"window"`. The builders pass the resolved
   color as `?color=`. (Rust: build any new tool window via
   `build_tool_window`, not `.build()`, or the traffic lights show.)

2. **HTML:** link `../kit/window-chrome.css` after kit.css, `import
   "../kit/window-chrome.js"` in the module script, and mark the top bar
   `data-window-bar`. The module reads `?color=` → sets `--titlebar-tint` /
   `--window-color`, makes the bar a Tauri drag region (buttons inside still
   click), injects the `.window-close` dot (into a `[data-window-close]`
   element if the tool marks one, else at the bar's left edge), and wires
   Cmd/Ctrl+W. Remove any hand-rolled close button, Cmd+W handler,
   `data-tauri-drag-region`, or local titlebar CSS — the module owns those.

   > **Don't put live content in the bar.** When the tool is embedded as an
   > iframe (Git panel cards), `window-chrome.js` *removes* `[data-window-bar]`
   > outright — the host card has its own header. Anything the script reads or
   > writes there (a branch label, a status count) becomes a detached node
   > embedded-only, and the first `.textContent` on it throws mid-render, so the
   > card renders blank below the bar. Keep such elements in a row *below* the
   > bar; the bar is for the title alone.

3. **Runtime retint** (optional): `?color=` is applied automatically; a tool
   that retints later (Code Editor, per open file) sets `--titlebar-tint` on
   `documentElement` itself — through `washi(color)` from `../kit/washi.js`.
   `?color=` is the project's *vivid* color; anything that fills an area (bar,
   window background, a tinted card) paints its washi tint instead, and only
   small accents (dots, accent text) use the vivid color directly.

4. **Test in the running app** (restart only for a Rust change): no traffic
   lights, draggable bar, close dot + Cmd+W, native corners + shadow, tint
   matches the project.

The needed window permissions (`core:window:allow-start-dragging`,
`allow-close`, `allow-minimize`) are already granted to all `tool-*` windows
in `src-tauri/capabilities/tools.json`.

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
[`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs). Unlike `Tools.json`,
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
scheme, like `open_git_pulse`'s repo-slug labels or `open_code_editor_window`'s
per-project `tool-code-editor-html-<slug>` labels, or extra open-time arguments,
like `open_video_window`'s project path). In that case:

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



## WKWebView gotcha: CSS grid rows collapse under aspect-ratio tiles

Studio's WKWebView sized `grid-template-rows: auto` rows to ~18px for cards
whose height came from `aspect-ratio`, a percentage `padding-top`, or an
in-flow image with `aspect-ratio` — every card overlapped the next as a
"stacked sliver". Safari on the same machine laid the identical page out
fine, so don't trust a browser check for this. Instagram Saved's grid uses
flex-wrap with pixel-sized tiles (`--tile` set by a ResizeObserver) instead;
copy that pattern for any thumbnail grid.
