# Studio — Backlog

Deferred ideas and follow-ups, captured during the build. Not scheduled.

## Test Generative Expand
The code is still there, just hidden.

To test:

Launch Automatic1111 with the API on: ./webui.sh --api (add --listen if needed). Confirm http://127.0.0.1:7860/docs loads.
npm run tauri dev → image → Extend background → drag/pick ratio → optional prompt → Generative Fill.
If it still errors, the status line now shows the real response (SD <code>: <body>) — paste it and I'll adjust. Otherwise, once a fill comes back, tell me how the result looks and we can tune denoising_strength / inpainting_fill / mask_blur.

## UI / polish
- **Confirm Futura availability.** The type stack assumes Futura (a macOS system
  font). Confirm it's always present in the target environment, or ship/choose a
  fallback. (Material Symbols is now vendored — `src/vendor/material-symbols-rounded.woff2`
  + `@font-face` in `tokens.css` — so icons work offline.)

## Design-system kit (`src/kit/`)
Scaffold is in (tokens.css, kit.css, motion.js, `<studio-color>`, Kit Gallery —
see [docs/tools-dynamic-loading.md](docs/tools-dynamic-loading.md)). Follow-ups:
- **Theme the Coloris picker to Runes.** It currently shows Coloris's default
  look; map its `--clr-*` CSS variables to our tokens so the popover matches.
- **Host-inject the kit.** Have `open_tool_window_near` inject the tokens/kit CSS
  + `components.js` (via `.initialization_script()`) so every tool gets the design
  system without remembering to link it — and so it's reachable for future
  `tool://` (user-dir) tools at a stable `/_kit/…` URL.
- **Kit reference + starter template.** A one-page reference (every class/`<studio-*>`
  tag, attributes, events, snippets) cheap to drop into context, plus a "new tool"
  scaffold — the lever that makes Claude-generated tools consistent by default.
- **More `<studio-*>` components as needed.** Only build custom elements where
  native falls short (e.g. `<studio-slider>` for filled-track/value-bubble/dual
  handles; `<studio-select>` for rich options). Native-styled via `kit.css`
  otherwise. (Rationale + per-component calls in the design doc.)

## Artifacts
- **Install Studio skills for a shipped app.** Skills live in-repo
  (`skills/studio-artifacts/`) and are symlinked into `~/.claude/skills/` for dev.
  A packaged `.app` has no repo path — bundle the skills as resources and
  install/sync them into `~/.claude/skills/` on launch (copy, or symlink to the
  bundle). See [docs/artifacts.md](docs/artifacts.md).
- **Validate artifacts against the JSON Schema in Studio.** `save_artifact` (and
  the Brand Explorer / panel) currently read fields leniently; the
  `skills/studio-artifacts/schemas/*.schema.json` files are the source of truth.
  Validate writes against them so malformed artifacts are caught.
- **Stale CLAUDE.md blocks.** Early testing wrote a `studio:artifacts` managed
  block into some project CLAUDE.md files (since removed in favor of the skill).
  Harmless, but can be deleted from those projects.

## Tools
- **Brand Explorer: vendor chosen fonts (offline kit).** `brand-explorer.html`
  saves a JSON kit and previews fonts from the Google Fonts CDN. Optionally, on
  save, download the chosen families' woff2 into the project and emit `@font-face`
  so the exported kit needs no network (the "+ vendored font files" output option
  we deferred). Honors vendor-not-CDN end-to-end.
- **Brand Explorer: bigger / live font list.** Currently a curated ~60 baked in.
  Could expand the list or pull the full set via a keyless service
  (google-webfonts-helper) if coverage matters.

## Background removal
Current impl (on `main`): native macOS **Vision** via a Swift helper
(`src-tauri/swift/bgremove.swift`, `VNGenerateForegroundInstanceMaskRequest`),
compiled by `build.rs` and shelled out to by `remove_background`. Fast, offline,
no model download. The portable `ort`/ISNet version is preserved at tag
`bg-removal-ort`.
- **macOS 14+ requirement.** The Vision API and the Swift helper target
  `macosx14.0`. The helper exits non-zero on older OSes; set the app's minimum
  system version and/or surface a friendlier message.
- **"No subject found" UX.** When Vision finds no foreground subject the command
  errors and the editor shows "BG failed: …". Consider a gentler message.
- **Non-Mac builds.** If a Windows/Linux variant is ever wanted, restore the
  cross-platform `ort` implementation from tag `bg-removal-ort` (gate by
  `#[cfg(target_os)]`).

## Performance
- **Edited-thumbnail baking.** Unedited media now use QuickLook thumbnails
  (cheap, OS-cached). *Edited* images are still baked on the frontend by reading
  full-resolution pixels (read_image_data → decode → WebGL → toDataURL), cached
  per session — first view of a project with many edited images is still heavy.
  Optimize by baking adjustments on a downscaled base in Rust and/or persisting
  the baked thumbnails on disk (`$APPCACHE`) keyed by path + sidecar mtime.

## Future integration: NFC hardware (Runes)
Not in v0.1 scope, but mentioned so the architecture leaves room:
- A separate background process (Runes) watches an NFC reader and emits `tag_scanned: {uid}` events.
- Studio will subscribe to these events (HTTP or WebSocket) and map UID → "activate project X."
- Tag management UI will become a panel in Studio. Each project's `workspace.json` could gain a `tags: [uid1, uid2]` field.
- For v0.1, design the workspace activation function so it can be triggered programmatically (not only from the UI menu). That's the only forward-compatibility work needed.


## Packaging (before shipping a real `.app`)
- **Bundle the Swift helpers.** Three helpers — `bgremove`, `qlthumb`, `pbimage`
  — are compiled by `build.rs` into `target/.../build/.../out/` and located via
  `env!("…_BIN")`. Fine for `tauri dev`, but a packaged `tauri build` won't have
  those paths. Ship them as bundled resources / `.app` sidecars and resolve at
  runtime. They also hardcode `-target arm64`; add x86_64 for a universal build.
- **App minimum system version.** Set it to macOS 14 (Vision foreground mask),
  or gate that one feature and lower the floor.
- **Code signing / notarization.** Per the plan, deferred until there's a reason
  to distribute.

## Native macOS feature ideas (not started)
Studio is a thin native surface over your files, so prefer macOS frameworks.
- **Vision OCR** (`VNRecognizeTextRequest`, same framework as background
  removal). Extract text from screenshots → a "Copy text" action in the lightbox,
  and eventually make media searchable by their recognized text. High relevance
  for designer-devs who screenshot errors/UIs.
- **NSWorkspace for the launcher.** Replace `open`/`osascript` with NSWorkspace;
  pull real **app icons** (`icon(forFile:)`) to show in the Workspace form, and
  the running-apps list. Makes the launcher feel native.
- **Capture into project** (`screencapture` CLI / ScreenCaptureKit). A button to
  grab a screenshot straight into the active project's `media/`.
- **Share sheet** (`NSSharingServicePicker`). Native AirDrop/Messages/Mail on an
  exported image or background-removed cutout.
- **Core Image for export-quality tonal** (`CIFilter`, color-managed/GPU). Keep
  the WebGL pipeline for *live* preview (zero IPC latency); optionally use Core
  Image only for the final baked export. Quality upgrade, not a replacement.
- **AVFoundation video** (`AVAssetImageGenerator` poster frames; trimming). For
  when video editing enters scope — the plan's v0.2 "trim" candidate.

## Interaction layer — remaining (interaction-spec.md)
Most of the spec is built and committed (selection/keyboard, copy/paste, image
notes, drag-drop, project icons, activate actions). These are the deferred bits:

- **Overview folder-drop → "add as project."** Dropping a folder on the
  all-projects overview should add it as a project, referencing it in place.
  Blocked on a design decision since projects currently must live under
  `~/Projects` (`scan_projects`): symlink the dropped folder into `~/Projects`,
  add a project registry (config list of external paths that `scan_projects`
  also includes), or restrict to folders already under `~/Projects`.
- **Native multi-file-refs for `Shift+Mod+c`.** Single-image copy (baked PNG
  bitmap) is done. Multi-select "copy as file references" (Finder-style) needs a
  native `NSPasteboard` write of file URLs (`objc2-app-kit`), with edited images
  baked to temp files and unedited referenced in place. For now multi-select
  copies the first selected image as a bitmap. (interaction-spec §7.1)
- **Project icon reset.** A key/menu action to remove `.studio-icon.png` and
  revert to the letter avatar. (interaction-spec §10/§11)
- **Full file-split refactor (Phase 6 remainder).** dom.js/gl.js/imageutil.js
  were extracted, but the feature modules (notes/media/projects/workspace) still
  live in main.js because they reassign shared module-`let` globals, which
  read-only ES imports forbid. A one-time state-object refactor (`export const
  state = {}`, mutate `state.activePanel = …`) would unblock splitting them out.
