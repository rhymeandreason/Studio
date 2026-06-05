# Studio — Backlog

Deferred ideas and follow-ups, captured during the build. Not scheduled.

## UI / polish
- **Vendor Material Symbols locally.** Icons currently load from Google Fonts
  (Material Symbols Rounded), so they need network — offline they degrade to
  ligature text. Bundle the icon font (woff2) into `src/vendor/` and serve it
  locally so the UI works fully offline. Same applies to confirming Futura is
  always available vs. shipping a fallback.

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
