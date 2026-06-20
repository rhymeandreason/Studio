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

## Modes (record/play window layouts)

`workspace.json`'s `modes` array (seeded with Code/Design/Default) holds named
window-layout snapshots, rendered as pill rows in `#ws-modes` by
`initModes()`/`renderModes()` in `src/workspace.js`. Each mode has a record
(●) and play (▶) button:

- **Record** → `invoke("list_windows")`, which shells out to the `winlayout`
  Swift helper (`list` mode, `CGWindowListCopyWindowInfo`) and returns every
  on-screen window (any app) as `{app, title, x, y, w, h}`. Stored as
  `mode.layout`, autosaved like the rest of the form.
- **Play** → `invoke("apply_window_layout", { layout })`. Studio's own
  windows are restored directly through Tauri (`apply_window_layout` in
  `lib.rs`) — matched by window label, not process name. Everything else
  goes to `winlayout apply`, which moves/resizes/un-minimizes matching
  windows (launching the app first if needed) and minimizes whatever's left.
  Matching/minimizing *other* apps' windows uses the Accessibility API
  (`AXUIElement`), which needs the user to grant Studio Accessibility
  permission once (System Settings → Privacy & Security → Accessibility) —
  until granted, AX calls are silent no-ops.

  Studio's own windows are deliberately handled outside winlayout: matching
  a window back to "is this app already running" requires comparing process
  names across two different macOS APIs (`CGWindowList` vs
  `NSWorkspace.runningApplications`), and for Studio's own unbundled
  `tauri dev` process those names can disagree — Play would conclude Studio
  wasn't running and launch a duplicate instance. Tauri already knows its
  own windows directly, so there's nothing to match.

This replaced the old single Launch button (`launch_workspace`/repo+apps+files
+URLs+Claude-terminal opener), which is still available as a Rust command but
no longer has a UI entry point.

## Tab pinning

The pin button (`#tab-pin`) toggles `wsPinnedTab` via `togglePinnedTab()` /
`updatePinButton()` (called from `main.js`'s tab-bar click handler).
`loadWorkspace()` selects the pinned tab (or `"workspace"`) on project load.

## Scheduled tasks

Recurring `claude -p` tasks, edited in a standalone window (`src/schedules/`),
opened by `open_schedules_window` from three places: the project-header and
overview "Schedules" buttons (`#schedules-btn`/`#overview-schedules-btn`) and
the tray Tools entry (`open_schedules` in `build_tray_menu`).

**Global store, not per-project.** Everything lives in one `schedules.json`
(app config dir), `SchedulesFile` in `lib.rs`, via `read_schedules` /
`save_schedules`. Shape and defaults are in the structs; the non-obvious parts:

- **Timing is on the slot, not the task.** There are `SLOT_COUNT` (= 2)
  `SlotDef`s (`time` + `days`); tasks just carry a `slot` index and inherit
  its timing. A blank task `projectPath` = "Global" (the `~/Projects` root).
- Both slots always render (each with its own "+ Task"); an empty slot still
  shows so you can add to it but contributes nothing to the wake schedule.
- Migrations run on read: per-project `Workspace::schedules` → the store once;
  `SlotDef` also deserializes the old bare-`"HH:MM"` form, `migrate_slot_days`
  folds legacy per-task days into the slot, and `migrate_slot_count` coerces an
  old 3-slot file down to `SLOT_COUNT`.

### The one admin-password step

Edits autosave silently. The only thing needing the admin password is
`update_wake_schedule` (sets `pmset schedule wake` via `osascript … with
administrator privileges`), gated so it prompts **only when the wake times
change** — i.e. the `time`+`days` of slots that have an enabled task. This
signature is checked twice: the frontend `refreshDirty()`/`wakeSignature()` vs
`appliedSignature` decides whether the "Save schedule" button (`#schedules-save`)
even shows, and the backend re-checks against `wake-signature.txt` so a stray
click still won't prompt. The cache is written only on a successful prompt
(cancel → retried next save).

`pmset schedule cancelall` clears *all* system wake events (single-user-only),
and the list is capped at 3 (`compute_wake_times`), so this assumes few slots.
After each run `roll_wake_schedule` re-applies via `sudo -n` to extend the
schedule without prompting — works only while the password timestamp is cached;
for indefinite operation grant passwordless sudo for `/usr/bin/pmset schedule *`.

### Execution

No `caffeinate` — waking is entirely on `pmset`. `start_scheduler` loops every
30s, firing any enabled task whose slot matches now and hasn't run today, as
`claude -p … --permission-mode bypassPermissions` (headless, no one to approve
prompts) in `claude_cwd(projectPath)`. Output (stdout, or stderr on failure)
overwrites `<project>/<outputFile>`; `lastRun*` are saved back and a
`"schedule-ran"` event updates an open project's UI. Studio must be running for
the loop to fire; missed runs aren't backfilled. ▶ "Run now"
(`run_schedule_now`) is the same path minus the once-a-day dedupe.

