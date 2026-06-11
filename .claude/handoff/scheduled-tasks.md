# Scheduled tasks (Workspace tab)

## Goal
Add per-project recurring "claude -p" tasks to the Workspace tab, runnable
unattended, with output written to a markdown file.

## Status — done
All implemented, `cargo check` passes, committed on branch
`Add-Workspace-Features`:

- `ScheduledTask` struct + `Workspace.schedules` (id, prompt, time HH:MM,
  days, enabled, model, outputFile, lastRun, lastRunAt, lastRunOk) in
  `src-tauri/src/lib.rs`.
- Background scheduler (`start_scheduler`, 30s poll) fires due tasks via
  `claude -p <prompt> --permission-mode bypassPermissions [--model ...]` in
  the project's repo dir, writes `<project>/<outputFile>` (default
  `Scheduled Output.md`, `## Output`/`## Error` section, no prompt echoed),
  persists `lastRun`/`lastRunAt`/`lastRunOk`, emits `schedule-ran`.
- `run_schedule_now` command + ▶ "Run now" button per task (manual test
  without waiting on the clock).
- `start_caffeinate()` (`caffeinate -s -w <pid>`) prevents AC sleep while
  Studio runs.
- Wake scheduling: `update_wake_schedule` (admin-prompted via osascript,
  triggered on time/days/enabled/remove edits) + `roll_wake_schedule`
  (best-effort `sudo -n` re-apply after each run) maintain a 3-slot
  `pmset schedule wake` schedule (capped/deduped, `compute_wake_times`).
- Frontend UI in `src/workspace.js` (`renderSchedules`/`buildScheduleRow`/
  `initSchedules`), markup in `src/index.html` (`#ws-schedules`,
  `#ws-schedule-add`), styles in `src/styles.css` (`.ws-schedule*`). Enabled
  toggle reuses `.claude-toggle` pill-switch style from `claude/claude.css`.
- `docs/workspace.md` updated with full "Scheduled tasks" + wake-scheduling
  sections.

## Next steps
Nothing pending — feature is complete per user requests so far. Possible
future ideas (not requested yet):
- More robust weather fetching (discussed: have Rust fetch via Open-Meteo
  and inject into prompt, since WebFetch sometimes needs permission/fails).
- Sudoers NOPASSWD entry for `pmset` for fully prompt-free wake renewal
  (documented as optional in docs/workspace.md, not automated).

## Key context
- All committed; latest commit `73a025d` "Cap pmset wake schedule at 3
  slots, shared across tasks".
- `pmset schedule cancelall` clears ALL system wake/sleep events, not just
  Studio's — single-user assumption, documented.
- Headless runs use `bypassPermissions` — be mindful what prompts get
  scheduled (full tool access, unattended).
