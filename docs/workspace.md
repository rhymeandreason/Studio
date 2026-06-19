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

## Repo card: Git actions

Two buttons: **Open** (Git window) and **Pulse** (`src/tools/git-pulse.html` —
dot-graph of this week's commits, one dot per commit, hover for message).

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

Scheduled tasks have their own standalone window (`src/schedules/`:
`index.html` + `schedules.css` + `schedules.js`), opened via the "Schedules"
button in the project header or the all-projects overview
(`#schedules-btn`/`#overview-schedules-btn` in the main `index.html`), or the
"🗓 Scheduled Tasks" entry in the tray menu's Tools section (`open_schedules`
in `build_tray_menu`) — all calling `open_schedules_window` in `lib.rs`. It's
a separate Tauri window — like the
Claude companion window — so it stays open and reachable while you work in
any project/tab. On open it calls `read_schedules` (the global store) +
`list_projects` (to populate each task's project dropdown) and renders the
slots that have tasks (`buildSlotGroup`/`buildScheduleRow` in `schedules.js`).

Schedules are **global**, not per-project: a single store
(`SchedulesFile` in `lib.rs`, `schedules.json` in the app config dir) holds
the slots plus every task, read/written via `read_schedules` /
`save_schedules`. On first read the store is migrated from the old
per-project `Workspace::schedules` (each task tagged with its project path),
then `workspace.json`'s `schedules`/`scheduleSlots` are no longer used.

**Timing lives on the slot, not the task.** There are `SLOT_COUNT` (= 2)
shared slots; each (`SlotDef`) is a `time` + `days` pair, both edited in the
slot's header (an `<input type="time">` plus the 7 day toggles), and all
tasks in that slot share them. Both slots always render, each with its own
"+ Task" button that adds a task to that slot (a task's slot is fixed at
creation — there's no per-task slot picker). An empty slot still shows its
header (so you can add to it) but contributes nothing to the wake schedule.
The store holds:

- `slots` — array of `SLOT_COUNT` `SlotDef`s, each `{ time, days }`. `time`
  is `"HH:MM"` (default `["09:00", "17:00"]`); `days` is `0`(Sun)–`6`(Sat),
  empty = every day. Both are read by the scheduler/wake logic. (Reads also
  accept the old bare-`"HH:MM"`-string form, and `migrate_slot_count` coerces
  an old 3-slot file down to `SLOT_COUNT`, reindexing tasks so none are
  orphaned.)
- `tasks` — array of tasks (`ScheduledTask` in `lib.rs`):
  - `prompt` — text passed to `claude -p`.
  - `projectPath` — folder the run uses as its working dir and output
    location, picked via a per-task dropdown; blank = **"Global"**, the
    `~/Projects` root.
  - `slot` — `0`–`2`, index into `slots`; sets the task's timing and which
    group it's rendered under.
  - `enabled` — toggled via the pill switch.
  - `model` — passed as `claude --model`; defaults to `"haiku"`.
  - `outputFile` — markdown file (relative to the task's project folder) the
    result is written to, overwritten each run; blank = `"Scheduled
    Output.md"`, `.md` appended if missing.
  - `lastRun` — `"YYYY-MM-DD"`, used by the scheduler to avoid firing twice in
    one day.
  - `lastRunAt` / `lastRunOk` — timestamp and success flag of the last run
    (scheduled or manual), shown as `✓ Last ran …` / `✗ Last ran …`.

### Saving the wake schedule

Every edit debounce-saves to the global store via `save_schedules` in the
background — it does **not** touch the system wake schedule or prompt for the
admin password. The window header has a "Saved" / "Save schedule" button
(`#schedules-save`) that triggers that step. It appears (disabled "Saved" →
black "Save schedule") only when the **wake signature** changes: after each
edit `refreshDirty()` recomputes `wakeSignature()` (the JS mirror of the
backend's `wake_signature` — the `time` + sorted `days` of each slot with at
least one enabled task) and compares it to `appliedSignature` (what's
currently applied; set on load and after each successful save). So changing a
prompt/model/output/project, or editing a slot nobody uses, never lights the
button; only a real change to the wake times does — and reverting back to the
applied state clears it again. Clicking it flushes the pending save and calls
`update_wake_schedule` once (see below), then returns to "Saved".

`update_wake_schedule` re-checks the same way on the backend: it compares the
signature to the last applied one cached in `wake-signature.txt` (app config
dir) and returns early without running `pmset` or prompting if they match. So
even if the button is clicked, the password prompt only fires when the wake
times genuinely changed. The
signature is recorded only on a successful prompt, so a cancelled dialog is
retried on the next save.

### Execution

Studio relies entirely on the `pmset` wake schedule (below) to run tasks
while asleep — it does not keep the Mac awake. Studio still needs to be
running (even just in the menu bar) for the scheduler loop to fire a task:
the `pmset` wake brings the Mac up at the task time, and the loop catches it
within ~30s. If Studio is quit, or the Mac is asleep with no wake scheduled
(never saved, or the wake list expired), missed runs are skipped, not
backfilled.

### Waking the Mac (e.g. for an early-morning task)

For a task to run while the Mac is asleep, it has to be woken first. Clicking
"Save schedule" (see above) calls `update_wake_schedule`, which:

1. Scans each slot that has an enabled task and finds its next occurrence
   (today..+7 days, respecting the slot's `days`).
2. Runs `pmset schedule cancelall && pmset schedule wake "MM/dd/yy HH:MM:SS"`
   (one `wake` per distinct upcoming time, deduped and capped at **3 wake
   events** in `compute_wake_times` — `pmset` only holds a handful) via
   `osascript ... with administrator privileges` — macOS prompts for the
   admin password at this point, while you're present making the edit.

`pmset schedule cancelall` clears *all* scheduled sleep/wake/poweron events
system-wide (not just Studio's), so this is single-user-only behavior.

Because the wake list is capped at 3 events, a single daily slot covers the
next 3 days; with both slots in use at different times, fewer days are
covered. To keep a daily slot
self-renewing, `run_scheduled_task` calls `roll_wake_schedule` after each run,
which recomputes the same schedule and applies it via `sudo -n` (non-interactive)
— if the admin-password timestamp from the last `update_wake_schedule` prompt
is still cached, this silently extends the schedule another day; if it's
expired, it silently does nothing (the schedule just stops extending until you
next edit a task). For truly indefinite, prompt-free operation, grant
passwordless sudo for `pmset` (e.g. an `/etc/sudoers.d/` entry scoped to
`/usr/bin/pmset schedule *`).

A background loop (`start_scheduler`, started in `setup`) wakes every 30s,
scans the global schedules store, and fires any enabled task whose slot's
`time`/`days` match now and that hasn't run today. Firing runs (in
`run_scheduled_task`):

```
claude -p <prompt> --permission-mode bypassPermissions [--model <model>]
```

in the task's `projectPath` (`claude_cwd`, same resolution as the Claude
companion window; blank `projectPath` runs in the `~/Projects` root), with
`PATH` resolved via `claude_path()` (login-shell
PATH, since GUI apps don't inherit nvm/homebrew). `bypassPermissions` is used
because headless runs have no one to approve tool prompts — keep scheduled
prompts to things you're comfortable running unattended.

The result (stdout on success, stderr on failure) is written to
`<project>/<outputFile>` as `# Scheduled task — <timestamp>` +
`**Output:**`/`**Error:**` + the text (no prompt echoed). `lastRunAt`/
`lastRunOk` are persisted back to the global store, and a `"schedule-ran"`
event (`{ projectPath, taskId, ok, output, outputFile, lastRunAt }`) is
emitted so an open project's UI updates live.

The ▶ "Run now" button calls `run_schedule_now` (same execution path, but
doesn't touch `lastRun`'s once-a-day dedupe) for testing a task without
waiting for its scheduled time.

## Ideas / open questions for expansion

- Multiple repos per project (currently singleton)?
- Per-card notes/labels?
- Quick-launch subsets (e.g. launch only the repo + editor, skip apps)?
