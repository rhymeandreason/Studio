use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Url};

// --- Workspace repo resolution -------------------------------------------

/// Minimal view of a project's workspace.json — the `repo` field (for "Code"
/// mode) and the `sprite` (the project's animal, shown in the chat).
#[derive(Deserialize, Default)]
struct Workspace {
    #[serde(default)]
    repo: String,
    #[serde(default)]
    sprite: String,
    #[serde(default)]
    color: String,
}

fn read_workspace(project_path: &str) -> Workspace {
    let file = PathBuf::from(project_path).join("workspace.json");
    std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Resolve a manifest path entry: expand `~`, leave absolute paths, treat the
/// rest as relative to the project folder.
fn resolve_path(home: &Path, project_dir: &Path, raw: &str) -> PathBuf {
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
/// - `"repo"` → the workspace's resolved `repo` path (for code work), falling
///   back to the project folder if no repo is set.
/// - anything else (`"project"`, default) → the **project folder**, where media,
///   notes, and `artifacts/` live — so design artifacts land where the Artifacts
///   panel reads them.
fn claude_cwd(app: &AppHandle, project_path: &str, mode: &str) -> PathBuf {
    let project_dir = PathBuf::from(project_path);
    if mode != "repo" {
        return project_dir;
    }
    let ws = read_workspace(project_path);
    if ws.repo.trim().is_empty() {
        return project_dir;
    }
    match app.path().home_dir() {
        Ok(home) => resolve_path(&home, &project_dir, &ws.repo),
        Err(_) => project_dir,
    }
}

/// GUI apps don't inherit the user's shell PATH (nvm, homebrew, etc.). Resolve
/// it via a login shell, falling back to the app's own PATH plus common dirs.
fn claude_path() -> String {
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

// --- Claude subprocesses --------------------------------------------------

struct ClaudeProc {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct ClaudeState {
    procs: Mutex<HashMap<String, ClaudeProc>>,
}

/// Send a message to a chat session, spawning the `claude` subprocess on first
/// use. Streamed output is routed back via `claude-stream-<key>` events.
#[tauri::command]
fn claude_send(
    app: AppHandle,
    state: tauri::State<ClaudeState>,
    key: String,
    project_path: String,
    model: String,
    text: String,
    resume: Option<String>,
    permission_mode: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut procs = state.procs.lock().unwrap();
    if !procs.contains_key(&key) {
        let mut cmd = Command::new("claude");
        cmd.env("PATH", claude_path())
            .current_dir(claude_cwd(&app, &project_path, cwd.as_deref().unwrap_or("project")))
            .arg("-p")
            .args(["--input-format", "stream-json"])
            .args(["--output-format", "stream-json"])
            .arg("--verbose")
            .arg("--include-partial-messages");
        if !model.trim().is_empty() {
            cmd.args(["--model", model.trim()]);
        }
        if let Some(mode) = permission_mode.as_deref().map(str::trim) {
            if !mode.is_empty() {
                cmd.args(["--permission-mode", mode]);
            }
        }
        if let Some(r) = &resume {
            if !r.trim().is_empty() {
                cmd.args(["--resume", r.trim()]);
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;

        let handle = app.clone();
        let event_key = key.clone();
        std::thread::spawn(move || {
            let event_name = format!("claude-stream-{event_key}");
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let _ = handle.emit(&event_name, line);
            }
            let _ = handle.emit(&event_name, "{\"type\":\"__closed__\"}".to_string());
        });

        let handle = app.clone();
        let event_key = key.clone();
        std::thread::spawn(move || {
            let event_name = format!("claude-stream-{event_key}");
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let payload = serde_json::json!({ "type": "__stderr__", "line": line });
                let _ = handle.emit(&event_name, payload.to_string());
            }
        });

        procs.insert(key.clone(), ClaudeProc { child, stdin });
    }

    let proc = procs.get_mut(&key).unwrap();
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    });
    writeln!(proc.stdin, "{}", msg).map_err(|e| e.to_string())?;
    proc.stdin.flush().map_err(|e| e.to_string())
}

/// Kill a chat session's subprocess, if running.
#[tauri::command]
fn claude_stop(state: tauri::State<ClaudeState>, key: String) {
    if let Some(mut proc) = state.procs.lock().unwrap().remove(&key) {
        let _ = proc.child.kill();
    }
}

// --- Session persistence --------------------------------------------------

/// A short stable hex hash of a string (for per-project filenames + window labels).
fn short_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:x}", h.finish())
}

/// Session-store path. With a project, each project gets its own file under
/// `sessions/` so separate per-project windows never clobber each other's saves.
fn sessions_file(app: &AppHandle, project: &Option<String>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    match project {
        Some(p) if !p.is_empty() => {
            let d = dir.join("sessions");
            let _ = std::fs::create_dir_all(&d);
            Some(d.join(format!("{}.json", short_hash(p))))
        }
        _ => Some(dir.join("claude-sessions.json")),
    }
}

#[tauri::command]
fn read_claude_sessions(app: AppHandle, project: Option<String>) -> String {
    if let Some(f) = sessions_file(&app, &project) {
        if let Ok(text) = std::fs::read_to_string(&f) {
            return text;
        }
    }
    // Migration: a per-project file doesn't exist yet — seed it from the legacy
    // single file by pulling out the sessions for this project. (Written to the
    // per-project file on the next save; the legacy file is left as a backup.)
    if let Some(p) = project.filter(|p| !p.is_empty()) {
        if let Ok(dir) = app.path().app_config_dir() {
            if let Ok(text) = std::fs::read_to_string(dir.join("claude-sessions.json")) {
                if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&text) {
                    let mine: Vec<_> = arr
                        .into_iter()
                        .filter(|s| {
                            s.get("projectPath").and_then(|v| v.as_str()) == Some(p.as_str())
                        })
                        .collect();
                    if !mine.is_empty() {
                        return serde_json::to_string(&mine).unwrap_or_default();
                    }
                }
            }
        }
    }
    String::new()
}

#[tauri::command]
fn save_claude_sessions(app: AppHandle, project: Option<String>, data: String) -> Result<(), String> {
    let file = sessions_file(&app, &project).ok_or("no config dir")?;
    std::fs::write(file, data).map_err(|e| e.to_string())
}

/// Remember the most recent project so a cold launch (no deep link, e.g. Dock)
/// can reopen something useful.
#[tauri::command]
fn save_last_project(app: AppHandle, path: String, name: String, sprite: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let v = serde_json::json!({ "path": path, "name": name, "sprite": sprite });
    std::fs::write(dir.join("last-project.json"), v.to_string()).map_err(|e| e.to_string())
}

// --- Recorded session history (~/.claude/projects) -----------------------

#[derive(Clone, Serialize)]
struct ClaudeHistorySession {
    session_id: String,
    summary: String,
    modified: u64,
}

#[tauri::command]
fn list_claude_project_sessions(
    app: AppHandle,
    project_path: String,
    cwd: Option<String>,
) -> Vec<ClaudeHistorySession> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let cwd_path = claude_cwd(&app, &project_path, cwd.as_deref().unwrap_or("project"));
    let encoded = cwd_path.to_string_lossy().replace('/', "-");
    let dir = home.join(".claude/projects").join(encoded);
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

#[derive(Clone, Serialize)]
struct ClaudeLogMessage {
    role: String,
    text: String,
}

#[tauri::command]
fn read_claude_session_log(
    app: AppHandle,
    project_path: String,
    session_id: String,
    cwd: Option<String>,
) -> Vec<ClaudeLogMessage> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let cwd_path = claude_cwd(&app, &project_path, cwd.as_deref().unwrap_or("project"));
    let encoded = cwd_path.to_string_lossy().replace('/', "-");
    let file = home
        .join(".claude/projects")
        .join(encoded)
        .join(format!("{session_id}.jsonl"));

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

// --- Account usage (/api/oauth/usage) ------------------------------------

fn fetch_usage() -> Result<serde_json::Value, String> {
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

/// Async so the blocking Keychain read + network call run OFF the main thread.
/// (A synchronous command blocks the main thread; the Keychain access prompt
/// also needs the main thread, which deadlocks the app on first use.)
#[tauri::command]
async fn get_claude_usage() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(fetch_usage)
        .await
        .map_err(|e| e.to_string())?
}

// --- Deep links & per-project windows ------------------------------------

/// Percent-encode a query value (RFC 3986 unreserved kept).
fn url_encode(s: &str) -> String {
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

/// Show & focus any window (fallback for Dock/single-instance with no project).
fn show_any_window(app: &AppHandle) {
    if let Some(win) = app.webview_windows().values().next() {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Open (or focus) a dedicated window for `project`. Each project gets its own
/// window — labelled `proj-<hash>` — so different projects can sit side by side.
/// The project is passed in the window URL so the frontend knows it immediately.
fn open_project_window(app: &AppHandle, project: &str, name: &str) {
    use tauri_plugin_window_state::{StateFlags, WindowExt};

    // MUST run on the main thread: `WebviewWindowBuilder::build()` builds inline
    // when called on the main thread, but blocks waiting on the main thread when
    // called from any other thread — and a second such off-thread build deadlocks
    // on macOS. All callers route here via `run_on_main_thread`, which also
    // serializes requests (so two opens for the same project can't both build).
    let label = format!("proj-{}", short_hash(project));
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }

    let ws = read_workspace(project);
    let color = ws.color.trim();
    let url = format!(
        "claude/index.html?project={}&name={}&sprite={}&color={}",
        url_encode(project),
        url_encode(name),
        url_encode(&ws.sprite),
        url_encode(color),
    );
    let title = if name.is_empty() {
        "Studio Claude".to_string()
    } else {
        format!("Claude · {name}")
    };
    // Custom chrome: the page paints its own title bar (kit/window-chrome.js) and
    // tints the whole window with the project color. transparent + shadowless so
    // the page's rounded corners read cleanly (see docs/tools.md window style).
    match tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(600.0, 800.0)
        .min_inner_size(420.0, 360.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .build()
    {
        Ok(win) => {
            let _ = win.restore_state(StateFlags::SIZE | StateFlags::POSITION);
        }
        Err(e) => eprintln!("[companion] failed to build window {label}: {e}"),
    }
}

/// Handle `studio-claude://open?project=<path>&name=<name>`.
fn handle_open_url(app: &AppHandle, url: &Url) {
    let mut project: Option<String> = None;
    let mut name: Option<String> = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "project" => project = Some(v.to_string()),
            "name" => name = Some(v.to_string()),
            _ => {}
        }
    }
    let Some(path) = project else {
        show_any_window(app);
        return;
    };
    let name = name.unwrap_or_else(|| {
        std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string()
    });
    open_project_window(app, &path, &name);
}

/// Open whatever project a `studio-claude://open?…` URL in `argv` names. Studio
/// launches the companion with `open -n … --args <url>`, so the request rides in
/// as a plain process argument — both for the cold launch (our own argv) and for
/// warm opens (the single-instance callback's argv). Returns whether a URL was
/// found and handled.
fn handle_open_args(app: &AppHandle, argv: &[String]) -> bool {
    let Some(raw) = argv.iter().find(|a| a.starts_with("studio-claude://")) else {
        return false;
    };
    match Url::parse(raw) {
        Ok(url) => {
            // Window creation must happen on the main thread; queue it there.
            let h = app.clone();
            let _ = app.run_on_main_thread(move || handle_open_url(&h, &url));
            true
        }
        Err(e) => {
            eprintln!("[companion] bad url arg {raw:?}: {e}");
            false
        }
    }
}

/// On a cold launch with no deep link, reopen the most recent project (if any).
fn open_last_project(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(dir.join("last-project.json")) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    if let Some(path) = v.get("path").and_then(|p| p.as_str()) {
        let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
        open_project_window(app, path, name);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // One owner process; Studio launches each project with `open -n … --args
        // <url>`, forcing a fresh instance whose argv is forwarded here by the
        // single-instance plugin (then it exits). This replaces deep links, whose
        // warm Apple-Event delivery to a running app is unreliable on macOS.
        // (Must be the FIRST plugin registered.)
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !handle_open_args(app, &argv) {
                let h = app.clone();
                let _ = app.run_on_main_thread(move || show_any_window(&h));
            }
        }))
        // Only restore geometry — NOT decorations. The default builder persists
        // DECORATIONS and would force the native title bar back on, defeating the
        // custom chrome (decorations(false)). See docs/tools.md window-state gotcha.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .manage(ClaudeState::default())
        .invoke_handler(tauri::generate_handler![
            claude_send,
            claude_stop,
            read_claude_sessions,
            save_claude_sessions,
            save_last_project,
            list_claude_project_sessions,
            read_claude_session_log,
            get_claude_usage,
        ])
        .setup(|app| {
            // Cold launch: the project URL rides in on our own argv.
            let opened = handle_open_args(app.handle(), &std::env::args().collect::<Vec<_>>());
            // Fall back to the last project / an empty window only if no URL was
            // passed. The queued open above runs on the main thread once the event
            // loop starts, so wait a beat before deciding nothing opened — and do
            // the fallback's own window work back on the main thread.
            let h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                let _ = h.clone().run_on_main_thread(move || {
                    if !opened && h.webview_windows().is_empty() {
                        open_last_project(&h);
                    }
                    if h.webview_windows().is_empty() {
                        let _ = tauri::WebviewWindowBuilder::new(
                            &h,
                            "main",
                            tauri::WebviewUrl::App("claude/index.html".into()),
                        )
                        .title("Studio Claude")
                        .inner_size(600.0, 800.0)
                        .min_inner_size(420.0, 360.0)
                        .decorations(false)
                        .transparent(true)
                        .shadow(false)
                        .build();
                    }
                });
            });
            Ok(())
        })
        // Closing a window hides it (keeps Claude sessions alive); the Dock icon
        // or opening the project again from Studio brings it back.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Claude companion")
        .run(|app, event| {
            // macOS: clicking the Dock icon reopens a hidden window.
            if let tauri::RunEvent::Reopen { .. } = event {
                show_any_window(app);
            }
        });
}
