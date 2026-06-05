# Studio — agent primer

A macOS menu-bar app for designer-developers: each **project** is a folder under
`~/Projects/`. Studio activates a project (launches its apps + `claude` in the
repo), shows a **media** grid with a non-destructive **image editor**, and keeps
lightweight **notes**. Full spec: `STUDIO_PLAN.md`. Deferred work: `BACKLOG.md`.

## Stack
- **Tauri v2** (Rust backend) + **vanilla JS/HTML/CSS** frontend (no bundler).
- Frontend: `src/` (`index.html`, `main.js`, `styles.css`); vendored libs in
  `src/vendor/` (`marked`). Design = warm "Runes" theme, Futura + Material Symbols.
- Backend: `src-tauri/src/lib.rs` (all `#[tauri::command]`s + the tray).
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


## Conventions
The human tests each step in the running app before committing. `cargo check` in `src-tauri/` after Rust edits. 
Prefer native macOS frameworks over custom code.
Project folder structure is convention, not enforced. Tolerate missing subfolders gracefully.
The user is a designer who codes with Claude Code as primary tool.
The target is one user (the author) for v0.1.
