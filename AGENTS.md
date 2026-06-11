# Studio — agent primer

A macOS menu-bar app for designer-developers: each **project** is a folder under
`~/Projects/`. Studio activates a project (launches its apps + `claude` in the
repo), shows a **media** grid with a non-destructive **image editor**, and keeps
lightweight **notes**. 

## Stack
- **Tauri v2** (Rust backend) + **vanilla JS/HTML/CSS** frontend (no bundler).
- Frontend: `src/` ES modules (loaded via `<script type="module" src="/main.js">`),
  `index.html`, `styles.css`; vendored libs in `src/vendor/` (`marked`). Design =
  warm "Runes" theme, Futura + Material Symbols.
- Backend: `src-tauri/src/lib.rs` (all `#[tauri::command]`s + the tray).

### Frontend modules (`src/`)
The frontend is being split out of the original monolithic `main.js`:
- `main.js` — app shell: boot, `render()`/`selectTab()`, notes, projects,
  modals, the keyboard dispatcher install. (~1800 lines)
- `workspace.js` — the **Workspace tab** (launch, form, editor picker, memory
  display, autosave, tab pinning). See `docs/workspace.md`.
- `media.js` — the **whole media subsystem**: grid, tiles, selection, sort +
  drag-reorder, the image editor (tonal/crop/geometry, WebGL), lightbox,
  export, and the tools (remove-bg, extend, generate). (~2600 lines)
- `state.js` — `export const state = {}`: the mutable globals shared **across
  module boundaries** (`activePanel`, `activeProject`, `activeItem`,
  `notesData`, `notesProjectPath`, `draggingNoteId`, `mediaDragActive`).
  Feature-local mutable state stays as module-locals in its own file.
- `selection.js` — `createSelection({mode, onChange})` primitive (see below).
- `keymap.js` — `keyName` normalization, `isEditableTarget`, the
  `installKeyDispatcher`, and the `panelKeymaps`/`globalKeymap` registry.
- `dom.js` (`el`/`mi`/`genId`/`clamp`), `imageutil.js`, `gl.js` (WebGL tonal
  pipeline), `themes.js` (note card themes/fonts).
- `main.js`, `media.js`, and `workspace.js` **import each other** (circular).
  It's eval-safe because only hoisted function declarations cross at
  module-eval time; no cross-module calls run at the top level. When adding a
  cross-module call, export it and import it (don't reach for a bare global) —
  and if it's a reassigned `let` used on both sides, move it onto `state`.
- Status/plan for the remaining split (notes/projects) is in
  `BACKLOG.md` → "Full file-split refactor".
- Native Swift helpers compiled by `src-tauri/build.rs`, called as subprocesses:
  `bgremove` (Vision background removal), `qlthumb` (QuickLook thumbnails),
  `pbimage` (clipboard image). WebP encoded via `webp` crate; HEIC via `sips`.

## Run
`npm install` then `npm run tauri dev`. macOS 14+ only (Vision). It's a menu-bar
app — no Dock icon; click the tray icon. Test projects live in `~/Projects/`.

## Architecture essentials
- **Project = folder**; manifest `workspace.json`, notes `notes.json`, media in
  `media/`. Image edits are **non-destructive**: stored in `<image>.studio.json`
  sidecars, baked only on export.
- Editor: geometry (crop/rotate/straighten) + 7 tonal sliders via a **WebGL
  shader**; thumbnails for edited images are baked + disk-cached
  (`$APPCACHE/edited-thumbs`), unedited use QuickLook.
- FSEvents (`notify`) emits `fs-changed`; the grid reconciles (don't rebuild —
  it duplicated tiles before). Tray/window events drive activation.

**Layout:** `body` is a flex row with `.app-left` (flex: 1 1 auto, full app) and `.app-right` (flex: 0 0 320px, editor column). Window width is controlled via `invoke("set_window_width", { width })` — CSS layout alone doesn't resize the native window.

**Notes:** Stored in `notes.json` per project; `state.notesData` is the in-memory
store, `renderNotes()` fully re-renders the bento grid from it. Note kinds:
`text` / `checklist` / `table` / `image`. Image notes store a project-relative
`src` (`notes/<id>.<ext>` for note-owned assets, or `media/…` referenced in
place) — never inline base64. Per-note styling (theme/fonts/span) is applied as
scoped CSS variables on the card; the project-wide font preference is
`notesData.font`/`fontSize` via `--notes-font`/`--notes-font-size` on
`#notes-list`. The grid is a **bento layout** — `layoutBento()` measures card
heights and sets row-spans, so re-pack on any height change (and after a panel
becomes visible — hidden elements measure as 0).

**Workspace:** Per-project launchpad (repo/figma/apps/files/folders/urls cards
+ Launch button), stored in `workspace.json`. See `docs/workspace.md` for
storage format, `LIST_META`, the editor picker, and the launch flow.

**Claude window:** In-app chat UI (`src/claude/`) driving the `claude` CLI as a
per-session subprocess over stream-json — a custom front end alternative to
`claude.mode: "terminal"`. See `docs/claude-window.md` for the window
capability, process/streaming model, sessions, usage bars, and permission mode.

**Interaction model (interaction-spec):** All four panels (Projects, Workspace,
Media, Notes) share one selection + keyboard model. See
`docs/interaction-spec.md` for the full design.
- **Selection:** each panel owns a `createSelection({mode, onChange})` instance
  (`notesSelection`, `mediaSelection`, `projectsSelection`, `workspaceSelection`).
  Multi-select with click / Cmd-click (toggle) / Shift-click (range). The panel
  repaints `is-selected` from the selection's `onChange`. (There is **no**
  `selectedNoteId` anymore.)
- **Keyboard:** one `document` keydown dispatcher (`installKeyDispatcher`) gates
  once (`isEditableTarget`, `anyModalOpen`) then routes the normalized key to
  `panelKeymaps[state.activePanel]` → `globalKeymap`. Register a panel's keys via
  `panelKeymaps.<panel> = {...}`. `state.activePanel` is set by `selectTab()`.
- **Click-off deselect:** shared `installOffClickDeselect({panel, keep, ...})`
  — clears on clicks in the panel or `#project-header`, but never on `#tabs` (so
  selection survives tab switches). New panels should use it.
- **Modals** are detected by the `.modal` class; Escape closes the topmost.

**Clipboard:** No Tauri clipboard plugin. **Writes** use the async Clipboard API
(`ClipboardItem`) — keep the write synchronous in the gesture (no `await`
before it; pass async work as a Promise inside the item). **Reads** go through
Rust (`pbpaste`/`PBIMAGE_BIN`), never `navigator.clipboard.read()` (it prompts
per paste in WKWebView). Notes copy/paste carries a Studio-native payload via an
**app-cache sidecar file** (`set_note_clipboard`/`get_note_clipboard`) keyed to
the degraded clipboard text — WebKit strips custom HTML on clipboard write, so an
HTML flavor can't carry it.

**Asset protocol:** images display via `convertFileSrc()`. The scope in
`tauri.conf.json` (`assetProtocol.scope`) must list paths — note that the glob
`**` does **not** match leading-dot files, so dotfiles (e.g. `.studio-icon.png`)
need an explicit scope entry.

**Patterns:** All Tauri commands use `invoke()`. Saves are debounced
(`scheduleNotesSave()` / `scheduleWorkspaceSave()` / `scheduleMediaMeta`-style).
Internal drag-reorder uses **pointer events** (Tauri's native file-drop swallows
HTML5 dragover/drop); set `state.draggingNoteId`/`state.mediaDragActive` during
an internal drag so the OS file-drop overlay stays suppressed.

## Conventions
The human tests each step in the running app before committing. `cargo check` in `src-tauri/` after Rust edits. 
Prefer native macOS frameworks over custom code.
Project folder structure is convention, not enforced. Tolerate missing subfolders gracefully.
The user is a designer who codes with Claude Code as primary tool.
The target is one user (the author) for v0.1.
