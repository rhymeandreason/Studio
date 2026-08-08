# Markdown Editor

Typora-style WYSIWYG editor for `.md` files: you type directly in the styled
view, and markdown syntax collapses as you close it (`**bold**` → **bold**,
`## ` starts a heading, `- ` a list, `> ` a quote, ``` a code block).

- **Tool:** `src/tools/markdown-editor.html`. Per-project windows, same
  scheme as the Code Editor (`markdown_editor_label` /
  `open_markdown_editor_window` in `src-tauri/src/lib.rs`, `mde:open-file`
  event + `pending_open` for first launch, tracked for Workspace Modes as
  kind `"markdown-editor"`).
- **Engine:** `src/vendor/prosemirror-md.js` — a one-time esbuild bundle
  (ESM, minified) of prosemirror-{model,state,view,transform,commands,
  keymap,history,inputrules,schema-list,markdown} + markdown-it. Rebuild by
  re-bundling those packages with esbuild if it ever needs upgrading; no
  build step in the repo.
- **Routing:** `open_in_code_editor` (lib.rs) sends `.md`/`.markdown` files
  here instead of the Code Editor, so every existing path — File Directory,
  notes exports, `open_file_in_editor` with the Studio editor — now opens
  markdown in this tool. The `</>` button (`open_md_in_code_editor`) is the
  escape hatch back to raw source in the Code Editor.
- **New documents:** launching the tool from the tray menu or Spotlight opens
  a *fresh* window on a new `Untitled.md` (`untitled_markdown_path`, project
  root — where the notes' Markdown export already writes; `Untitled-1.md` and
  so on if taken). An already-open window is only focused, so re-clicking the
  tray icon can't throw away what's on screen — the `+` button is how you get
  another. The file is **not** created up front: `loadPath` opens a
  not-yet-existing path as an empty document (`vim foo.md` semantics) and the
  first edit writes it, so opening the tool and closing it leaves no litter.
  Existence is checked with `path_exists` rather than inferred from a failed
  read — a file that exists but can't be read must not be treated as empty,
  or autosave would overwrite it. With no active project there's nowhere to
  put one, so the empty state shows instead.
- **Sans / serif toggle:** the `Aa` button swaps the *document* between
  system UI (SF) and **New York** (`ui-serif`) — Apple's system serif, drawn
  for reading and metrically matched to SF, so nothing is downloaded and no
  woff2 joins `src/vendor/`. Only the prose changes: the title bar stays SF
  and code stays mono. Serif gets a point more size (`--doc-size`) since New
  York runs optically smaller. It's a reading preference rather than a
  property of a file, so it's stored per tool (`localStorage` `mde-font`) and
  applied before the first paint.
- **Saving:** debounced 600 ms after each doc change (plus blur / Cmd+S /
  before switching files) via `write_text_file`. On window focus the file is
  re-read and swapped in only when there are no unsaved edits.
- **Git tint:** changed blocks get a teal bar in the left margin (blue for
  "last commit" mode via the toolbar toggle) — `git_diff_file` /
  `git_diff_file_committed`, mapped to blocks by pairing the doc's top-level
  nodes with markdown-it token line maps of the on-disk text (valid because
  disk text equals the serialized doc right after a save; on mismatch the
  tint just doesn't draw).

## Limits (v1)

- CommonMark + GFM pipe tables (schema extended via prosemirror-tables;
  Tab/Shift-Tab move between cells, toolbar button inserts a 2×2 table;
  cells hold inline content, so multi-line cells flatten to one line).
  `~~strikethrough~~` isn't in the schema yet — it stays literal text.
- Serialization normalizes formatting (bullet char, setext → ATX headings),
  so the first save of an old file can produce cosmetic diffs.
