# Read first

You are an engineer who cares about design and UX. We're building modular customizeable desktop tools that are nicer in specific interactions than usual apps.
**Don't use sub-agents, this is a small codebase.** If you disagree, ask human first and state why.

macOS menu-bar app for designer-developers. Each **project** = a folder under
`~/Projects/` (`workspace.json` manifest, `notes.json`, `media/`, `artifacts/`).
Activating a project launches its apps + `claude`; the UI has tabs for media (a
non-destructive image editor), notes, workspace, and artifacts.


## Stack
- **Tauri v2** (Rust) + **vanilla JS/HTML/CSS**, no bundler. Most
  `#[tauri::command]`s + the tray live in `src-tauri/src/lib.rs`; the pure
  git-CLI commands are split out into `src-tauri/src/git.rs` (see docs/git.md).
  Claude subprocess/session logic shared with the companion app lives in
  `crates/studio-claude-core/` (edit it there, not in either lib.rs).
- Frontend `src/`: ES modules off `main.js`, `index.html`, `styles.css`. Design =
  "Runes" theme (Futura + Material Symbols); tokens in `src/tokens.css`
  (`@import`ed by styles.css, linked by tools); shared component CSS + `<studio-*>`
  web components in `src/kit/`.
- Vendored & offline (never CDN): `src/vendor/` — `marked`, `coloris`,
  `motion-one`, Material Symbols woff2.
- Native Swift helpers via `build.rs`, run as subprocesses: `bgremove` (Vision),
  `qlthumb`, `pbimage`, `winbounds` (CGWindowListCopyWindowInfo). WebP via the `webp` crate; HEIC via `sips`.

## Run
`npm install` then `npm run tauri dev`. macOS 14+ (Vision). Menu-bar app, no Dock
icon. Editing `src/` is live (reload the window); Rust changes need a restart.

## Subsystems (detail in each doc)
- **Design system** ( — tokens, kit classes, `<studio-*>` components) —
  [docs/DESIGN.md](docs/DESIGN.md)
- **Tools** (single-file HTML utilities in `src/tools/`, kit-styled) — **read [docs/tools.md](docs/tools.md)
  before creating or editing any tool**!,
- **Media + image editor** — `media.js`. [docs/media.md](docs/media.md)
- **Notes** — in `main.js`. [docs/notes.md](docs/notes.md)
- **Workspace** (per-project launchpad) — `workspace.js`. [docs/workspace.md](docs/workspace.md)
- **Server** (per-project dev-server start/stop tool with a running-state
  oscilloscope) — `src/tools/server.html`. [docs/server.md](docs/server.md)
- **Artifacts** (schema'd JSON design files under `artifacts/<kind>/`; Claude
  writes them, tools edit them, the panel shows them) — `artifacts.js`.
  [docs/artifacts.md](docs/artifacts.md)
- **Claude window** (in-app `src/claude/` + standalone `companion/`; per-session
  Artifacts/Code cwd toggle) — [docs/claude-window.md](docs/claude-window.md)
- **Git windows** — `src/git/`. [docs/git.md](docs/git.md)
- **Studio Dock** (full-height black strip on the right screen edge, above the
  menu bar; own clock/Wi-Fi/volume/battery controls) — `src-tauri/src/dock.rs` +
  `src/dock/`. [docs/dock.md](docs/dock.md)
- **Code Editor** (HTML/CSS/JS tool: DOM tree, inspector, git diff, syntax
  highlighting, separate preview window) — `src/tools/code-editor.html` +
  `code-preview.html`. [docs/code-editor.md](docs/code-editor.md)
- **Slides** (presentation builder: `presentation` + `theme` artifacts, shared
  renderer in `src/deck/`, Slides + Theme editor tools) — [docs/slides.md](docs/slides.md)
- **Diagrams** (`diagram` artifacts: templated concept diagrams, SVG renderer
  in `src/diagram/`, embeddable live in slides) — [docs/diagrams.md](docs/diagrams.md)
- **Video editor** (multi-clip edits as `videos/*.json`, text-animation +
  shader-background registries in `src/video/`, native export) —
  [docs/video.md](docs/video.md)
- **Interaction model** (shared selection + keyboard) — `selection.js` /
  `keymap.js`. [docs/interaction-spec.md](docs/interaction-spec.md)

## Non-obvious
- **`state.js`** is `export const state = {}` — globals shared *across* module
  boundaries (`activePanel`, `activeProject`, …). Feature-local state stays
  module-local.
- **Circular imports:** `main.js` / `media.js` / `workspace.js` import each other;
  eval-safe only because nothing calls across modules at eval time. New
  cross-module call → export+import it (no bare globals); a reassigned `let` used
  on both sides goes on `state`.
- **Window width is native:** `invoke("set_window_width", { width })`; CSS alone
  won't resize the window. (`body` is a flex row: `.app-left` + `.app-right`
  320px editor column.)
- **Clipboard** (no Tauri plugin): writes use the async Clipboard API — keep the
  write synchronous in the gesture (no `await` first; pass async work as a Promise
  inside the `ClipboardItem`). Reads go through Rust (`pbpaste`/`PBIMAGE_BIN`),
  never `navigator.clipboard.read()` (prompts per paste in WKWebView).
- **Internal drag-reorder** uses pointer events (Tauri's file-drop swallows HTML5
  drag); set `state.draggingNoteId` / `state.mediaDragActive` so the OS drop
  overlay stays suppressed.
- **Artifact formats** are documented for Claude in `skills/studio-artifacts/`
  (symlinked into `~/.claude/skills/`). Change the saved shape → update the skill.
- **Dev inspector:** Cmd+Option+Click any element → its CSS rule in Zed.
  [docs/devinspect.md](docs/devinspect.md)
- Saves are debounced (`scheduleNotesSave()` / `scheduleWorkspaceSave()` / …).
- **`TrayItems.json`** (repo root) overrides the tray icon order/icons defined
  in `tool_style`/`tray_item_order` in `lib.rs` — if it exists it *replaces*
  the code default wholesale, so adding a new tray icon in Rust also requires
  adding its `{ "id": ... }` entry here or it silently won't show.

## Conventions
- The human tests each step in the running app before committing. `cargo check`
  in `src-tauri/` after Rust edits.
- **Read docs/tools.md before making any tools.**
- When building new features, consider how the code can be modular and reusuable.
- Prefer native macOS frameworks. Project structure is convention, not enforced —
  tolerate missing subfolders.
- One user (the author), v0.1. The user is a designer who codes with Claude Code.
- Design principles are modularity and lightweight simplicity. Lean towards making the UX obvious and easy to edit. When proposing architecture, don't overdo it.
- Read the code and the linked docs for detail.