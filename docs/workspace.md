# Workspace tab

The Workspace tab is a per-project launchpad: a set of "cards" (repo, Figma
file, apps, files, folders, URLs) plus a Launch button that opens everything at
once. Implemented in `src/workspace.js`, styled in `src/styles.css`
(`.ws*` rules), markup in `src/index.html` (`data-panel="workspace"`).

## Storage

Each project stores `workspace.json` (read/written via the Rust `Workspace`
struct in `src-tauri/src/lib.rs`):

- `repo` — singleton path to the project's code repo.
- `editor` — which app to open the repo in (`open -a <editor>`). Blank = Zed.
- `figma` — singleton Figma file URL.
- `apps` / `files` / `folders` / `urls` — arrays of strings.
- `claude.mode` — `"terminal"` opens Terminal cd'd into the repo and runs
  `claude`.
- `pinnedTab` (serde: `pinned_tab`) — which tab (`workspace`/`media`/`notes`)
  opens automatically when the project loads.

Saves are debounced via `scheduleWorkspaceSave()` (400ms after the last edit).

## Cards / `LIST_META`

Each list type (`repo`, `figma`, `apps`, `files`, `folders`, `urls`) has an
entry in `LIST_META`: icon, label, placeholder, whether it's a `singleton`
(repo/figma — only one card, "+" button disables once added), and whether it
gets a `browse` button (`dir`/`file`/`app` → native picker).

Cards are `.ws-item` elements holding a `<textarea>` (not `<input>` —
`readList()` queries `textarea`). Selection/keyboard nav follows the shared
interaction model (see `docs/interaction-spec.md`):
multi-select via click/Cmd-click/Shift-click, arrow keys to move focus,
Enter to open the item's value (`open` / `open -a` for apps), Delete/Backspace
to remove.

## Repo card: editor picker

The repo card has an `<select class="ws-item__editor">` ("open in") with
`EDITOR_OPTIONS`: Zed (default/blank), Atom, VS Code, Sublime Text, Xcode.
Changing it sets `wsEditor`, persisted as `workspace.json`'s `editor` field.
`launch_workspace` in `lib.rs` runs `open -a <editor> <repo path>` (or just
`open -a Zed` if blank).

To add another editor option, add `{ value, label }` to `EDITOR_OPTIONS` in
`src/workspace.js` — `value` must match the `.app` name macOS expects after
`open -a` (e.g. `"Visual Studio Code"`, `"IntelliJ IDEA"`).

## Launch button

`initLaunch()` wires `#launch-btn` → `invoke("launch_workspace", { path })`,
which (in order): opens URLs + Figma via `open`, opens the repo in the chosen
editor, opens the Claude terminal (if `claude.mode === "terminal"`), and opens
any apps/files/folders.

## Memory display

The project header (top right, `#projhead-memory`) shows three lines, polled
every 5s via the `get_memory_stats` Tauri command:
- **Swap used** — `sysctl vm.swapusage` used/total, in MB. This is the "should
  I quit something?" signal — macOS keeps memory busy with disk cache even
  under no pressure, so raw memory-used is a poor proxy. Rising swap usage
  means real pressure.
- **Studio app** — Studio's own RSS via `ps -o rss=`.
- **Dev server** — RSS of the `tauri dev` watcher process (via `pgrep -f
  "tauri dev"`), hidden when not running (e.g. in a production build). There's
  no separate Vite/localhost server in this app — Tauri serves `frontendDist`
  directly.

Clicking the memory block opens `#memory-modal`, which re-fetches
`get_memory_stats` plus `get_top_processes` — the top 10 **apps** by summed
RSS (via `ps -axo rss=,comm=`, grouped by `.app` bundle so e.g. all of Chrome's
helper/renderer/GPU processes collapse into one "Google Chrome (12)" entry).
This is meant to surface background apps/processes the user might not realize
are running.

## Tab pinning

The pin button (`#tab-pin`) toggles `wsPinnedTab` via `togglePinnedTab()` /
`updatePinButton()` (called from `main.js`'s tab-bar click handler).
`loadWorkspace()` selects the pinned tab (or `"workspace"`) on project load.

## Ideas / open questions for expansion

- Multiple repos per project (currently singleton)?
- Per-card notes/labels?
- Quick-launch subsets (e.g. launch only the repo + editor, skip apps)?
