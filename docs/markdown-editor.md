# Markdown Editor

Typora-style WYSIWYG editor for `.md` files: you type directly in the styled
view, and markdown syntax collapses as you close it (`**bold**` → **bold**,
`## ` starts a heading, `- ` a list, `> ` a quote, ``` a code block).

- **Tool:** `src/tools/markdown-editor.html`. Per-project windows, same
  scheme as the Code Editor (`markdown_editor_label` /
  `open_markdown_editor_window` in `src-tauri/src/lib.rs`, `mde:open-file`
  event + `pending_open` for first launch, tracked for Workspace Modes as
  kind `"markdown-editor"`).
- **Delivering an open (why it isn't an event):** the path is always stashed
  in `pending_open` under the window's label; an already-open window also gets
  an `mde:check-pending` ping telling it to collect. The page collects on the
  ping *and* on boot, and `take_pending_open` removes the entry, so whichever
  runs first wins and the other finds nothing. Emitting the path directly (the
  old `mde:open-file`) dropped it whenever the page wasn't listening yet — a
  booting window, or one reloading under the dev watcher — leaving the editor
  showing its previous file. `loadPath` also carries a generation counter
  (docs/tools.md): it awaits three times before painting, so without it a
  slower overlapping open finishes last and paints its older file over the
  newer one. The boot-time session restore is skipped when `loadGeneration`
  is non-zero, i.e. a ping already claimed the stash.

  **Keep this to one round trip before painting**, the way the Code Editor's
  `loadPath` does (`read_text_file`, paint, then diff). Each IPC hop added
  ahead of the paint is felt directly as open lag. Hence the ping carries the
  path as a hint rather than making the page fetch it back out of the stash,
  and `path_exists` is only consulted when the *read* fails. Anything that
  isn't needed to put text on screen — git tint, diff — belongs after.
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
  or autosave would overwrite it. The empty state offers **New** alongside
  **Open…**, and `+` stays visible there too. With no active project there's
  nowhere to put a file, so `new_markdown_path` returns null and the toast
  says so — kept distinct from a *rejected* invoke, which means a real
  failure (usually an old build: the Rust commands need a Studio restart).
- **New from the main window:** the `post_add` button in the project header
  (right of Studio Claude, `initNewMarkdownButton` in `workspace.js`) opens a
  menu — *In Project Folder* or *In Repo docs/* — and calls `new_markdown_doc`
  with that `dest`. `markdown_dest_dir` resolves it: `"docs"` is `docs/` inside
  the workspace's repo (`claude_cwd(.., "repo")`), created if missing, since an
  editor opened on a path in a folder that isn't there fails its first save;
  anything else is the project folder. The docs option is disabled when the
  workspace has no `repo`, where it would silently mean the project folder.
  A *closed* editor is opened on a path picked in Rust; an
  *already-open* one is sent `mde:new-file` and picks the name itself, because
  it must flush its pending save first — that write creates the current
  document and so changes which `Untitled` name is free. Getting this
  backwards hands back the name the save is about to take, and "new" reopens
  the document you were just editing. The `dest` rides along as the event
  payload so the editor asks for the same folder. The in-window `+` flushes
  first for the same reason (and always means the project folder).
- **Comments / raw HTML:** markdown-it runs with `html: true`, so
  `<!-- … -->` arrives as an `html_block` / `html_inline` token and becomes a
  node of its own. With `html: false` (the original setting) comments were
  handed over as plain **text** and rendered as body prose in the middle of
  the document. Block comments now get their own dimmed monospace line with a
  left rule; inline ones become a dimmed chip. Both stay editable and are
  serialized **verbatim** — nothing may reformat them, since the point is
  that a comment survives a save byte for byte. This covers all raw HTML, not
  just comments.
- **Refresh + stale dot:** the same control the Code Editor has — a rose dot
  on the Refresh button, plus a periodic wiggle, when the file on disk no
  longer matches what's loaded. Checked on window focus and on a 2s poll
  (both skipped while the window is hidden). Clicking Refresh takes the disk
  version, discarding anything unsaved, so it's deliberate rather than
  automatic. This *replaced* a silent reload-on-focus: with autosave running,
  swapping the document underneath a cursor mid-sentence is worse than
  flagging it. Our own writes clear the flag, so a save never looks external.
- **Rename:** click the filename in the window bar (safe despite the bar
  being a Tauri drag region — only the bar element itself carries the
  attribute, so clicks on children are ordinary). Enter commits, Escape
  cancels, blur commits; the stem is preselected. A missing extension gets
  `.md` appended, so a rename can't quietly stop routing to this editor. The
  pending debounced save is flushed *before* the move so it lands on the old
  path, and `setPath` moves `currentPath`, the bar label and the restored
  session key together. A document that hasn't been typed into yet has
  nothing on disk to rename, so only the target moves — after checking the
  destination is free, or the next keystroke would autosave over it.
- **Sans / serif toggle:** a kit `.seg-toggle` (two `Aa`s, each set in the
  font it selects) swaps the *document* between
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
  so the first save of an old file can produce cosmetic diffs. A trailing
  newline is appended on save — the serializer omits one, which otherwise
  showed up in git as "\ No newline at end of file" on every save.
