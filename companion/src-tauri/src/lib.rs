use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

// --- Workspace repo resolution -------------------------------------------

/// Minimal view of a project's workspace.json — only the `repo` field, used to
/// run Claude in the actual git repo rather than the project folder.
#[derive(Deserialize, Default)]
struct Workspace {
    #[serde(default)]
    repo: String,
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

/// The directory Claude should run in for a project: the workspace's resolved
/// `repo` path if set, otherwise the project folder itself.
fn claude_cwd(app: &AppHandle, project_path: &str) -> PathBuf {
    let project_dir = PathBuf::from(project_path);
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
) -> Result<(), String> {
    let mut procs = state.procs.lock().unwrap();
    if !procs.contains_key(&key) {
        let mut cmd = Command::new("claude");
        cmd.env("PATH", claude_path())
            .current_dir(claude_cwd(&app, &project_path))
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

#[tauri::command]
fn read_claude_sessions(app: AppHandle) -> String {
    let dir = match app.path().app_config_dir() {
        Ok(d) => d,
        Err(_) => return String::new(),
    };
    std::fs::read_to_string(dir.join("claude-sessions.json")).unwrap_or_default()
}

#[tauri::command]
fn save_claude_sessions(app: AppHandle, data: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("claude-sessions.json"), data).map_err(|e| e.to_string())
}

// --- Recorded session history (~/.claude/projects) -----------------------

#[derive(Clone, Serialize)]
struct ClaudeHistorySession {
    session_id: String,
    summary: String,
    modified: u64,
}

#[tauri::command]
fn list_claude_project_sessions(app: AppHandle, project_path: String) -> Vec<ClaudeHistorySession> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let cwd = claude_cwd(&app, &project_path);
    let encoded = cwd.to_string_lossy().replace('/', "-");
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
) -> Vec<ClaudeLogMessage> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let cwd = claude_cwd(&app, &project_path);
    let encoded = cwd.to_string_lossy().replace('/', "-");
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

#[tauri::command]
fn get_claude_usage() -> Result<serde_json::Value, String> {
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

// --- Deep links -----------------------------------------------------------

/// Show & focus the window.
fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Handle `studio-claude://open?project=<path>&name=<name>`: surface the window
/// and tell the frontend which project to start a session in (`claude-jump`).
fn handle_open_url(app: &AppHandle, url: &Url) {
    show_window(app);
    let mut project: Option<String> = None;
    let mut name: Option<String> = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "project" => project = Some(v.to_string()),
            "name" => name = Some(v.to_string()),
            _ => {}
        }
    }
    if project.is_none() {
        return;
    }
    let _ = app.emit(
        "claude-jump",
        serde_json::json!({ "key": null, "projectPath": project, "projectName": name }),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be registered first.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ClaudeState::default())
        .invoke_handler(tauri::generate_handler![
            claude_send,
            claude_stop,
            read_claude_sessions,
            save_claude_sessions,
            list_claude_project_sessions,
            read_claude_session_log,
            get_claude_usage,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                // Register the URL scheme at runtime so `open studio-claude://…`
                // reaches this app even from a dev build.
                let _ = app.deep_link().register_all();
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_open_url(&handle, &url);
                }
            });
            // A cold start launched via the scheme.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_open_url(app.handle(), &url);
                }
            }
            Ok(())
        })
        // Closing the window hides it (keeps Claude sessions alive); the Dock
        // icon or a new deep link brings it back.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Claude companion")
        .run(|app, event| {
            // macOS: clicking the Dock icon reopens the hidden window.
            if let tauri::RunEvent::Reopen { .. } = event {
                show_window(app);
            }
        });
}
