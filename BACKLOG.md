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
- **Bundle the Swift helper for `tauri build`.** The compiled `bgremove` binary
  currently lives in `target/.../build/.../out/` (path injected via `BGREMOVE_BIN`)
  — fine for `tauri dev`, but a packaged app won't have that path. Before
  shipping: bundle it as a resource (or `.app` sidecar) and resolve it at runtime
  instead of `env!("BGREMOVE_BIN")`. Also hardcodes `-target arm64` — add x86_64
  if a universal build is ever needed.
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
