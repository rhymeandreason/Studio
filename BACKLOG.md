# Studio — Backlog

Deferred ideas and follow-ups, captured during the build. Not scheduled.

## UI / polish
- **Vendor Material Symbols locally.** Icons currently load from Google Fonts
  (Material Symbols Rounded), so they need network — offline they degrade to
  ligature text. Bundle the icon font (woff2) into `src/vendor/` and serve it
  locally so the UI works fully offline. Same applies to confirming Futura is
  always available vs. shipping a fallback.

## Background removal
- **Speed: run inference with threads.** Removal is slow because onnxruntime-web
  runs the model on a **single CPU thread** — the webview isn't cross-origin
  isolated, so `SharedArrayBuffer` (and ORT's threaded/SIMD path) is unavailable,
  and WKWebView has no usable WebGPU. Enabling COOP/COEP headers on Tauri's
  protocol would unlock multi-threaded WASM (likely several× faster), but
  require-corp can break cross-origin loads (the esm.sh JS import, asset://
  images) — needs care (maybe `credentialless`, or vendor the JS so nothing is
  cross-origin). Biggest available speedup.
- **Fully offline (no CDN JS).** The model + wasm are local, but the JS library
  still loads from esm.sh once per session (it has bare `import("onnxruntime-web")`
  that needs a bundler/import-map to resolve). Bundle the lib + ORT with esbuild
  into a self-contained `src/vendor/imgly/lib/index.mjs` to drop the CDN entirely.
- **Production bundling.** `src/vendor/imgly/` (~76MB) is gitignored and fine for
  `tauri dev`, but a `tauri build` would bundle it into the app. Before packaging,
  load the model from app resources / a downloaded cache instead of `frontendDist`.

## Performance
- **Downscaled thumbnails in Rust.** Edited thumbnails are currently baked on
  the frontend by reading each image's *full-resolution* pixels (read_image_data
  → base64 → decode → WebGL pipeline → toDataURL), cached per session. First view
  of a project with many edited images is still heavy. Optimize by having Rust
  generate a small downscaled base (e.g. `sips -Z 512` or the `image` crate) and
  applying adjustments on that, and/or persist a thumbnail cache on disk
  (under `$APPCACHE`) keyed by path + sidecar mtime so it survives restarts.
