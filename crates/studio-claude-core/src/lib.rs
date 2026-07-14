//! Claude Code integration shared by the Studio menu-bar app and the
//! standalone Claude companion (companion/). Everything that talks to Claude
//! Code's on-disk formats, CLI flags, or OAuth endpoint lives here so a
//! format change can't silently break one of the two apps. No tauri types —
//! the apps keep their own #[tauri::command] wrappers and event emits.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};

use serde::Serialize;

// --- Path resolution -------------------------------------------------------

/// Resolve a manifest path entry: expand `~`, leave absolute paths, and treat
/// everything else as relative to the project folder.
pub fn resolve_path(home: &Path, project_dir: &Path, raw: &str) -> PathBuf {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else if raw == "~" {
        home.to_path_buf()
    } else if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        project_dir.join(raw)
    }
}

/// The directory Claude runs in for a project, by mode (the chat's cwd dropdown):
/// - `"repo"` → the workspace's resolved `repo` field (for code work), falling
///   back to the project folder if no repo is set (or no home dir).
/// - anything else (`"project"`, default) → the **project folder**, where media,
///   notes, and `artifacts/` live — so design artifacts land where the Artifacts
///   panel reads them.
/// `repo_field` is the already-read `repo` string from workspace.json (each app
/// has its own Workspace struct + reader).
pub fn claude_cwd(home: Option<&Path>, project_path: &str, mode: &str, repo_field: &str) -> PathBuf {
    let project_dir = PathBuf::from(project_path);
    if mode != "repo" || repo_field.trim().is_empty() {
        return project_dir;
    }
    match home {
        Some(home) => resolve_path(home, &project_dir, repo_field),
        None => project_dir,
    }
}

/// GUI apps don't inherit the user's shell PATH (nvm, homebrew, etc.), so
/// spawning "claude" — and "claude" itself spawning "node" via its shebang —
/// often fails even though it works fine from a terminal. Resolve PATH via a
/// login shell (which sources nvm/profile scripts), falling back to the
/// app's own PATH plus common install dirs.
pub fn claude_path() -> String {
    if let Ok(out) = Command::new("/bin/zsh")
        .args(["-l", "-c", "echo $PATH"])
        .output()
    {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() {
            return path;
        }
    }
    let mut path = std::env::var("PATH").unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        path.push(':');
        path.push_str(extra);
    }
    path
}

/// Percent-encode a string for use in a URL query value (RFC 3986 unreserved
/// kept; everything else encoded).
pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// --- Recorded session history (~/.claude/projects) --------------------------

/// One existing Claude Code session found on disk for a project.
#[derive(Clone, Serialize)]
pub struct ClaudeHistorySession {
    pub session_id: String,
    pub summary: String,
    pub modified: u64,
}

/// The `~/.claude/projects/<encoded>` directory Claude Code records a cwd's
/// sessions under (path with `/` → `-`).
fn sessions_dir(home: &Path, cwd: &Path) -> PathBuf {
    let encoded = cwd.to_string_lossy().replace('/', "-");
    home.join(".claude/projects").join(encoded)
}

/// List Claude Code sessions previously recorded for `cwd`, by reading
/// `~/.claude/projects/<encoded-cwd>/*.jsonl` (the format Claude Code itself
/// uses for `--resume`). Summary = first user message (60 chars); sessions
/// with no user text are skipped. Newest first.
pub fn list_project_sessions(home: &Path, cwd: &Path) -> Vec<ClaudeHistorySession> {
    let dir = sessions_dir(home, cwd);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // First user message becomes the summary.
        let mut summary = String::new();
        if let Ok(text) = std::fs::read_to_string(&path) {
            for line in text.lines() {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                    let content = &v["message"]["content"];
                    let text = if let Some(s) = content.as_str() {
                        Some(s.to_string())
                    } else if let Some(arr) = content.as_array() {
                        arr.iter()
                            .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                            .and_then(|b| b["text"].as_str())
                            .map(|s| s.to_string())
                    } else {
                        None
                    };
                    if let Some(text) = text {
                        if !text.trim().is_empty() {
                            summary = text.trim().chars().take(60).collect();
                            break;
                        }
                    }
                }
            }
        }
        if summary.is_empty() {
            continue;
        }

        sessions.push(ClaudeHistorySession {
            session_id: session_id.to_string(),
            summary,
            modified,
        });
    }
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    sessions
}

/// One replayed message from a recorded session log.
#[derive(Clone, Serialize)]
pub struct ClaudeLogMessage {
    pub role: String,
    pub text: String,
}

/// Read the full transcript of a recorded Claude Code session
/// (`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`) so a UI can show
/// the past chat log when resuming a session. Returns user/assistant text and
/// a compact summary of each tool call, in order.
pub fn read_session_log(home: &Path, cwd: &Path, session_id: &str) -> Vec<ClaudeLogMessage> {
    let file = sessions_dir(home, cwd).join(format!("{session_id}.jsonl"));
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let content = &v["message"]["content"];
        // Content is either a plain string or an array of typed blocks.
        if let Some(s) = content.as_str() {
            let s = s.trim();
            if !s.is_empty() {
                out.push(ClaudeLogMessage {
                    role: kind.to_string(),
                    text: s.to_string(),
                });
            }
            continue;
        }
        let Some(blocks) = content.as_array() else {
            continue;
        };
        for block in blocks {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(s) = block["text"].as_str() {
                        if !s.trim().is_empty() {
                            out.push(ClaudeLogMessage {
                                role: kind.to_string(),
                                text: s.trim().to_string(),
                            });
                        }
                    }
                }
                Some("tool_use") => {
                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                    out.push(ClaudeLogMessage {
                        role: "tool".to_string(),
                        text: format!("{name} {input}"),
                    });
                }
                _ => {}
            }
        }
    }
    out
}

// --- Account usage (/api/oauth/usage) ---------------------------------------

/// Current account usage (the numbers behind Claude's `/usage`): 5-hour and
/// 7-day quota utilization, fetched from `/api/oauth/usage` with the OAuth
/// token Claude Code stores in the macOS Keychain. Account-wide, not per
/// session. Returns the raw JSON (`five_hour`/`seven_day`/`extra_usage`).
/// BLOCKING (Keychain + network) — call off the main thread; the Keychain
/// access prompt needs the main thread, so a synchronous main-thread call
/// deadlocks the app on first use.
pub fn fetch_usage() -> Result<serde_json::Value, String> {
    // The OAuth token lives in the login keychain under this service name.
    let out = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("Could not read Claude credentials from Keychain".into());
    }
    let creds: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let token = creds["claudeAiOauth"]["accessToken"]
        .as_str()
        .ok_or("No OAuth access token found")?;

    let resp = ureq::get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("usage request failed ({code})"),
            other => other.to_string(),
        })?;
    resp.into_json().map_err(|e| e.to_string())
}

// --- Claude subprocess (claude -p, stream-json) ------------------------------

/// A running `claude -p` subprocess for one chat session. Kill it with
/// [`ClaudeSession::kill`]; dropping it leaves the process running.
pub struct ClaudeSession {
    child: Child,
    stdin: ChildStdin,
}

/// Spawn `claude -p --input-format stream-json --output-format stream-json
/// --verbose --include-partial-messages` in `cwd`, with optional model,
/// permission mode, and session id to resume (blank/whitespace values are
/// skipped). Two reader threads stream output back:
/// - `on_line(line)` gets each non-empty stdout line (a stream-json event),
///   then the sentinel `{"type":"__closed__"}` when stdout closes.
/// - `on_stderr_line(line)` gets each non-empty stderr line.
pub fn spawn_claude_session(
    cwd: &Path,
    model: &str,
    permission_mode: Option<&str>,
    resume: Option<&str>,
    on_line: impl Fn(String) + Send + 'static,
    on_stderr_line: impl Fn(String) + Send + 'static,
) -> Result<ClaudeSession, String> {
    let mut cmd = Command::new("claude");
    cmd.env("PATH", claude_path())
        .current_dir(cwd)
        .arg("-p")
        .args(["--input-format", "stream-json"])
        .args(["--output-format", "stream-json"])
        .arg("--verbose")
        .arg("--include-partial-messages");
    if !model.trim().is_empty() {
        cmd.args(["--model", model.trim()]);
    }
    if let Some(mode) = permission_mode.map(str::trim) {
        if !mode.is_empty() {
            cmd.args(["--permission-mode", mode]);
        }
    }
    if let Some(r) = resume.map(str::trim) {
        if !r.is_empty() {
            cmd.args(["--resume", r]);
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take().ok_or("no stdin")?;

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            on_line(line);
        }
        on_line("{\"type\":\"__closed__\"}".to_string());
    });

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            on_stderr_line(line);
        }
    });

    Ok(ClaudeSession { child, stdin })
}

impl ClaudeSession {
    /// Write one user message (stream-json format) to the session's stdin.
    pub fn send_text(&mut self, text: &str) -> Result<(), String> {
        let msg = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
        });
        writeln!(self.stdin, "{}", msg).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())
    }

    /// Kill the subprocess.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }
}
