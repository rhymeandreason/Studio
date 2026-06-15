# Claude companion app

A chat UI built on top of the Claude Code CLI — a custom front end that drives
`claude` as a subprocess, as an alternative to `claude.mode: "terminal"` (which
just opens Terminal). **One window per project**, opened side by side — each
window is scoped to its project and owns its own sessions.

## Architecture: standalone app (separate process)
The companion runs as its **own Tauri app** (`companion/`), separate from
Studio, so it survives Studio rebuilds and keeps its `claude` subprocesses
alive. Studio only *launches* it.

### How a project window opens (single-instance, not deep links)
Studio launches the companion with `open -n -b com.studio.claude --args
"studio-claude://open?project=<path>&name=<name>"` (`launch_claude_app` in
Studio's `lib.rs`). The `studio-claude://…` string is **just a process argument**,
not a URL routed by macOS — `open -n` forces a fresh instance every time.

- **First (cold) launch:** the companion reads the URL from its own `argv` in
  `setup()` and opens that project's window.
- **Warm launch (companion already running):** the fresh instance's `argv` is
  forwarded to the running owner by `tauri-plugin-single-instance`; that owner
  opens/focuses the project window, and the new instance exits. Process count
  stays at 1.

We deliberately do **not** use `tauri-plugin-deep-link` / the `studio-claude://`
URL *scheme*: warm Apple-Event delivery (`application:openURLs:`) to an
already-running, ad-hoc-signed app is unreliable on macOS and was the source of
the "second window hangs / windows vanish" bugs.

**Two hard-won invariants** (don't regress these):
- **Build windows on the main thread.** `WebviewWindowBuilder::build()` builds
  inline on the main thread, but *blocks* waiting on it when called from another
  thread — and a second off-thread build **deadlocks** on macOS (app goes "not
  responding"). All window creation routes through `app.run_on_main_thread(…)`,
  which also serializes requests so two opens for the same project can't both
  build. (The earlier "must build off the main thread" note was backwards.)
- **Keep the LaunchServices registration clean.** Old DMG builds register more
  `com.studio.claude` bundles claiming the same id; a stale one can hijack
  launches. The bundle target is `app` only (no DMG) to avoid creating new
  ones. To purge: unmount stray `/Volumes/dmg.*` + `/Volumes/Studio Claude`,
  then `lsregister -kill -r -domain local -domain user` and `lsregister -f
  "<the real .app>"`.

Per-project windows are labelled `proj-<hash(projectPath)>` (idempotent: opening
the same project again just focuses the existing window). Each project also gets
its own sessions file under `sessions/<hash>.json` in the config dir.

Studio's in-process `open_claude_window` + the other `claude_*` commands are
**kept** for live frontend dev (⌥-click the Workspace Claude button), not wired
to the normal button. The companion reuses the shared frontend in `src/claude/*`
(its `frontendDist` is `../../src`, window URL
`claude/index.html?project=…&name=…&sprite=…`).

- **Frontend** (`src/claude/claude.js`) is companion-only. It has no access to
  Studio's `list_projects`/`get_active_project`; it reads its project from the
  window URL at init and namespaces `localStorage` per project.

**Dev/run:** `cd companion && npm install && npm run tauri dev` (separate from
Studio's `npm run tauri dev`). Build a real app with `npm run tauri build` in
`companion/` (app-only bundle) and run it once so macOS registers the bundle id;
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

## Working directory (Artifacts vs Code, per session)
The chat bar has a cwd dropdown (left of the model select): **Artifacts** runs
`claude` in the **project folder** (where media, notes, and `artifacts/` live —
the default, so design artifacts land where the Artifacts panel reads them);
**Code** runs it in the workspace's **git repo**.

`claude_cwd(app, project_path, mode)` resolves it: `mode == "repo"` →
workspace `repo` field (with `~`/relative expansion, fallback to the project
folder if unset); anything else → the project folder. The mode is per-session
(persisted like model/permission) and threaded through `claude_send` plus the
session-history lookups (`list_claude_project_sessions` /
`read_claude_session_log`), so Artifacts and Code sessions each show their own
"Recent" list (Claude records sessions under the cwd it ran in). The headless
scheduled-task runner always uses `"repo"`. Same logic in the companion and the
in-Studio backend.

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
