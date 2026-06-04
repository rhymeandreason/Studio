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
- **Workspace = `workspace.json` inside the project folder** — lists apps to launch, files to open, URLs, the Figma URL, and the repo path. Editable by hand or via Studio's UI. The project folder is a *hub*, not a container: it physically holds only the media, notes, and this manifest; the repo and Figma design live elsewhere and are referenced by path / URL.
- **Repo = a path in the manifest.** `workspace.json` carries a `repo` field that can point anywhere — a `repo/` subfolder inside the project (the default for newly-created projects) *or* an absolute path to a git directory that already lives elsewhere (e.g. `~/code/lamp-firmware`). Claude is pointed at this path on activation (see `claude.mode`). The code repo does not have to live inside the project folder.
- **Figma = a URL in the manifest, not a local file.** Figma files live in the cloud, so a project references its Figma design as a `figma` URL in `workspace.json`, opened in the browser or Figma desktop app on activation. There is no local `.fig` file to manage.
- **Media = anything matching image/video/audio extensions** anywhere in the project hub (excluding noise dirs like `.git`, `node_modules`), surfaced in the media panel. Media inside an externally-referenced repo is not scanned — only what lives in the hub folder.
- **Notes = `notes.json`** inside the project folder — a small collection of note items. Each note is one of three kinds: **text** (freeform markdown), **checklist** (a titled list of `{text, done}` items), or **table** (a titled grid of columns + rows). One file holds all of a project's notes.

Suggested folder layout (not enforced, just convention):
```
~/Projects/lamp-prototype/
├── repo/              ← git, IF the repo lives inside the project (optional;
│                        the manifest's `repo` may instead point to ~/code/...)
├── designs/           ← local design scraps, mood boards (Figma itself is cloud)
├── media/             ← screenshots, recordings, workshop photos
├── notes.json         ← text notes, checklists, tables
└── workspace.json     ← what to launch (apps, repo path, figma URL, files, urls)
```
The repo and the Figma design are *referenced* by the manifest, not necessarily stored here. A minimal project folder is really just `media/`, `notes.json`, and `workspace.json`.

## v0.1 scope (the smallest sharp version)

### 1. Project picker
- Menu bar icon.
- Click → dropdown listing folders in `~/Projects/`.
- Click a project → activates it (see workspace launcher).
- Shows currently active project at the top.

### 2. Workspace launcher
- Reads `workspace.json` from the activated project.
- Opens apps, files, URLs listed in it.
- Schema (example):
  ```json
  {
    "apps": ["Cursor", "Figma"],
    "repo": "~/code/lamp-firmware",
    "figma": "https://figma.com/file/abc/Lamp",
    "files": ["designs/moodboard.png"],
    "urls": ["https://github.com/user/lamp-prototype"],
    "claude": { "mode": "terminal" }
  }
  ```
  - `repo` may be an absolute path (repo living elsewhere) or a path relative to the project folder (e.g. `"repo/"` for new projects).
  - `figma` is a cloud URL, opened in the browser / Figma app — not a local file.
  - `claude.mode` controls how Claude is launched on activation:
    - `"terminal"` (default) — run the `claude` CLI in the default terminal, already `cd`'d into `repo` (auto cwd, via AppleScript to whichever terminal is set as default).
    - `"off"` — don't launch Claude; just open apps/files/URLs.
- For v0.1, "deactivating" the previous project does *not* close its apps (too risky). Activating just opens the new project's stuff on top.

### 3. Studio window (one per app, shows active project)
- Single window. Opens when you click the menu bar icon's "Open Studio" item or click a project.
- Three tabs or panels:
  - **Media** (default) — thumbnail grid of images/videos in the project, sorted by modified date desc.
  - **Notes** — a list of the project's notes (text, checklists, tables). Add, edit, reorder, delete.
  - **Workspace** — view/edit `workspace.json` (form-based UI, not raw JSON).

### 4. Media panel actions
The grid is the entry point; double-click (or select + "Edit") opens an **image editor** in the Studio window. Quick actions live on right-click / a selection toolbar; deeper editing lives in the editor.

#### 4a. Non-destructive adjustment model
The editor is **non-destructive**. Adjustments are stored as a small settings object, not baked into the file, until the user explicitly exports. This is what makes copy/paste-settings and re-editing possible.
- Adjustments for an image are kept in a sidecar: `<image>.studio.json` next to the original (e.g. `hero.png` → `hero.png.studio.json`).
- The original file is never modified by adjustments. "Export" / "Save As" renders the adjusted result to a new file; "Replace Original" (opt-in) overwrites.
- If no sidecar exists, the image shows unedited. Deleting the sidecar resets to original.

#### 4b. Adjustments (the editor)
A right-hand panel. Live canvas preview; **Reset** per-slider (double-click) and **Reset all**.

**Main items** (top of the panel, always visible):
- **Rotate** — 90° steps + horizontal/vertical flip.
- **Crop** — drag handles with aspect-ratio presets (free, 1:1, 16:9, 4:5…).

**Sliders** (always visible, each centered at 0):
- Exposure
- Contrast
- Saturation
- Temperature
- Tint
- Highlights
- Shadows

**Expanded panel** (collapsed by default, "More" disclosure):
- **Curves** — RGB master curve plus per-channel (R/G/B) curves.
- (Room to grow: straighten angle, whites/blacks, sharpening — added later only if wanted.)

#### 4c. Copy / paste settings
- **Copy adjustments** on one image → **Paste adjustments** onto one or more selected images. Writes/merges the source's `.studio.json` into each target's sidecar.
- Paste options: paste all, or paste a subset (e.g. just white balance + exposure) — useful for batch-correcting a set of screenshots or photos shot under the same light.

#### 4d. Remove background
- One-click **Remove background** → produces a transparent-background result.
- Runs **locally** (no upload) via an in-browser segmentation model (WASM). Result is previewed; export writes a PNG (transparency-preserving).
- Manual touch-up (add/erase mask) is a v0.2 candidate — v0.1 ships the automatic pass only.

#### 4e. Convert & export
- **Convert HEIC → PNG/JPG** — common for iPhone photos. One action, writes a sibling file (`IMG_1234.heic` → `IMG_1234.jpg`), original kept. Also offered automatically as a hint when a HEIC is opened.
- **Export for web** — resize to a target max dimension, pick format (WebP / JPG / PNG), quality slider, optional strip-metadata. Shows the resulting file size before saving. Writes a new file (e.g. `hero@web.webp`); never touches the original.

#### 4f. Quick actions (right-click, no editor)
- **Annotate** — overlay arrows, text, boxes. Exports as PNG next to the original (`screenshot.png` → `screenshot-annotated.png`).
- **Copy path** — copies the absolute file path to clipboard, ready to paste into Claude Code.
- **Copy image** — copies the (adjusted) image to the clipboard.
- **Show in Finder** — standard reveal.

### 5. Notes panel
A single scrollable list of note items belonging to the active project, persisted to `notes.json`. Three note kinds:
- **Text note** — a title + freeform markdown body. Click-to-edit inline; renders markdown when not focused.
- **Checklist** — a title + a list of items, each a checkbox + label. Add/remove/reorder items, check items off. Shows a small "n of m done" count.
- **Table** — a title + named columns + rows. Add/remove columns and rows, edit any cell as plain text. No formulas, no types — just a grid of strings. Deliberately minimal (think a few columns, a handful of rows), not a spreadsheet engine.

Toolbar at the top of the panel: **+ Text**, **+ Checklist**, **+ Table**. Each note can be renamed, reordered (drag), and deleted. All edits autosave to `notes.json` (debounced).

Schema (example `notes.json`):
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
- Asks for a name. Creates `~/Projects/<name>/` with empty `media/`, `designs/`, a `notes.json` seeded with an empty notes list, and a default `workspace.json`.
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
- **Image editing in the browser: HTML `<canvas>`.** Use [Konva.js](https://konvajs.org/) for the annotation layer (arrows, text, transforms). Tonal adjustments (exposure/contrast/curves/white balance) run as WebGL/canvas pixel operations; a small shader-based pipeline (or a lib like [glfx.js](https://github.com/evanw/glfx.js)) keeps the live preview fast.
- **Adjustments are non-destructive**, stored per-image in a `<image>.studio.json` sidecar. Export bakes them via canvas `toBlob`.
- **Background removal: local, in-browser.** [`@imgly/background-removal`](https://github.com/imgly/background-removal-js) (ONNX/WASM, runs offline). No image leaves the machine. First run downloads the model once and caches it.
- **HEIC conversion: macOS `sips`** via subprocess (`sips -s format jpeg in.heic --out out.jpg`) — built into macOS, no dependency. Same path can power "Export for web" resizing if canvas encoding proves limiting.
- **Markdown rendering (text notes): [`marked`](https://marked.js.org/)** or similar lightweight library.
- **Menu bar: `tauri-plugin-positioner` + `tray-icon`** (both standard Tauri ecosystem).
- **No database.** All project state lives in the project folder's `workspace.json` and `notes.json`. Studio's own config (recently-used project, settings) goes in `~/Library/Application Support/Studio/config.json`.
- **App launching: `osascript`** (AppleScript via subprocess) for now. It's how every Mac automation tool does it.

## Build order
**Days are loose — call them "milestones."** Realistic timeline is ~3–4 weeks of evening/weekend work, the bulk of it the media editor (M7–M12). The order front-loads the **project-hub daily driver** (M1–M5): after M5 Studio is genuinely usable — activate a project, launch its apps/Claude, keep notes — even before any image editing exists. The media editor then layers on as a self-contained block. Natural cut line for a first usable build: ship **M1–M6**, treat the editor (M7+) as a fast-follow.

*Project hub (makes Studio a usable daily driver):*
1. **M1: Tauri scaffold + menu bar.** Icon in menu bar. Dropdown lists hardcoded "Hello." Clicking opens an empty Studio window. *Goal: prove the shell.*
2. **M2: Project discovery.** Scan `~/Projects/`. Menu bar dropdown shows real folder names. Clicking one stores it as "active." Studio window header shows active project name. *Goal: real project model.*
3. **M3: New project flow + workspace UI.** Create new projects from the menu bar (scaffold `media/`, `designs/`, `notes.json`, default `workspace.json`). Edit `workspace.json` via a form (apps, repo, figma, files, urls, `claude.mode`), not raw JSON. *Goal: produce real, valid manifests from inside the app — the thing M4 consumes.*
4. **M4: Workspace launcher.** Read `workspace.json`. Open apps via `osascript`, open files/URLs, and launch Claude per `claude.mode` (default: run `claude` in the default terminal, `cd`'d into `repo`). *Goal: the core activation loop — the Workspaces.app replacement.*
5. **M5: Notes tab.** Read/write `notes.json`. Text notes first (markdown render + inline edit), then checklists, then the table. Autosave. *Goal: completes the hub — Studio is now dogfoodable.*

*Media editor (the documentation workhorse):*
6. **M6: Media grid + HEIC.** Thumbnail grid of images in the active project (recursive, image extensions only; skip `.git`, `node_modules`). HEIC decode/convert via `sips` happens here — it's a prerequisite for showing or editing iPhone photos at all, not a late add-on. Click → full-size preview. *Goal: first media surface, working on real iPhone files.*
7. **M7: Editor shell + crop/rotate + sidecar.** Open an image in the editor. Crop, straighten, rotate/flip. Establish the non-destructive `<image>.studio.json` sidecar and the Export / Replace-Original flow. *Goal: the editor skeleton + the file model everything else hangs on.*
8. **M8: Tonal adjustments.** The seven sliders — exposure, contrast, saturation, temperature, tint, highlights, shadows — with live canvas preview. Curves in the expanded panel. *Goal: real photo correction.*
9. **M9: Copy / paste settings.** Copy adjustments from one image, paste (all or subset) onto a selection. *Goal: batch consistency.*
10. **M10: Export for web.** Resize + format (WebP/JPG/PNG) + quality + size readout, writing a new file. *Goal: get images out in the right format.* (HEIC→PNG/JPG already landed in M6.)
11. **M11: Remove background.** Local WASM segmentation, transparent-PNG export. *Goal: the headline trick.*

## Decisions (settled) & open questions

**Settled:**
1. **Name.** Studio. (Working title kept as the real name for now.)
2. **Activation behavior.** One window — activating a project swaps its contents in the single Studio window.
3. **What counts as "media."** Images (incl. HEIC, converted on demand) + video + audio. No PDFs in v0.1.
4. **Claude launch.** Default `claude.mode: "terminal"` — run the `claude` CLI in the default terminal, auto-`cd`'d into `repo` (AppleScript). Per-project override to `"off"`. (Desktop-app launch dropped for v0.1 — terminal gives automatic cwd and avoids the folder-deep-link unknown.)
5. **Notes storage.** Single `notes.json` per project holding all note kinds. Revisit if notes get large.
6. **Editing model.** Non-destructive; adjustments in a visible `<image>.studio.json` sidecar; export writes a new file, "Replace Original" opt-in. Revisit sidecar clutter if it gets noisy.
7. **Background-removal model.** `@imgly/background-removal`, fetch-and-cache on first use (not bundled).
8. **Export-for-web encoding.** Start with canvas `toBlob`; switch to `sips`/`cwebp` only if quality/size disappoints.
9. **Distribution.** Personal use for v0.1; no code signing / notarization until v0.2.
10. **Annotation save format.** PNG only for v0.1; editable Konva JSON deferred to v0.2 if re-annotating becomes common.

**Still open:**
- *(None outstanding — the Claude desktop deep-link question is moot now that terminal mode is the default.)*

## What Studio explicitly does *not* do (and where the limits are)
- It does not replace Figma, Photoshop, Cursor, or Claude Code. It orchestrates them.
- It does not own files. Files live in the project folder, editable by any other tool. Studio is a surface, not a vault.
- It does not version-control anything. Git stays git.
- It does not sync. The project folder is local. If you want sync, put `~/Projects/` in Dropbox / iCloud Drive yourself.

## Future integration: NFC hardware (Runes)
Not in v0.1 scope, but mentioned so the architecture leaves room:
- A separate background process (Runes) watches an NFC reader and emits `tag_scanned: {uid}` events.
- Studio will subscribe to these events (HTTP or WebSocket) and map UID → "activate project X."
- Tag management UI will become a panel in Studio. Each project's `workspace.json` could gain a `tags: [uid1, uid2]` field.
- For v0.1, design the workspace activation function so it can be triggered programmatically (not only from the UI menu). That's the only forward-compatibility work needed.

## What a fresh Claude session needs to know to start
- This plan is the spec.
- The user is a designer who codes with Claude Code as primary tool.
- The target is one user (the author) for v0.1. Polish second, working third, shipping fourth.
- Don't over-architect. No tests beyond smoke testing for v0.1. No CI. No code signing.
- Tauri v2, vanilla JS frontend, Rust backend, AppleScript for Mac automation.
- Project folder structure is convention, not enforced. Tolerate missing subfolders gracefully.
