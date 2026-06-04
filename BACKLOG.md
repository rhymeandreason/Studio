# Studio — Backlog

Deferred ideas and follow-ups, captured during the build. Not scheduled.

## UI / polish
- **Vendor Material Symbols locally.** Icons currently load from Google Fonts
  (Material Symbols Rounded), so they need network — offline they degrade to
  ligature text. Bundle the icon font (woff2) into `src/vendor/` and serve it
  locally so the UI works fully offline. Same applies to confirming Futura is
  always available vs. shipping a fallback.

## Performance
- **Downscaled thumbnails in Rust.** Edited thumbnails are currently baked on
  the frontend by reading each image's *full-resolution* pixels (read_image_data
  → base64 → decode → WebGL pipeline → toDataURL), cached per session. First view
  of a project with many edited images is still heavy. Optimize by having Rust
  generate a small downscaled base (e.g. `sips -Z 512` or the `image` crate) and
  applying adjustments on that, and/or persist a thumbnail cache on disk
  (under `$APPCACHE`) keyed by path + sidecar mtime so it survives restarts.
