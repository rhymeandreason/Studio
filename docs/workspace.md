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
  `lib.rs`) — matched by window label, not process name; anything not
  matched gets `hide()`d (not `minimize()` — instant, no genie animation,
  and the same "hide, don't quit" semantics the close button already uses
  elsewhere). Everything else goes to `winlayout apply`, which
  moves/resizes/un-minimizes matching windows (launching the app first if
  needed) and minimizes whatever's left — other processes' windows don't
  have an equivalent "hide" a parent app can toggle on them from outside,
  so that path still minimizes. Matching/minimizing *other* apps' windows
  uses the Accessibility API (`AXUIElement`), which needs the user to grant
  Studio Accessibility permission once (System Settings → Privacy &
  Security → Accessibility) — until granted, AX calls are silent no-ops.

  Matching a recorded window back to a live AX window during restore is by
  title, with a fallback to "first window of that app" when titles don't
  match — because `CGWindowList`'s `kCGWindowName` comes back blank for
  other processes' windows without Screen Recording permission, while AX's
  `kAXTitleAttribute` still returns the real title. The final "minimize
  whatever's left" pass deliberately does *not* try to match by title at
  all (no exact-match fallback there) — it just minimizes every AX window of
  every on-screen process that wasn't already restored.

  Studio's own windows are deliberately handled outside winlayout: matching
  a window back to "is this app already running" requires comparing process
  names across two different macOS APIs (`CGWindowList` vs
  `NSWorkspace.runningApplications`), and for Studio's own unbundled
  `tauri dev` process those names can disagree — Play would conclude Studio
  wasn't running and launch a duplicate instance. Tauri already knows its
  own windows directly, so there's nothing to match.

  A saved Studio target that isn't among the currently-open webview windows
  means it was *closed* (not minimized) since recording. Git windows are the
  one case `apply_window_layout` knows how to reopen — but it can't rely on
  the persisted `git-windows.json` store for this, because closing a Git
  window deletes its entry from that store (`remove_git_window`, "closing
  means I'm done with this repo"). So `WindowSnapshot` also carries
  `repo`/`color`/`editor` for Git windows (captured in
  `studio_window_snapshots` from the live store at record time), and
  `apply_window_layout` rebuilds the `GitWindow` from the snapshot itself —
  `upsert_git_window` then `build_git_window` — before applying the saved
  position/size.

  Any other lazily-built Studio window is the same case: built on first
  open, so on a fresh Studio launch one that was part of a saved mode but
  hasn't been opened yet this session simply doesn't exist, and a label
  alone often can't be reversed back into the args its opener needs (it's
  frequently a hash or unrelated slug). So every such opener —
  `open_tool` (the generic `src/tools/*.html` command); the internal
  `open_tool_window`/`open_tool_window_near`/`open_tool_window_with_color`
  (tray tools, Code Editor, Code Preview); `open_git_pulse`;
  `open_schedules_window`; `open_video_window`; and `open_claude_window` —
  calls `track_tool_window(label, file, extra, kind)`, writing into an
  in-memory `TOOL_WINDOWS` map (`extra` is whatever that opener needs to
  rebuild itself: a query string, a color, a repo path, a project path, or
  nothing). `studio_window_snapshots` reads that map at record time and
  stores `tool_file`/`tool_query`/`tool_kind` on the snapshot, durably, the
  same way Git windows store `repo`/`color`/`editor`. Despite the name,
  `tool_*` covers all of these, not just `src/tools/*.html` windows — kept
  as one field set/map rather than a second parallel one.

  `tool_kind` matters because several openers use a label scheme the
  generic `open_tool` can't reproduce (most of these are pre-existing
  inconsistencies, not introduced here): `open_tool_window_with_color`
  keys on filename-with-extension instead of `file_stem()` (`"color"`);
  `open_git_pulse` keys on a 40-char repo-path slug (`"git-pulse"`,
  `tool_query` = repo path); `open_schedules_window`/`open_claude_window`
  use fixed labels (`"schedules"`/`"claude"`, no file at all); and
  `open_video_window` keys on a hash of the project path (`"video"`,
  `tool_query` = path). Reopening one of these through the generic
  `open_tool` would still produce *a* window, but under the wrong label
  (or, for fixed-label ones, with no file to pass it at all), so the
  position/size restore right after (which looks the window up by the
  originally-recorded label) would silently fail to find it.
  `apply_window_layout` dispatches on `tool_kind` to replay each target
  through the exact function that produced its label.

  Other Studio windows (main, etc.) are always open (hidden, not destroyed,
  per the close handler below), so there's nothing to reopen for them.

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

