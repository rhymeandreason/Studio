# Video editor

A standalone companion window (like Git / Claude windows) for cutting
multi-clip edits with animated text and shader backgrounds, exporting MP4s for
YouTube / Reels / Square / Web. Launched from the Workspace tab or from an
edit's card in the **Artifacts panel** (a "Videos" group: first-clip
thumbnail via `quicklook_thumb`, or a live shader render; Open jumps to that
edit). `open_video_window(path, file?)` in `src-tauri/src/lib.rs` — `file`
targets a specific edit (`&file=` on first open, `video-open-edit` event when
the window already exists).

**The edit is a plain JSON file** — `<project>/videos/<edit>.json`. The GUI
and Claude Code are two editors of the same file: the window saves debounced
(`scheduleVideoSave`) and live-reloads when the file changes on disk. Original
design rationale in [video-plan.md](video-plan.md).

## Files

- `src/video/index.html` — window markup + tool-specific styles (kit-styled:
  tokens.css + kit.css + Material `.mi` icons).
- `src/video/video.js` — playback engine, timeline, inspector, persistence,
  export orchestration.
- `src/video/effects.js` — **text-animation registry** (single source of truth
  for preview *and* export).
- `src/video/shaders.js` — **shader-background registry** + WebGL runner
  (ditto).
- `src-tauri/swift/vidExport.swift` — native compositor/encoder (built by
  `build.rs` → `VIDEXPORT_BIN`).
- Rust commands: `list_videos` / `read_video` / `write_video` / `create_video`
  / `delete_video` / `import_clip` / `create_export_frames_dir` /
  `save_export_frame` / `export_video`.

## Data model — `videos/<edit>.json`

Times in seconds (float). Clip `src` is project-relative when possible.

```jsonc
{
  "version": 1,
  "name": "Tutorial — intro",      // display name in the edit switcher
  "preset": "youtube",             // youtube | reels | square | web
  "clips": [                       // played in array order, end-to-end
    { "id": "c1", "src": "media/intro.mov",
      "in": 0.0, "out": 12.5,      // trim within the source file
      "rotate": 0, "volume": 1.0 },
    { "id": "c2", "kind": "shader",// a GENERATOR clip — no source file
      "effect": "aurora",          // id in src/video/shaders.js
      "dur": 5,                    // its length on the timeline
      "params": { "base": "#15171c", "glow": "#4ac6a8", "speed": 1 } }
  ],
  "text": [                        // overlay layers, timed on the FINAL timeline
    { "id": "t1", "kind": "title", // title | caption
      "text": "Step 1 — Install",
      "start": 0.5, "end": 4.0,
      "x": 0.5, "y": 0.85,         // normalized 0..1, anchor center
      "size": 72,                  // font size in OUTPUT pixels
      "color": "#fff", "bg": "#0008",
      "font": "Futura",
      "anim": "word-pop",          // id in src/video/effects.js (list below)
      "from": "bottom",            // slide direction (slide only)
      "hi": "#ffd23f",             // karaoke highlight color (karaoke only)
      "words": [                   // OPTIONAL real word timing (absolute s) —
        { "t": "Step", "start": 0.5, "end": 0.9 } // used by words/karaoke and
      ] }                          // staggered word effects when count matches
  ]
}
```

Text animations: `none`, `fade`, `slide`, `words`, `typewriter`, `word-pop`,
`word-rise`, `char-cascade`, `blur-in`, `karaoke`.
Shader backgrounds: `drift`, `aurora`, `waves`, `grain`.

## Authoring effects (the modular part)

Every effect is written **once, in JS/GLSL**, and used identically by the live
preview and the export — there is no second native implementation to keep in
sync.

- **Text animation** → add an entry to `TEXT_EFFECTS` in
  `src/video/effects.js`. Declare `unit` ("layer" / "word" / "char") and
  `timing` ("stagger" / "span"), and return per-unit visual state
  (`{ a, dx, dy, scale, blur, fill }`, offsets in em) from `state(u, l)`.
  The inspector's Animation menu picks it up automatically.
- **Shader background** → add an entry to `SHADERS` in
  `src/video/shaders.js`: a fragment shader (uniforms `u_resolution`,
  `u_time`, plus one per declared param) and a `params` list
  (`color` / `number`), which the inspector turns into controls and the
  "+ Add clip…" menu lists under "backgrounds".

## Export pipeline

1. The webview renders an **overlay frame sequence** at output resolution and
   30 fps into a temp dir (`create_export_frames_dir` +
   `save_export_frame`): shader-clip pixels (opaque) + text layers
   (transparent elsewhere), drawn by the same effects.js / shaders.js code as
   the preview. Frames with nothing on them are skipped.
2. `export_video` spawns `vidExport` with the spec (video clips + `gap`
   entries for shader segments + the frames dir).
3. The Swift helper concatenates the trimmed clips in an
   `AVMutableComposition` (gaps = empty time ranges), pulls frames through an
   `AVAssetReader`, composites each with its overlay PNG, and encodes H.264 +
   AAC with an `AVAssetWriter`. Frames the reader doesn't produce (gap
   segments) are synthesized black + overlay. Progress streams back as
   `video-export-progress` (the frontend shows "Rendering %" for step 1,
   "Exporting %" for step 3).

Because overlays are baked from webview pixels, export always tone-maps to
SDR; the old CoreAnimation text path (and its HDR-preserve caveat) is gone.

## Live reload vs. UI edits

The window reloads the doc on `fs-changed` and window focus, but **only when
the file's content differs from what it last read/wrote**, and never while a
local edit is pending (dirty flag / debounce timer) — so UI edits can't be
clobbered by the editor's own write echo or unrelated project file changes.
The titlebar refresh button force-reloads from disk (explicitly discarding
pending edits), preserving playhead and selection.

## Claude Code control

Edit `videos/<edit>.json` directly; the open window live-updates. Useful
moves: generate caption layers (with `words` timing for karaoke), retime/trim
clips, add shader background segments between clips, bulk-restyle text, switch
`preset`. To create a new *kind* of animation, edit `effects.js` /
`shaders.js` (see "Authoring effects") — reload the window to pick up code
changes.
