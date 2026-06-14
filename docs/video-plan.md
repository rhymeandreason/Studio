# Video editor — design plan

> Status: **planned, not yet built.** This is the implementation plan for
> Studio's video editor. Once built, the living reference moves to `video.md`.

## Context

Studio's author shoots tutorial/documentation video on iPhone and wants a
**simple multi-clip video editor** inside Studio that exports for
web/YouTube/Instagram **and is controllable by Claude Code**. The key design
insight that satisfies "controlled via Claude Code": the entire edit is a
**plain JSON document on disk** (`video.json` in the project folder), exactly
like `notes.json` / `workspace.json`. The GUI and Claude Code are two editors of
the same file — Claude edits the JSON (add a caption, retime a clip, change
text), and the window re-renders live via the existing FSEvents `fs-changed`
watcher. No GUI-driving required.

The editor follows Studio's established **standalone-companion-window** pattern
(like Git windows / Claude window / Schedules): a self-contained
`src/video/index.html` webview, backed by Tauri commands in `lib.rs`, launched
from the Workspace tab. Export and transcription use **native macOS Swift
helpers** (per CLAUDE.md "prefer native macOS frameworks"), compiled by
`build.rs` like the existing `bgremove`/`qlthumb`/`pbimage`/`appicon` helpers.

Confirmed scope: multi-clip timeline; all four text animations (fade, slide,
word-by-word captions, typewriter); export presets YouTube 16:9, Reels 9:16,
Square 1:1, and Web (source ratio); native on-device transcription with
word-level timestamps; iPhone HDR support (with the export caveat below).

## Data model — `videos/<edit>.json` (the Claude Code interface)

A project holds **multiple edits**, one JSON file each under
`<project>/videos/` (e.g. `videos/tutorial-intro.json`). Each doc carries a
`name` for display and is selected via the window's title-bar switcher
(＋ New / 🗑 Delete). Times in **seconds** (float). Human-readable so Claude can
create or edit them by hand. Backend commands: `list_videos`, `read_video`,
`write_video`, `create_video`, `delete_video` (each takes the edit's basename
`file`).

```jsonc
{
  "version": 1,
  "name": "Tutorial — intro",     // display name in the edit switcher
  "preset": "youtube",            // youtube | reels | square | web
  "hdr": "sdr",                    // sdr (tone-map, default) | preserve
  "clips": [                       // played in array order, end-to-end
    { "id": "c1", "src": "media/intro.mov",
      "in": 0.0, "out": 12.5,      // trim within the source file
      "volume": 1.0 }
  ],
  "text": [                        // overlay layers, timed on the FINAL timeline
    { "id": "t1", "kind": "title", // title | caption
      "text": "Step 1 — Install",
      "start": 0.5, "end": 4.0,
      "x": 0.5, "y": 0.85,         // normalized 0..1, anchor center
      "size": 0.06,                // height as fraction of frame height
      "color": "#fff", "bg": "#0008",
      "font": "Futura",
      "anim": "slide",             // none | fade | slide | typewriter | words
      "from": "bottom" }           // slide direction / word-cadence hint
  ]
}
```

`words`/`typewriter` use real spoken timing when a transcript exists (see
`transcribe.swift`); otherwise the reveal is auto-spread evenly across
`start..end`. A tiny `video.schema.md` is written into the project root on first
open so Claude Code has the format in context.

## Components to build

### 1. `src/video/` — the editor window (new, self-contained like `src/git/`)
- `index.html` — minimal-window-style layout: title strip, **preview canvas**,
  **timeline** (clip lane + text lane), **inspector** for the selected layer,
  **Export** button. Loaded with `?path=<project>` query param.
- `video.js` —
  - **Preview/playback engine:** a single `<video>` element whose `src` +
    `currentTime` are driven to map global timeline time → the active clip
    (sequencing multiple clips through one element by swapping `src` at clip
    boundaries). A `requestAnimationFrame` loop positions the playhead and
    renders text layers as **absolutely-positioned DOM nodes** over the video
    (CSS transforms/opacity implement fade/slide/typewriter/words — same look
    the exporter reproduces). Video files load via `convertFileSrc()`.
  - **Timeline UI:** clip blocks (drag to reorder, drag edges to trim →
    in/out), text blocks (drag to move start/end). Reuses the
    `createSelection({mode,onChange})` primitive from `src/selection.js` and the
    keymap registry from `src/keymap.js` for consistency with other panels.
  - **Inspector:** edit selected text layer's text/position/size/color/anim.
  - Loads via `invoke("read_video", {path})`, saves debounced via
    `scheduleVideoSave()` → `invoke("write_video", ...)` (mirror of
    `scheduleNotesSave`).
  - Listens for `fs-changed` and re-reads `video.json` so Claude Code edits
    appear live.
- `video.css` — `.vid*` rules, minimal-window style (transparent titlebar +
  `--bg` tint) matching `docs/tools.md#minimal-window-style`.

### 2. `swift/vidExport.swift` — native exporter (new)
- Reads a JSON spec (the resolved `video.json` + absolute paths + output path +
  target size) from a temp file passed as argv.
- Builds an `AVMutableComposition` appending each clip's trimmed `[in,out]`
  range (video + audio tracks) end-to-end.
- **HDR handling (iPhone HEVC 10-bit HLG / Dolby Vision):**
  - `hdr: "sdr"` (default) — set the `AVMutableVideoComposition` color
    properties to Rec.709 so AVFoundation tone-maps HDR→SDR, and bake text via
    `AVVideoCompositionCoreAnimationTool` (which is itself 8-bit SDR). This is
    the right default for YouTube/IG/web delivery and is the only mode where
    text overlays are reliably baked.
  - `hdr: "preserve"` — export HDR passthrough (10-bit HEVC, HLG transfer
    preserved) for clips. **Caveat:** the Core Animation overlay tool forces
    SDR, so in preserve mode overlays are skipped on HDR segments in v0.1; a
    true HDR-with-overlays path needs a custom Metal `AVVideoCompositing` and is
    deferred to v0.2. The UI surfaces this as
    "Keep HDR (overlays not baked on HDR clips)".
- Builds text/caption animation as **Core Animation layers** on a parent
  `CALayer`, driven by `CABasicAnimation`/`beginTime`/keyframes to reproduce
  fade/slide/typewriter/words, wired via
  `AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer:in:)`.
- Scales/letterboxes the composited frame to the preset's render size
  (1920×1080 / 1080×1920 / 1080×1080 / source) via
  `AVMutableVideoComposition.renderSize` + a transform.
- Exports H.264 MP4 (`AVAssetExportSession`) and prints progress lines + the
  final path to stdout.

### 2b. `swift/transcribe.swift` — native speech-to-text (new)
- Takes a clip path + locale; uses the on-device **Speech framework**
  (`SFSpeechRecognizer` with `requiresOnDeviceRecognition`, or
  `SpeechAnalyzer`/`SpeechTranscriber` where available on macOS 26+) to produce
  **word-level timestamps**.
- Emits JSON: `{ segments: [ { text, start, end, words:[{t,start,end}] } ] }`.
- Studio caches it as `<clip>.transcript.json` next to the media file so it's
  reusable and Claude-editable.
- Powers a **"Transcribe → captions"** button in the editor (one click → timed
  caption layers), and upgrades the `words`/`typewriter` animations to use real
  spoken timing when a transcript exists (auto-spread remains the fallback).
- Caveat: accuracy depends on audio; first run may download a language model;
  English best-supported. Needs the speech-recognition entitlement /
  `NSSpeechRecognitionUsageDescription` in `Info.plist`.

### 3. `src-tauri/build.rs` — compile the helpers
Add `swiftc(...)` blocks for `swift/vidExport.swift` (→ `VIDEXPORT_BIN`) and
`swift/transcribe.swift` (→ `TRANSCRIBE_BIN`), following the existing
`bgremove`/`qlthumb` pattern. Keep `macosx14.0` to match the app's floor
(SpeechAnalyzer paths gate at runtime on availability).

### 4. `src-tauri/src/lib.rs` — Tauri commands (registered in `invoke_handler`)
- `read_video(path) -> Value` / `write_video(path, doc)` — read/write
  `<path>/video.json` (create default doc if missing). Mirror `read_notes` /
  `save_notes` style.
- `list_project_videos(path)` — list `media/*.{mov,mp4,m4v}` so the UI can offer
  clips to add. (Reuse existing media-dir scan helpers.)
- `transcribe_video(path, clip, locale) -> Value` — spawn `TRANSCRIBE_BIN`,
  cache + return `<clip>.transcript.json` (word timestamps). The
  "Transcribe → captions" button and Claude-driven caption generation both use
  this.
- `export_video(path, doc, dst)` — resolve relative clip paths to absolute,
  write the spec temp file, spawn `VIDEXPORT_BIN`, stream progress via an
  emitted `video-export-progress` event, return the output path. Reveal in
  Finder on done (`open -R`).
- `open_video_window(path)` + `build_video_window(app, path)` — webview builder
  copied from `build_git_window` / `open_git_window`, label
  `video-<hash-of-path>`, persisted to `video-windows.json` with live geometry
  save (same `on_window_event` / `save_*_geometry` pattern) so it survives
  `tauri dev` rebuilds.

### 5. Launch points
- **Workspace tab:** add a "Video" button to the project header, wired to
  `invoke("open_video_window", {path})` — next to the existing Schedules/Git
  affordances in `src/workspace.js` / `index.html`.
- (Optional) Tray menu Tools entry, mirroring `open_schedules`.

### 6. Config
- `tauri.conf.json` `assetProtocol.scope` already covers `$HOME/Projects/**`,
  so `convertFileSrc()` on clips under `media/` works. The `**` glob does not
  match leading-dot files, but clips won't be dotfiles — no new scope entry
  needed. Export to `$APPCACHE` is already in scope.

### 7. Docs
- New `docs/video.md` (living reference, supersedes this plan) describing the
  window, the `video.json` schema, the animation set, the export presets, and
  the native helpers — plus add it to the module list in `CLAUDE.md` and the
  `docs/` cross-links, matching how `git.md` / `media.md` are referenced.

## Build order (incremental, each step testable in the running app)
1. Data model + Rust `read_video`/`write_video` + default doc; `cargo check`.
2. `open_video_window` + empty `src/video/` window, launched from Workspace.
3. Preview engine: single-clip playback + DOM text overlay with the 4 anims.
4. Timeline UI: multi-clip sequencing, trim, reorder; text layer timing.
5. Inspector editing + debounced save + `fs-changed` live reload (Claude path).
6. `transcribe.swift` + `transcribe_video` + "Transcribe → captions" button;
   real word-timing for `words`/`typewriter`.
7. `vidExport.swift` + `build.rs` + `export_video` + progress UI + presets + HDR.
8. `docs/video.md` + `CLAUDE.md` link + `video.schema.md` seeding.

## Claude Code control — example prompts (document in `video.schema.md`)
Because the edit *is* `video.json`, Claude edits the file and the open window
live-reloads via `fs-changed`:
- Generate caption layers from a transcript (or `transcribe_video` output),
  timed across a clip.
- Trim/retime clips (`in`/`out`), extend all captions, reorder clips.
- Add per-step slide-in titles; bulk-restyle font/color/bg/anim.
- Switch `preset` (reflow caption `y` for Reels safe-area) and `hdr` mode.

Not in v0.1: judging framing from pixels, or deriving timestamps from audio it
wasn't given (use `transcribe_video` or auto word-spread). It cannot drive the
GUI — it works through the file, which is the more robust path.

## Verification
- `cd src-tauri && cargo check` after each Rust edit (per CLAUDE.md).
- `npm run tauri dev`; open a `~/Projects/*` project with an iPhone `.mov` in
  `media/`, open the Video window from Workspace.
- Add 2 clips, trim, add a title (slide) + caption (words); scrub the timeline
  and confirm overlays animate.
- **Transcription:** run "Transcribe → captions" on a clip; confirm caption
  layers land with sensible word timing.
- **Claude-control test:** hand-edit `video.json` (change a caption's text and
  `start`) and confirm the open window live-updates via `fs-changed`.
- Export each preset; confirm MP4 dimensions (16:9 / 9:16 / 1:1 / source) via
  `ffprobe`/QuickLook and that text animations are baked into the file.
- Sanity-check audio is retained and clips play in order.

## Open trade-offs (resolved for v0.1)
- **HDR:** default export tone-maps to SDR so text bakes correctly (right for
  YT/IG/web); a "Keep HDR" option does passthrough but skips overlays on HDR
  clips. Full HDR+overlay (Metal compositor) deferred to v0.2.
- **One `<video>` element, swap `src` per clip** (vs. N stacked elements):
  simpler, but a brief seek hitch at clip boundaries in *preview*. Export is
  frame-accurate regardless (AVMutableComposition). Acceptable for v0.1.
- **Words/typewriter cadence** is auto-spread when no transcript exists — no
  per-word timing UI yet. Claude Code can set precise `start`/`end` per caption
  layer to place lines.
