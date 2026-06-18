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
- **Session persistence** — the open path + unsaved text are saved to
  `localStorage` (`ce:session`) on load/edit/save and restored on launch, so a
  window reload (e.g. Tauri's dev watcher reloading webviews when a `src/` file
  is saved) doesn't lose the file.

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
typographic stylesheet (`MD_CSS`). The same rendered HTML feeds the offscreen
parser, so the DOM tree shows the rendered document structure. The git diff
still operates on the raw Markdown source.

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
