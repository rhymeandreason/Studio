# Claude companion window

An in-app chat UI built on top of the Claude Code CLI — a custom front end that
drives `claude` as a subprocess, as an alternative to `claude.mode: "terminal"`
(which just opens Terminal). One window, scoped to one project at a time.

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
`claude_stop` kills a session's subprocess.

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
- **Context** — per session, computed from the `result` event's token usage vs.
  the model context window; stored on the session so it persists/restores.
- **5-hour / 7-day** — *account-wide* quota, the same numbers behind Claude's
  `/usage`. `get_claude_usage` reads the OAuth token from the macOS Keychain
  (service `Claude Code-credentials`) and GETs
  `https://api.anthropic.com/api/oauth/usage` (header
  `anthropic-beta: oauth-2025-04-20`). Refreshed on open, after each turn, and on
  `rate_limit_event`. (First fetch after a rebuild may prompt for Keychain
  access.)

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
