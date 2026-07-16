# Git panel

The **Git tab** (`data-panel="git"`, in the main tab row) is the repo's home in
the main window. Implemented in [`src/git.js`](../src/git.js), styled in
`styles.css` (`.git-*`), markup `#git-panel` in `index.html`. It's keyed off the
project's single repo (via `activeRepoInfo()` from `workspace.js`) and renders a
column of cards:

- **Repo** — the repo path (+ Browse) and the "open in" editor picker. Edits go
  through `setActiveRepo()`/`setActiveEditor()` in `workspace.js` (autosaved);
  changing the path re-keys the panel. This is the *only* place the repo is
  edited — it's no longer a Workspace card.
- **Commit** (inline) — ports the standalone Git window's logic (below), reusing
  the same `git_*` commands: branch, changed files (click → open in editor),
  commit box (⌘↵), last-commit footer with expand + Undo. A pop-out button opens
  the floating window. A **Push** button lives in the panel's top toolbar (full-
  width row above the card grid), driven by the commit card's status fetch:
  `git_status` now returns `ahead`/`hasUpstream`, so it shows "Push N" when the
  branch is ahead,
  "Publish branch" on the first push of an untracked branch (`git_push` adds
  `-u origin <branch>`), and disables when in sync. Push runs with
  `GIT_TERMINAL_PROMPT=0` so a missing credential fails fast instead of hanging —
  it relies on an already-configured credential helper / SSH key.
- **Pulse** (inline) — embeds `tools/git-pulse.html?repo=…`.
- **Server** (inline) — embeds `tools/server.html`, shown only when the repo has
  `dev-open.sh`/`dev-stop.sh` (`repo_scripts`).

The last two are `<iframe>`s. Tauri only injects `window.__TAURI__` into the
top-level webview, so `kit/app.js` borrows the parent window's Tauri for a
same-origin embedded tool, and `kit/window-chrome.js` drops the tool's titlebar
+ window border when embedded (`.is-embedded` on `<body>`).

# Git companion windows

Small bright-colored windows, **one per repo**, that show a single repo's
status and let you commit. Opened by the Git panel's Commit-card pop-out button
(and reopened across rebuilds). Implemented as a standalone webview window
(`src/git/index.html`, self-contained HTML+CSS+JS like a tool) backed by git
Tauri commands in [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) (the "Git
companion windows" section).

The window uses the **minimal window style** (empty native title + transparent
`--bg`-tinted title bar + in-page title strip — see
[docs/tools.md](tools.md#minimal-window-style)).

## What a window shows

- **Project name + branch** (`ProjectName ⎇ branch`) in the in-page title strip
  at the top.
- **Changed files** — `git status --porcelain=v1 -b`. Click a file to open it in
  the project's configured editor (`open -a <editor>`, blank = Zed).
- **Commit message** box + **Commit all changes** button — stages everything
  (`git add -A`) then `git commit -m`. ⌘↵ commits too. Errors (e.g. "nothing to
  commit") surface as a toast.
- **Previous commit** footer — subject · short hash · relative time, plus an
  **Undo** button (`git reset --soft HEAD~1`: un-commits, keeps changes staged).

The window re-polls `git_status` on focus and after each action.

## Launching + theming

The Git panel's Commit card ([`src/git.js`](../src/git.js)) has a pop-out
button that calls `open_git_window(repo, color, editor)`. The window color comes
from the project's **accent color** (`Workspace::color`, serde `color`), set via
the Mode switcher's swatches (`Ctrl+Space` → project header → `Tab`), not a
per-repo picker. The legacy per-repo `gitColor` field is still read as a fallback
(`active_git_color_hex`) but is no longer written.

Each window's label is `git-<hash-of-repo-path>` (`git_label`), so opening the
same repo focuses the existing window instead of duplicating it; different repos
open side by side.

## Persistence across rebuilds

`tauri dev` rebuilds restart Studio, killing its windows. So the set of open Git
windows is persisted to **`git-windows.json`** in the app config dir (next to
`schedules.json`): a list of `{ repo, color, editor, draft }`. On startup
(`setup`), each entry is reopened via `build_git_window` — including its unsent
commit-message `draft` (debounce-saved as you type via `git_set_draft`, cleared
on a successful commit). Closing a Git window removes it from the store (the
`git-` branch in `on_window_event`'s `CloseRequested`), so it stays closed.

Each window's **size and position** are stored in the same `git-windows.json`
entry (`x`/`y`/`w`/`h`, physical px). They can't rely on
`tauri-plugin-window-state`: that plugin only flushes on a clean exit, and a
`tauri dev` rebuild SIGKILLs the process first. Instead `save_git_geometry`
writes the geometry **live** — on the window's `Moved`/`Resized`/`Focused(false)`
events (the `git-` branch in `on_window_event`) — and `build_git_window`
re-applies it with `set_position`/`set_size` after building.

This is the lighter of the two persistence options considered — the windows
blink closed/reopen during the rebuild (the whole app is down then anyway). The
heavier alternative, a separate standalone process like the Claude companion
app (which stays visible *during* a rebuild), was deferred.

## Commands

The **pure git-CLI commands** — `git_status`, `git_commit`, `git_undo`,
`git_push`, `git_commit_files`, `git_diff_file`, `git_diff_file_committed`,
`git_log_week` (plus the `GitFile`/`GitCommit`/`GitStatus` structs) — live in
[`src-tauri/src/git.rs`](../src-tauri/src/git.rs): they just shell out to `git`
and return data, with no window/state coupling. The one seam is `git_commit`,
which calls `crate::set_git_draft` to clear the saved draft.

The **window/state plumbing** stays in
[`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs): `open_git_window`,
`open_git_pulse`, the `GitWindow` store (`read/write/upsert/remove_git_window`,
`build_git_window`, `save_git_geometry`), `git_get_draft`/`git_set_draft`,
`git_open_file`, and the `active_git_color*` helpers. Git windows get the
`git-*` capability
([`src-tauri/capabilities/git.json`](../src-tauri/capabilities/git.json)).

## Window lifecycle gotcha

Studio is an `Accessory` menu-bar app, and a Tauri app **exits by default when
its last window closes**. Studio normally survives because the main window only
hides — but Git windows are genuinely closable, and the window-activation
shuffle when opening a file in an external editor could leave Tauri thinking no
windows remain. The `run()` closure handles `RunEvent::ExitRequested` and calls
`api.prevent_exit()` (only for `code: None` — the tray's "Quit Studio" passes a
code, so it still quits). Never let the app exit on window close.
