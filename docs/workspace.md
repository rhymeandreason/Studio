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
- `schedules` — recurring `claude -p` tasks; see "Scheduled tasks" below.

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

The project header (top right, `#projhead-memory`) shows up to four lines,
polled every 5s via the `get_memory_stats` Tauri command:
- **Memory** — total system memory in use vs. installed, in GB (from
  `vm_stat` active+wired+compressed pages / `sysctl hw.memsize`).
- **Studio app** — Studio's own RSS via `ps -o rss=`.
- **Swap used** — current swap usage in MB, from `sysctl vm.swapusage` (no
  "total" — swap's total is a dynamic file size, not a meaningful ceiling).
  This is the "should I quit something?" signal — macOS keeps memory busy with
  disk cache even under no pressure, so memory-used alone is a poor proxy.
  Rising swap usage means real pressure.
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

## Scheduled tasks

Below the cards grid, the Workspace tab has a "Scheduled tasks" section
(`#ws-schedules` in `index.html`, built by `workspace.js`'s
`renderSchedules`/`buildScheduleRow`/`initSchedules`). Each task is stored in
`workspace.json`'s `schedules` array (`ScheduledTask` in `lib.rs`):

- `prompt` — text passed to `claude -p`.
- `time` — 24-hour `"HH:MM"`, local time.
- `days` — `0`(Sun)–`6`(Sat); empty = every day.
- `enabled` — toggled via the `history_toggle_off` icon button.
- `model` — passed as `claude --model`; defaults to `"haiku"`.
- `outputFile` — markdown file (relative to the project folder) the result
  is written to, overwritten each run; blank = `"Scheduled Output.md"`,
  `.md` appended if missing.
- `lastRun` — `"YYYY-MM-DD"`, used by the scheduler to avoid firing twice in
  one day.
- `lastRunAt` / `lastRunOk` — timestamp and success flag of the last run
  (scheduled or manual), shown as `✓ Last ran …` / `✗ Last ran …`.

### Execution

On startup, `start_caffeinate()` spawns `caffeinate -s -w <studio-pid>` so
macOS won't sleep (on AC power) while Studio is running — it exits on its
own when Studio quits. Studio still needs to be running (even just in the
menu bar); if the Mac sleeps anyway (e.g. on battery) or Studio is quit,
missed runs are skipped, not backfilled.

### Waking the Mac (e.g. for an early-morning task)

If the Mac is fully asleep, `caffeinate` can't help. Whenever a task's
`time`/`days`/`enabled` changes (or it's removed), the frontend calls
`update_wake_schedule`, which:

1. Scans every project's enabled schedules and finds each one's next
   occurrence (today..+7 days, respecting `days`).
2. Runs `pmset schedule cancelall && pmset schedule wake "MM/dd/yy HH:MM:SS"`
   (one `wake` per upcoming occurrence, up to 10) via `osascript ... with
   administrator privileges` — macOS prompts for the admin password at this
   point, while you're present making the edit.

`pmset schedule cancelall` clears *all* scheduled sleep/wake/poweron events
system-wide (not just Studio's), so this is single-user-only behavior.
Because each task only schedules its *next* occurrence, a recurring task
needs Studio open again afterward (the wake itself doesn't re-trigger
`update_wake_schedule` — it only schedules ~7 days out from whenever you
last edited the task).

A background loop (`start_scheduler`, started in `setup`) wakes every 30s,
scans every project under `~/Projects/`, and fires any enabled task whose
`time`/`days` match now and that hasn't run today. Firing runs (in
`run_scheduled_task`):

```
claude -p <prompt> --permission-mode bypassPermissions [--model <model>]
```

in the project's repo dir (`claude_cwd`, same resolution as the Claude
companion window), with `PATH` resolved via `claude_path()` (login-shell
PATH, since GUI apps don't inherit nvm/homebrew). `bypassPermissions` is used
because headless runs have no one to approve tool prompts — keep scheduled
prompts to things you're comfortable running unattended.

The result (stdout on success, stderr on failure) is written to
`<project>/<outputFile>` as `# Scheduled task — <timestamp>` +
`**Output:**`/`**Error:**` + the text (no prompt echoed). `lastRunAt`/
`lastRunOk` are persisted back to `workspace.json`, and a `"schedule-ran"`
event (`{ projectPath, taskId, ok, output, outputFile, lastRunAt }`) is
emitted so an open project's UI updates live.

The ▶ "Run now" button calls `run_schedule_now` (same execution path, but
doesn't touch `lastRun`'s once-a-day dedupe) for testing a task without
waiting for its scheduled time.

## Ideas / open questions for expansion

- Multiple repos per project (currently singleton)?
- Per-card notes/labels?
- Quick-launch subsets (e.g. launch only the repo + editor, skip apps)?
