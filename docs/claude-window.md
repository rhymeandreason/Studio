# Claude companion app

A chat UI built on top of the Claude Code CLI — a custom front end that drives
`claude` as a subprocess, as an alternative to `claude.mode: "terminal"` (which
just opens Terminal). One window, scoped to one project at a time.

## Architecture: standalone app (separate process)
The companion runs as its **own Tauri app** (`companion/`), separate from
Studio, so it survives Studio rebuilds and keeps its `claude` subprocesses
alive. Studio only *launches* it.

- **Studio side:** the Workspace "Claude" button calls `launch_claude_app`
  (`lib.rs`), which runs `open "studio-claude://open?project=<path>&name=<name>"`.
  Studio's in-process `open_claude_window` + the other `claude_*` commands are
  **kept but unused** (reserved for possible future in-Studio use).
- **Companion side:** `companion/src-tauri` registers the `studio-claude://` URL
  scheme (`tauri-plugin-deep-link` + `tauri-plugin-single-instance`). On a deep
  link it shows/focuses its window and emits `claude-jump` with the project —
  the same flow the in-Studio window used. It reuses the shared frontend in
  `src/claude/*` (its `frontendDist` is `../../src`, window URL `claude/index.html`).
- **Frontend** (`src/claude/claude.js`) is now companion-only. It has no access
  to Studio's `list_projects`/`get_active_project`; it remembers the project
  from the deep link in `localStorage["claude.lastProject"]` and uses that for
  new sessions.

**Dev/run:** `cd companion && npm install && npm run tauri dev` (separate from
Studio's `npm run tauri dev`). Build a real app with `npm run tauri build` in
`companion/` and run it once so macOS registers the `studio-claude://` scheme;
after that Studio's button launches it. The companion has its **own** sessions
store and config dir (`com.studio.claude`), separate from Studio's.

## Files
- `src/claude/index.html` — the window markup (top bar, usage meters, sessions
  sidebar, transcript, input).
- `src/claude/claude.js` — all window logic (sessions, streaming, usage, etc.).
- `src/claude/claude.css` — window styles (uses `system-ui`, fills the window).
- `src/claude/claude-icon.svg` — Claude mark used in the bar and on assistant
  bubbles.
- `src-tauri/src/lib.rs` — the `claude_*` / `*_claude_*` commands (see below).
- `src-tauri/capabilities/claude.json` — capability for the `claude` window.
  **Required:** a Tauri v2 window not covered by a capability cannot use IPC
  (`invoke`/`listen`) — the new window label `claude` matched neither `main` nor
  `tool-*`, so without this file the window loads but every command is denied.
  Any window-plugin call needs its own permission too: `setTitle()` needs
  `core:window:allow-set-title` (already added). Same gotcha applies to future
  `getCurrentWindow()` calls.

Backend commands (`lib.rs`): `open_claude_window`, `claude_send`, `claude_stop`,
`read_claude_sessions` / `save_claude_sessions`, `list_claude_project_sessions`,
`read_claude_session_log`, `get_claude_usage`.

## Opening
`workspace.js` → the Claude button calls `invoke("open_claude_window", { projectPath })`.
The backend creates (or focuses) the window with label `claude`, then emits
`claude-jump` with the project. The window's `claude-jump` listener scopes the
sidebar to that project and opens its **last active** session (else its most
recent, else a new one).

## Working directory (the repo, not the project folder)
`claude_cwd(project_path)` resolves the workspace's `repo` field (with `~` /
relative expansion) and falls back to the project folder. Both `claude_send` and
the history lookups use it, so the companion window runs `claude` in the actual
git repo — consistent with terminal-mode launch.

## Process & streaming model
Each UI session maps to one `claude -p` subprocess (`claude_send`), spawned on
first message with `--input-format stream-json --output-format stream-json
--verbose --include-partial-messages` (plus `--model` and `--permission-mode`).
PATH is resolved via a login shell (`claude_path`) because GUI apps don't inherit
the user's shell PATH. The subprocess's stdout/stderr lines are emitted to the
frontend as `claude-stream-<key>` events; the frontend parses the stream-json
message types (`system`/`stream_event`/`assistant`/`result`/`rate_limit_event`).
User messages are written to the subprocess stdin as a stream-json `user` frame.
`claude_stop` kills a session's subprocess (used by the **stop button**, which
also finalizes streamed text; the next message respawns with `--resume`).

## Sessions
- Persisted opaque JSON via `read_claude_sessions` / `save_claude_sessions`
  (`claude-sessions.json` in the app config dir). Transcripts are trimmed to the
  last 50 turns on save.
- Sidebar is **scoped to the current project** (`currentProjectPath`).
- Each row shows the model as a pill, and supports **rename** (inline) and
  **delete** (drops the in-app record + kills the subprocess; does *not* delete
  the on-disk `~/.claude` log, so deleted sessions can reappear under "Recent").
- **Last active** session is remembered in `localStorage["claude.activeKey"]`
  and restored on window/project open.

## Outside sessions ("Recent")
Sessions started outside Studio are read from
`~/.claude/projects/<encoded-cwd>/*.jsonl` (`list_claude_project_sessions`).
Resuming one loads its past transcript via `read_claude_session_log` (parses the
jsonl into user/assistant text + tool-call summaries) and continues it with
`--resume`. A toggle in the "Recent" header controls visibility, persisted in
`localStorage["claude.includeOutside"]`.

## Usage bars
- **Context** — per session, current context-window *occupancy*. Taken from the
  **last turn's** prompt usage (`input + cache_read + cache_creation` off the
  latest `message_start`/`assistant` message), divided by the largest
  `modelUsage` context window. **Do not** use `result.usage`/`modelUsage` token
  totals — those are cumulative over the process lifetime and grow past the
  window. Stored on the session so it persists/restores; a load-time migration
  drops any stored value where `used > contextWindow` (old buggy data).
- **5-hour bar + 7-day pie** — *account-wide* quota, the same numbers behind
  Claude's `/usage`. `get_claude_usage` reads the OAuth token from the macOS
  Keychain (service `Claude Code-credentials`) and GETs
  `https://api.anthropic.com/api/oauth/usage` (header
  `anthropic-beta: oauth-2025-04-20`), returning `five_hour`/`seven_day`
  utilization. The endpoint **rate-limits (429)** if hit too often, so the
  frontend: throttles to once/60s, fetches only on open + after each `result`
  (not on `rate_limit_event`), caches the last value in
  `localStorage["claude.accountUsage"]` (so the bar never blanks), and retries
  ~30s after a failed fetch. (First fetch after a rebuild may prompt for Keychain
  access.)
- **Live progress** — while a turn runs, a status bar under the transcript shows
  activity (Working / Running `<tool>` / Writing), elapsed seconds, and live
  token counts: context from `message_start`, growing output from `message_delta`.

## Permission mode
Per-session dropdown (Ask=`default` / Accept edits=`acceptEdits` / Plan=`plan` /
Bypass=`bypassPermissions`) passed as `--permission-mode`. Because the flag is
fixed at spawn, changing it mid-session stops the subprocess so the next message
restarts it (with `--resume`, preserving context).

**Limitation:** there are no per-call approve/deny buttons. Interactive
permission prompts surface only via Claude Code's bidirectional **control
protocol** (`can_use_tool` control_requests, requiring an `initialize`
handshake) — which the raw stream-json pipe here does not speak. Adding real
buttons would mean either driving that control protocol or switching to the
Agent SDK's `canUseTool` callback. The permission-mode selector is the interim.

## UI / layout
- **Layout:** `.claude-app` is a row — the full-height sessions sidebar on the
  left, everything else in a `.claude-right` column (top tab bar, header, usage
  meters, transcript, input).
- **Top tab bar:** square sidebar toggle (`side_navigation`, inverts when open),
  new-session button, then one **tab per session** for the current project
  (shown with 2+ sessions; click to switch, × to close).
- **Header:** clickable **session title** (click to rename inline) + model and
  permission pickers. The pickers are custom `.notedrop` dropdowns
  (`createDropdown`) matching the Notes page, not native `<select>`s, but expose
  a `.value` + `change` event.
- **Transcript:** stick-to-bottom auto-scroll (only follows when already at the
  bottom; forced on your own message and session switch). Text is selectable and
  double-click copies a bubble. **Tool calls render collapsed** (name + chevron,
  expand to see input). Minimal hover-reveal scrollbar.
- **Window:** title shows `Claude · <project>` (`setTitle`); size and position
  persist via `tauri_plugin_window_state` — the dynamically-created window is
  restored with `restore_state` in `open_claude_window`.
