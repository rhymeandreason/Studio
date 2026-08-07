# Code Editor tool

A lightweight HTML/CSS/JS editor that lives as a Studio **tool**
([`src/tools/code-editor.html`](../src/tools/code-editor.html)), with a companion
**preview window** ([`src/tools/code-preview.html`](../src/tools/code-preview.html)).
Built for the designer-developer loop: edit markup, see the live render in a
separate window, click between the DOM and the source, and read the git diff —
all kit-styled, all offline. See [tools.md](tools.md) for how tools load.

## Layout (editor window)

```
┌ toolbar: Open · Save · Refresh · Prettify · Wrap · Preview · dirty · diff ┐
├──────────────┬──────────────────────────────────────┬──┤
│ DOM tree     │  code panel                           │▌ │
│ (left, top)  │   gutter + syntax highlight + diff     │mm│
├──────────────┤   (textarea over highlight layer)      │  │
│ Styles       │                                        │  │
│ (inspector)  │                                        │  │
└──────────────┴──────────────────────────────────────┴──┘
```

- **Custom window** — the editor is the first tool with fully custom chrome
  (no native title bar / traffic lights): the toolbar (`#toolbar`, marked
  `data-window-bar`) doubles as the draggable title bar, with a close dot and
  project-color tint from the shared kit module `kit/window-chrome.js`. See
  the "Window style" section in [tools.md](tools.md).
- **DOM tree** — built from an **offscreen parser iframe** (not the visible
  preview), so it works even when the preview window is closed. The iframe runs
  scripts (`allow-same-origin allow-scripts`), so the tree reflects the
  *scripted* DOM, rebuilt on load + 120 ms later to catch async DOM.
- **Styles inspector** — for the selected element: its id/class chips and the
  matching CSS rules scanned from the document's stylesheets.
- **Code panel** — a `<textarea>` with transparent text layered over a
  highlight `<div>` (`#hl`) that draws the colored tokens, diff row tints, and
  carries the line text so soft-wrap stays aligned. A gutter shows line numbers
  + change bars; a **minimap** marks changed lines.

## Editing

- **Open** — native file picker (`pick_text_file`), any file, any location.
- **Save** — writes back to the same path (`write_text_file`); **Cmd+S** too.
- **Refresh** — re-reads the file from disk (picks up external edits) and
  re-diffs.
- **Prettify** — vendored **js-beautify** (`src/vendor/beautify*.js`), chosen by
  extension (css/js/html). Undoable: a one-level snapshot lets **Cmd+Z** revert
  it as long as nothing was typed since (normal typing-undo is the textarea's
  native undo).
- **Wrap** — toggles soft wrapping; gutter row heights sync to wrapped lines.
- **Find (Cmd+F)** — live search bar (Enter / Shift+Enter for next/prev, Esc to
  close, `current/total` count). Matches are highlighted by a layer behind the
  transparent textarea, positioned from real text geometry (a DOM Range's
  `getBoundingClientRect()` over the `#hl` line, so it's exact with tabs/wrap)
  and re-rendered on scroll. On a Markdown file it switches to Code view first.
- **Back / Forward** — arrow buttons left of Open walk a navigation history of
  opened files (`history`/`histIdx`; opening from a back-position drops forward
  entries, like a browser). Seeded from the restored session.
- **Per-project windows + session** — the editor opens **one window per
  project**, not a shared singleton: `open_code_editor_window` (lib.rs) labels
  the window with a project slug and passes `?session=<project path>`. The page
  keys its `localStorage` session on that (`ce:session:<projectPath>`; unscoped
  `ce:session` when no project is active). So each project keeps its own editor
  window + restored file side by side, and the scope is fixed for the window's
  lifetime (survives dev-watcher reloads — no "active project changed under me"
  staleness). The open path + unsaved text + scroll/cursor are saved on
  load/edit/save and restored on launch, so a window reload doesn't lose the
  file. Saved Workspace modes rebuild the right window via the `code-editor`
  tool kind.
- **Opening a file** (Git / File Directory tools → `open_in_code_editor`) scopes
  to the **file's** project — resolved by `project_path_for_file` from the
  project folder or its workspace `repo` path — not whichever project is active,
  so a Yuniku file always lands in Yuniku's editor. The file is delivered window-
  scoped: a fresh window pulls it once from `pending_open` (a `HashMap` keyed by
  window label, so a dev-watcher reload falls back to the session and no other
  project's window can grab it); an already-open window gets a label-stamped
  `ce:open-file` event that other editor windows ignore.

## Syntax highlighting

Vendored **Prism** ([`src/vendor/prism.js`](../src/vendor/prism.js): markup +
css + clike + javascript, incl. embedded `<style>`/`<script>`). The whole
document is tokenized, the token stream flattened to `[type, text]` pairs and
split per source line, then rendered into `#hl` (so the per-line diff/wrap layer
keeps working). Token colors are CSS classes `.tok-<prism-type>`. Falls back to
plain text if Prism errors.

## Markdown

For `.md` / `.markdown` files the code panel highlights Markdown (vendored
`prism-markdown`), and the **preview renders it** — `renderedHTML()` runs the
source through vendored `marked` (`window.marked`) and wraps it in a readable
typographic stylesheet (`MD_CSS`). The git diff still operates on the raw
Markdown source.

Markdown files also swap the UI (toggled by a `body.is-markdown` class set in
`applyMode()` on load/restore; they **open in Preview mode** by default):

- **Left column → section + link browser.** The DOM tree + Styles inspector are
  hidden. `#sections` lists the ATX headings (`buildSections` parses `#`–`######`,
  skipping fenced code, into `mdHeadings`), indented by level — clicking scrolls
  the source line (Code view) or the rendered heading (Preview view). Below it,
  `#links` (`buildLinks`) lists the **relative-path files** linked from the
  source, deduped and sorted `.md`-first; clicking opens the file.
- **Inline preview + toggle.** A Code/Preview button (`#view-toggle`) swaps the
  code panel for an in-window `#md-view` **div** (not an iframe — display-toggled
  iframes don't scroll reliably in WKWebView). `render()` fills it via `marked`
  into a scoped `.md-body`. The offscreen parser and the separate preview window
  still get full wrapped HTML (`renderedHTML()` / `mdWrap`).
- **Diff in the rendered view.** `mdBlocksHTML()` renders block-by-block instead
  of in one `marked.parse` call: each top-level lexer token's `raw` gives its
  source line range (newline counting, trailing blank lines ignored), so a block
  containing a changed line gets `.md-block.chg` — the same `--add-bg` /
  `--add-bar` tint as the code view, so the teal/blue mode toggle applies here
  too — and a deletion gets the gutter's small red triangle on the edge the diff
  points at (`.del` above the block, `.del-end` at its end). `refreshDiff()`
  re-renders the preview so the tint follows mode switches and reloads. Those
  markers need a positioned block, so in-preview scroll math goes through the
  rect-based `previewTop()` rather than `offsetTop`.
- **Edit table cells in the preview.** Tables are the one thing you edit from the
  rendered view: clicking a cell (`openCellEditor`) swaps it for an input holding
  that cell's raw Markdown, **Tab / Shift+Tab** step through cells in reading
  order, and Enter / Escape / blur commit. A cell lives in exactly one source
  line, so `tableCellSpans()` finds its character range there (skipping
  backslash-escaped pipes, honouring optional leading/trailing pipes) and
  `commitCellEditor` splices the new text into just that span — the rest of the
  line, the rest of the table, and the rest of the file are untouched; the
  rendered HTML is never converted back to Markdown. It's one undo step, and
  it's idempotent, so `saveFile`, `setView`, and `reloadFromDisk` call it to
  settle the source first. `render()` skips rebuilding `#md-view` while a cell is
  open (it would destroy the input) and preserves scroll otherwise. Column widths
  are pinned while editing so the auto table layout can't resize as you type.
  Clicking anywhere else in the preview does nothing — non-table prose is edited
  in the Code view.
- **Diff minimap.** The preview has its own rail (`#md-minimap`, sibling of
  `#md-view` inside `#md-pane`, sharing the code minimap's CSS). `paintMdMinimap`
  positions marks from the rendered blocks' `offsetTop`/`offsetHeight` — not line
  numbers — so a mark sits where the changed content actually is; it repaints on
  render, on the way into Preview (blocks have no geometry while the pane is
  hidden), and on resize. Clicking it scrolls; `.mm-view` tracks the viewport.
- **Clickable links.** In the preview, relative links open in the editor
  (resolved by `resolveRelative` against the current path), in-page `#anchors`
  scroll, external URLs are left alone.
- **Scroll is preserved across the toggle** by syncing to the nearest preceding
  heading: capture the last heading at/above the current pane's top
  (`currentCodeSectionIdx` / `currentPreviewSectionIdx`), then after layout
  scroll the other pane to it (same-document `offsetTop`/`scrollTop`).

For non-Markdown files the offscreen parser still gets the rendered source so the
DOM tree works as usual.

## Git diff

`git_diff_file(path)` runs `git diff --no-color HEAD -- <file>`, deriving the
repo from the **file's own directory** (the file may live outside any Studio
project). `parseDiff` marks:

- **changed/added** lines (`+` in the new file) → teal row tint + gutter bar +
  minimap mark.
- **deletions** (a `-` run with no replacement) → a red gutter triangle at the
  kept line after the removed block (there's no new-file line to tint).

Errors (not a repo, etc.) are surfaced as "not in git" and the editor still
works as a plain editor.

A toolbar toggle switches the diff basis:

- **Uncommitted** (default, teal) — `git diff HEAD`, the working-tree changes.
- **Last commit** (blue) — `git diff HEAD~1 HEAD` (`git_diff_file_committed`),
  what the most recent commit changed; "no prev commit" if there's only one.

The mode flips a `body.diff-committed` class that overrides the `--add-bg` /
`--add-bar` vars, so the row tint, gutter bars, and minimap recolor together.
Note the last-commit diff's line numbers are from `HEAD`, so they line up best
on a committed-clean file (uncommitted edits shift them).

## Preview window

A separate tool window (so it can use Tauri events) showing the rendered page in
a sandboxed iframe (`allow-same-origin allow-scripts allow-forms allow-popups`,
so page JS runs). Opened with the **Preview** button via the `open_code_preview`
command.

Cross-window messaging uses the Tauri event bus (both windows have
`core:event:default`):

| event          | from → to        | payload            | effect |
|----------------|------------------|--------------------|--------|
| `ce:ready`     | preview → editor | —                  | editor marks preview open and pushes current HTML |
| `ce:closed`    | preview → editor | —                  | editor stops pushing |
| `ce:html`      | editor → preview | full HTML string   | preview sets `iframe.srcdoc` (debounced as you type) |
| `ce:highlight` | editor → preview | child-index path   | cobalt-blue selection box (no scroll) |
| `ce:hover`     | editor → preview | path \| null       | cyan hover outline (DOM-tree hover) |
| `ce:select`    | preview → editor | child-index path   | clicking an element selects its tree node |

**Handshake order matters:** the preview `await`s its `listen()` registrations
*before* emitting `ce:ready`, otherwise the editor's reply can race ahead of the
listener and the first `ce:html` is lost (the symptom was a stuck "Waiting for
the editor…").

**Element identity across windows** is a **child-index path** from `<body>`
(array of `children` indices). Both the editor's parser iframe and the preview
render identical HTML, so the same path resolves to the same element in each.

## Selection ↔ source mapping

There's no real source map; it's text-search heuristics on the editor content:

- **DOM tree / preview click → source:** find the matching `<tag` in the source,
  disambiguated by **id**, then by **all classes**, falling back to the DOM
  ordinal **clamped** to a real match (the scripted/auto-inserted DOM can have
  more same-tag nodes than the source has literal tags).
- **Style chip / rule selector → source:** find the `.class` / `#id` token (or
  selector text) in the file (e.g. an inline `<style>`).

Reveal centers the line using the highlight layer's row offset, so it's correct
in soft-wrap mode too.

## "Open in Studio Code Editor" (Workspace)

The Repo card's *Open in* dropdown ([`workspace.js`](../src/workspace.js)) lists
**Studio Code Editor** first. When chosen, `git_open_file` routes a file opened
from the repo's Git window to this tool instead of `open -a <app>`: the path is
stashed in `AppState.pending_open` and emitted as `ce:open-file`. The editor
pulls it on launch (`take_pending_open`) or via the event if already open.

## Rust commands

All in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs):
`pick_text_file`, `read_text_file`, `write_text_file`, `git_diff_file`,
`open_code_preview`, `take_pending_open`, and the `STUDIO_EDITOR` branch in
`git_open_file`. Tool windows get these via the `tool-*` capability
([`capabilities/tools.json`](../src-tauri/capabilities/tools.json)); the file
picker uses `dialog:default`.

## Limitations

- Selection↔source is heuristic, not a parser — odd matches are possible on
  duplicated markup with no id/class.
- New (untracked) files show no diff (`git diff HEAD` only reports tracked
  changes).
- Re-highlights on every keystroke; fine for typical files, could be debounced
  for very large ones.
- Clicking in the preview selects (capture + `preventDefault`), so you can't
  interact with the running page's own buttons/links while the preview is open.
