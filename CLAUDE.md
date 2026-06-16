# Studio — agent primer

A macOS menu-bar app for designer-developers: each **project** is a folder under
`~/Projects/`. Studio activates a project (launches its apps + `claude`), shows a
**media** grid with a non-destructive **image editor**, keeps lightweight
**notes**, and manages design **artifacts** (brand kits, etc.).

## Stack
- **Tauri v2** (Rust backend) + **vanilla JS/HTML/CSS** frontend (no bundler).
- Frontend: `src/` ES modules (loaded via `<script type="module" src="/main.js">`),
  `index.html`, `styles.css`. Design = warm "Runes" theme, Futura + Material
  Symbols. **Design tokens live in `src/tokens.css`** (`@import`ed by styles.css,
  linked by tools); shared component CSS + `<studio-*>` web components in
  `src/kit/`. Vendored libs in `src/vendor/`: `marked`, `coloris`, `motion-one`,
  and the Material Symbols woff2 (all offline, not CDN). See
  [docs/tools-dynamic-loading.md](docs/tools-dynamic-loading.md).
- Backend: `src-tauri/src/lib.rs` (all `#[tauri::command]`s + the tray).
- Native Swift helpers compiled by `src-tauri/build.rs`, called as subprocesses:
  `bgremove` (Vision background removal), `qlthumb` (QuickLook thumbnails),
  `pbimage` (clipboard image). WebP encoded via `webp` crate; HEIC via `sips`.

### Frontend modules (`src/`)
The frontend is split into ES modules:
- `main.js` — app shell: boot, `render()`/`selectTab()`, notes, projects, modals,
  the keyboard dispatcher install.
- `workspace.js` — the **Workspace tab**. See [docs/workspace.md](docs/workspace.md).
- `artifacts.js` — the **Artifacts tab**: lists/previews design artifacts and
  opens them in their editor tool. See [docs/artifacts.md](docs/artifacts.md).
- `media.js` — the **whole media subsystem**: grid, selection, image editor,
  lightbox, export, tools (remove-bg, extend, generate). See [docs/media.md](docs/media.md).
- `state.js` — `export const state = {}`: mutable globals shared **across
  module boundaries** (`activePanel`, `activeProject`, `activeItem`,
  `notesData`, etc). Feature-local mutable state stays as module-locals.
- `selection.js` — `createSelection({mode, onChange})` primitive (see
  [docs/interaction-spec.md](docs/interaction-spec.md)).
- `keymap.js` — `keyName` normalization, `isEditableTarget`, the
  `installKeyDispatcher`, and the `panelKeymaps`/`globalKeymap` registry.
- `dom.js` (`el`/`mi`/`genId`/`clamp`), `imageutil.js`, `gl.js` (WebGL tonal
  pipeline), `themes.js` (note card themes/fonts).
- `main.js`, `media.js`, and `workspace.js` **import each other** (circular).
  It's eval-safe because only hoisted function declarations cross at
  module-eval time; no cross-module calls run at the top level. When adding a
  cross-module call, export it and import it (don't reach for a bare global) —
  and if it's a reassigned `let` used on both sides, move it onto `state`.

## Run
`npm install` then `npm run tauri dev`. macOS 14+ only (Vision). It's a menu-bar
app — no Dock icon; click the tray icon. Test projects live in `~/Projects/`.

## Architecture essentials
- **Project = folder**; manifest `workspace.json`, notes `notes.json`, media in
  `media/`.
- **Layout:** `body` is a flex row with `.app-left` (flex: 1 1 auto, full app)
  and `.app-right` (flex: 0 0 320px, editor column). Window width is controlled
  via `invoke("set_window_width", { width })` — CSS layout alone doesn't resize
  the native window.
- **Notes:** see [docs/notes.md](docs/notes.md).
- **Media + image editor:** see [docs/media.md](docs/media.md).
- **Workspace:** per-project launchpad. See [docs/workspace.md](docs/workspace.md).
- **Claude window:** in-app chat UI (`src/claude/`) driving the `claude` CLI, and
  a standalone companion app (`companion/`). A per-session **Artifacts/Code**
  toggle picks the cwd (project folder vs git repo). See
  [docs/claude-window.md](docs/claude-window.md).
- **Artifacts:** schema'd JSON design files under `<project>/artifacts/<kind>/`
  (brand kits, etc.) — Claude writes them, tools edit them, the Artifacts panel
  shows them. Formats are documented for Claude in the `studio-artifacts` skill
  (`skills/studio-artifacts/`, symlinked into `~/.claude/skills/`). See
  [docs/artifacts.md](docs/artifacts.md).
- **Git windows:** bright per-repo windows (`src/git/`) — branch, changed files,
  commit. Launched from the Workspace repo card. See [docs/git.md](docs/git.md).
- **Interaction model:** shared selection + keyboard model across all panels.
  See [docs/interaction-spec.md](docs/interaction-spec.md).
- **Tools:** small built-in HTML utilities (`src/tools/`), styled with the kit;
  `kit-gallery.html` is the living styleguide. See [docs/tools.md](docs/tools.md)
  and [docs/tool-ideas.md](docs/tool-ideas.md).

## Cross-cutting patterns
- All Tauri commands use `invoke()`. Saves are debounced
  (`scheduleNotesSave()` / `scheduleWorkspaceSave()` / `scheduleMediaMeta`-style).
- **Clipboard:** No Tauri clipboard plugin. **Writes** use the async Clipboard
  API (`ClipboardItem`) — keep the write synchronous in the gesture (no `await`
  before it; pass async work as a Promise inside the item). **Reads** go
  through Rust (`pbpaste`/`PBIMAGE_BIN`), never `navigator.clipboard.read()`
  (it prompts per paste in WKWebView).
- **Dev inspector:** Cmd+Option+Click any element to jump to its CSS rule in
  Zed. See [docs/devinspect.md](docs/devinspect.md).
- Internal drag-reorder uses **pointer events** (Tauri's native file-drop
  swallows HTML5 dragover/drop); set `state.draggingNoteId`/`state.mediaDragActive`
  during an internal drag so the OS file-drop overlay stays suppressed.

## Conventions
The human tests each step in the running app before committing. `cargo check` in `src-tauri/` after Rust edits.
Prefer native macOS frameworks over custom code.
Project folder structure is convention, not enforced. Tolerate missing subfolders gracefully.
The user is a designer who codes with Claude Code as primary tool.
The target is one user (the author) for v0.1.
