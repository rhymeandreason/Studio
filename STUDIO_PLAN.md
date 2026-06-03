# Studio — Project Plan (v0.1)

## What it is
A Mac menu-bar app for designer-developers whose primary creative tool is Claude Code. Each "project" is a folder that gathers a code repo, a Figma design, documentation media (screenshots, recordings, photos), and lightweight project notes — some held inside the folder (media, notes), some referenced where they already live (the repo path, the Figma URL). Studio activates a project's workspace (opens the right apps and files), shows a media-first panel of the project's documentation assets, provides quick image edit actions without launching Photoshop or Preview, and keeps a small set of project notes — free text, checklists, and a simple table.

## Why it exists
Adobe Creative Cloud promised a unified project surface across creative tools and never delivered. The gap has gotten worse for people whose workflow centers on Claude Code — code lives in a repo, designs live in Figma, documentation media (screenshots, screen recordings, photos of physical builds) scatter across Desktop / Downloads / random folders. No existing tool sees these as one thing. Studio fills that gap for a narrow but real user: designer-developers who work with Claude.

## Who it's for (concrete user profile)
- Builds things with Claude Code as the primary coding interface.
- Uses Figma sometimes for sketching, not as primary deliverable.
- Spends a meaningful portion of work time on documentation: cropping screenshots, annotating images, trimming screen recordings, organizing photos of physical prototypes.
- Has multiple parallel projects, switches between them several times a week.
- Wants the project to be more than the git repo — design files, raw photos, scratch work, and quick notes shouldn't go in git but belong with the project.
- Wants somewhere lightweight to jot a thought, keep a to-do checklist, or track a few rows of structured data — without opening Notion, Notes, or a spreadsheet app.

## Core model
- **Project = a folder** under `~/Projects/` (auto-discovered by scanning the directory).
- **Workspace = `.workspace.json` inside the project folder** — lists apps to launch, files to open, URLs, the Figma URL, and the repo path. Editable by hand or via Studio's UI. The project folder is a *hub*, not a container: it physically holds only the media, notes, and this manifest; the repo and Figma design live elsewhere and are referenced by path / URL.
- **Repo = a path in the manifest.** `.workspace.json` carries a `repo` field that can point anywhere — a `repo/` subfolder inside the project (the default for newly-created projects) *or* an absolute path to a git directory that already lives elsewhere (e.g. `~/code/lamp-firmware`). Claude Code / the terminal is invoked against this path. The code repo does not have to live inside the project folder.
- **Figma = a URL in the manifest, not a local file.** Figma files live in the cloud, so a project references its Figma design as a `figma` URL in `.workspace.json`, opened in the browser or Figma desktop app on activation. There is no local `.fig` file to manage.
- **Media = anything matching image/video/audio extensions** anywhere in the project hub (excluding noise dirs like `.git`, `node_modules`, `.studio`), surfaced in the media panel. Media inside an externally-referenced repo is not scanned — only what lives in the hub folder.
- **Notes = `.studio/notes.json`** inside the project folder — a small collection of note items. Each note is one of three kinds: **text** (freeform markdown), **checklist** (a titled list of `{text, done}` items), or **table** (a titled grid of columns + rows). One file holds all of a project's notes.

Suggested folder layout (not enforced, just convention):
```
~/Projects/lamp-prototype/
├── repo/              ← git, IF the repo lives inside the project (optional;
│                        the manifest's `repo` may instead point to ~/code/...)
├── designs/           ← local design scraps, mood boards (Figma itself is cloud)
├── media/             ← screenshots, recordings, workshop photos
├── .studio/
│   └── notes.json     ← text notes, checklists, tables
└── .workspace.json    ← what to launch (apps, repo path, figma URL, files, urls)
```
The repo and the Figma design are *referenced* by the manifest, not necessarily stored here. A minimal project folder is really just `media/`, `.studio/notes.json`, and `.workspace.json`.

## v0.1 scope (the smallest sharp version)

### 1. Project picker
- Menu bar icon.
- Click → dropdown listing folders in `~/Projects/`.
- Click a project → activates it (see workspace launcher).
- Shows currently active project at the top.

### 2. Workspace launcher
- Reads `.workspace.json` from the activated project.
- Opens apps, files, URLs listed in it.
- Schema (example):
  ```json
  {
    "apps": ["Cursor", "Figma"],
    "repo": "~/code/lamp-firmware",
    "figma": "https://figma.com/file/abc/Lamp",
    "files": ["designs/moodboard.png"],
    "urls": ["https://github.com/user/lamp-prototype"],
    "terminal": {
      "command": "claude",
      "cwd": "{repo}"
    }
  }
  ```
  - `repo` may be an absolute path (repo living elsewhere) or a path relative to the project folder (e.g. `"repo/"` for new projects).
  - `figma` is a cloud URL, opened in the browser / Figma app — not a local file.
  - `terminal.cwd` defaults to `{repo}` so Claude Code launches against the repo wherever it lives.
- For v0.1, "deactivating" the previous project does *not* close its apps (too risky). Activating just opens the new project's stuff on top.

### 3. Studio window (one per app, shows active project)
- Single window. Opens when you click the menu bar icon's "Open Studio" item or click a project.
- Three tabs or panels:
  - **Media** (default) — thumbnail grid of images/videos in the project, sorted by modified date desc.
  - **Notes** — a list of the project's notes (text, checklists, tables). Add, edit, reorder, delete.
  - **Workspace** — view/edit `.workspace.json` (form-based UI, not raw JSON).

### 4. Media panel actions
On right-click (or selection + toolbar):
- **Crop / resize** — opens an inline editor (HTML canvas), saves back to the original path or "Save As."
- **Annotate** — overlay arrows, text, boxes. Exports as PNG next to the original (`screenshot.png` → `screenshot-annotated.png`).
- **Copy path** — copies the absolute file path to clipboard, ready to paste into Claude Code.
- **Show in Finder** — standard reveal.

### 5. Notes panel
A single scrollable list of note items belonging to the active project, persisted to `.studio/notes.json`. Three note kinds:
- **Text note** — a title + freeform markdown body. Click-to-edit inline; renders markdown when not focused.
- **Checklist** — a title + a list of items, each a checkbox + label. Add/remove/reorder items, check items off. Shows a small "n of m done" count.
- **Table** — a title + named columns + rows. Add/remove columns and rows, edit any cell as plain text. No formulas, no types — just a grid of strings. Deliberately minimal (think a few columns, a handful of rows), not a spreadsheet engine.

Toolbar at the top of the panel: **+ Text**, **+ Checklist**, **+ Table**. Each note can be renamed, reordered (drag), and deleted. All edits autosave to `notes.json` (debounced).

Schema (example `.studio/notes.json`):
```json
{
  "version": 1,
  "notes": [
    { "id": "n1", "kind": "text", "title": "Ideas",
      "body": "Try a paper shade.\n\n- warm LED\n- dimmer" },
    { "id": "n2", "kind": "checklist", "title": "To buy",
      "items": [
        { "text": "M3 screws", "done": true },
        { "text": "USB-C cable", "done": false }
      ] },
    { "id": "n3", "kind": "table", "title": "Parts",
      "columns": ["Part", "Source", "Cost"],
      "rows": [
        ["LED strip", "Amazon", "$12"],
        ["Diffuser", "Hardware store", "$4"]
      ] }
  ]
}
```

### 6. Project creation
- "New Project" item in the menu bar dropdown.
- Asks for a name. Creates `~/Projects/<name>/` with empty `media/`, `designs/`, a `.studio/notes.json` seeded with an empty notes list, and a default `.workspace.json`.
- Leaves `repo` and `figma` blank in the new manifest. The user sets them afterward in the Workspace form — `repo` either by pointing at an existing git directory (`~/code/...`) or by creating a `repo/` subfolder. Studio does not `git init` for you.

## Explicitly out of v0.1
- File browser / Finder replacement (do not try to compete with Finder).
- Video editing beyond playback. Trim is v0.2 candidate.
- Registered/arbitrary *project-hub* locations. The hub folder is always discovered under `~/Projects/`. (The `repo` it references may live anywhere, including another disk — that's the one path allowed to point outside.)
- Multi-project simultaneous state.
- iCloud / Dropbox / Drive sync awareness.
- Tag-based hardware triggers (Runes integration — see future section).
- Sharing, exporting, publishing.
- Plugins or extensibility API.
- Cross-platform. macOS only.

## Tech stack
- **[Tauri v2](https://v2.tauri.app/) (Rust backend + web frontend)** — small bundle, fast cold start (<500ms), good macOS integration, transparent/decoration-free windows for the menu bar dropdown, file system access via `tauri-plugin-fs`.
- **Frontend: vanilla JS + HTML + CSS to start.** Add Svelte if state management gets painful, but don't reach for React.
- **Image editing in the browser: HTML `<canvas>`.** Use [Konva.js](https://konvajs.org/) for the annotation layer (arrows, text, transforms).
- **Markdown rendering (text notes): [`marked`](https://marked.js.org/)** or similar lightweight library.
- **Menu bar: `tauri-plugin-positioner` + `tray-icon`** (both standard Tauri ecosystem).
- **No database.** All project state lives in the project folder's `.workspace.json` and `.studio/notes.json`. Studio's own config (recently-used project, settings) goes in `~/Library/Application Support/Studio/config.json`.
- **App launching: `osascript`** (AppleScript via subprocess) for now. It's how every Mac automation tool does it.

## Build order
**Days are loose — call them "milestones." Realistic timeline is 1–2 weeks of evening/weekend work.**

1. **M1: Tauri scaffold + menu bar.** Icon in menu bar. Dropdown lists hardcoded "Hello." Clicking opens an empty Studio window. *Goal: prove the shell.*
2. **M2: Project discovery.** Scan `~/Projects/`. Menu bar dropdown shows real folder names. Clicking one stores it as "active." Studio window header shows active project name. *Goal: real project model.*
3. **M3: Media panel.** Window shows a thumbnail grid of images in the active project's folder (recursive, image extensions only). Skip noise dirs — `.git`, `node_modules`, `.studio` — so an in-folder `repo/` doesn't flood the grid. Click → preview at full size. *Goal: first useful surface.*
4. **M4: Crop / resize.** Right-click an image → modal with canvas + crop handles. Save back or save-as. *Goal: first documentation action.*
5. **M5: Annotation.** Konva-based overlay. Arrows + text + boxes. Export as `-annotated.png`. *Goal: the action you'll actually use most.*
6. **M6: Notes tab.** Read/write `.studio/notes.json`. Text notes first (markdown render + inline edit), then checklists, then the table. Autosave. *Goal: lightweight project notes.*
7. **M7: Workspace launcher.** Read `.workspace.json`. Open apps via `osascript`. Open files. Open URLs. *Goal: the Workspaces.app replacement.*
8. **M8: New project flow + workspace UI.** Create new projects from menu bar. Edit `.workspace.json` via a form, not raw JSON. *Goal: shippable to yourself.*

## Open questions for the human to decide (before / during build)
1. **Name.** Studio is the working title. Could be Atelier, Workshop, Notebook, anything.
2. **Activation behavior.** Activating a project: does it open in the existing Studio window or always pop a new one? Recommend: always open the active project in the one window.
3. **What counts as "media."** Just images and video? Audio? PDFs? Recommend: images + video + audio for v0.1. PDFs are their own rabbit hole.
4. **Claude Code launch.** Should the workspace launcher open a terminal and run `claude` at the manifest's `repo` path (wherever it lives)? It's nice but requires Terminal/iTerm automation. Recommend: yes for v0.1, via AppleScript to whichever terminal is set as default. Configurable.
5. **Notes storage.** One `.studio/notes.json` per project holding all note kinds (chosen here). Alternative: one file per note, or per-kind files. Recommend: single JSON file for v0.1 — simplest to load/save, easy to diff. Revisit if notes get large.
6. **Editing in place vs save-as.** Crop/annotate: default to save-as (non-destructive) or overwrite? Recommend: save-as by default, "Replace Original" as a checkbox.
7. **Distribution.** Just for the human or eventually shareable? Affects whether to invest in code signing / notarization. Recommend: don't worry about signing until v0.2.
8. **Annotation save format.** PNG only, or also keep an editable Konva JSON next to the image so you can re-edit later? Recommend: PNG for v0.1, editable JSON in v0.2 if you find yourself re-annotating.

## What Studio explicitly does *not* do (and where the limits are)
- It does not replace Figma, Photoshop, Cursor, or Claude Code. It orchestrates them.
- It does not own files. Files live in the project folder, editable by any other tool. Studio is a surface, not a vault.
- It does not version-control anything. Git stays git.
- It does not sync. The project folder is local. If you want sync, put `~/Projects/` in Dropbox / iCloud Drive yourself.

## Future integration: NFC hardware (Runes)
Not in v0.1 scope, but mentioned so the architecture leaves room:
- A separate background process (Runes) watches an NFC reader and emits `tag_scanned: {uid}` events.
- Studio will subscribe to these events (HTTP or WebSocket) and map UID → "activate project X."
- Tag management UI will become a panel in Studio. Each project's `.workspace.json` could gain a `tags: [uid1, uid2]` field.
- For v0.1, design the workspace activation function so it can be triggered programmatically (not only from the UI menu). That's the only forward-compatibility work needed.

## What a fresh Claude session needs to know to start
- This plan is the spec.
- The user is a designer who codes with Claude Code as primary tool.
- The target is one user (the author) for v0.1. Polish second, working third, shipping fourth.
- Don't over-architect. No tests beyond smoke testing for v0.1. No CI. No code signing.
- Tauri v2, vanilla JS frontend, Rust backend, AppleScript for Mac automation.
- Project folder structure is convention, not enforced. Tolerate missing subfolders gracefully.
