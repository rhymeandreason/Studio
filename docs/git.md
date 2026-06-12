# Git companion windows

Small bright-colored windows, **one per repo**, that show a single repo's
status and let you commit. Launched from a project's Workspace repo card.
Implemented as a standalone webview window (`src/git/index.html`, self-contained
HTML+CSS+JS like a tool) backed by git Tauri commands in
[`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) (the "Git companion windows"
section).

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

The Workspace repo card ([`src/workspace.js`](../src/workspace.js)) has a row of
8 curated bright **swatches** (`GIT_COLORS`) and a **Git** button. The chosen
color is saved as `gitColor` on the project's `workspace.json`
(`Workspace::git_color`, serde `gitColor`). The Git button calls
`open_git_window(repo, color, editor)`.

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

This is the lighter of the two persistence options considered — the windows
blink closed/reopen during the rebuild (the whole app is down then anyway). The
heavier alternative, a separate standalone process like the Claude companion
app (which stays visible *during* a rebuild), was deferred.

## Commands (`lib.rs`)

`open_git_window`, `git_status`, `git_commit`, `git_undo`, `git_open_file`,
`git_get_draft`, `git_set_draft`. Git windows get the `git-*` capability
([`src-tauri/capabilities/git.json`](../src-tauri/capabilities/git.json)).

## Window lifecycle gotcha

Studio is an `Accessory` menu-bar app, and a Tauri app **exits by default when
its last window closes**. Studio normally survives because the main window only
hides — but Git windows are genuinely closable, and the window-activation
shuffle when opening a file in an external editor could leave Tauri thinking no
windows remain. The `run()` closure handles `RunEvent::ExitRequested` and calls
`api.prevent_exit()` (only for `code: None` — the tray's "Quit Studio" passes a
code, so it still quits). Never let the app exit on window close.
