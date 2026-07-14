use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;
use studio_claude_core as core;
use studio_claude_core::{url_encode, ClaudeHistorySession, ClaudeLogMessage, ClaudeSession};
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

/// The directory Claude runs in for a project, by mode (the chat's cwd
/// dropdown; see `studio_claude_core::claude_cwd`).
fn claude_cwd(app: &AppHandle, project_path: &str, mode: &str) -> PathBuf {
    let home = app.path().home_dir().ok();
    let ws = read_workspace(project_path);
    core::claude_cwd(home.as_deref(), project_path, mode, &ws.repo)
}

// --- Claude subprocesses --------------------------------------------------

#[derive(Default)]
struct ClaudeState {
    procs: Mutex<HashMap<String, ClaudeSession>>,
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
        let event_name = format!("claude-stream-{key}");
        let out_handle = app.clone();
        let out_event = event_name.clone();
        let err_handle = app.clone();
        let session = core::spawn_claude_session(
            &claude_cwd(&app, &project_path, cwd.as_deref().unwrap_or("project")),
            &model,
            permission_mode.as_deref(),
            resume.as_deref(),
            move |line| {
                let _ = out_handle.emit(&out_event, line);
            },
            move |line| {
                let payload = serde_json::json!({ "type": "__stderr__", "line": line });
                let _ = err_handle.emit(&event_name, payload.to_string());
            },
        )?;
        procs.insert(key.clone(), session);
    }

    procs.get_mut(&key).unwrap().send_text(&text)
}

/// Kill a chat session's subprocess, if running.
#[tauri::command]
fn claude_stop(state: tauri::State<ClaudeState>, key: String) {
    if let Some(mut session) = state.procs.lock().unwrap().remove(&key) {
        session.kill();
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
    core::list_project_sessions(&home, &cwd_path)
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
    core::read_session_log(&home, &cwd_path, &session_id)
}

// --- Account usage (/api/oauth/usage) ------------------------------------

/// Async so the blocking Keychain read + network call run OFF the main thread.
/// (A synchronous command blocks the main thread; the Keychain access prompt
/// also needs the main thread, which deadlocks the app on first use.)
#[tauri::command]
async fn get_claude_usage() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(core::fetch_usage)
        .await
        .map_err(|e| e.to_string())?
}

// --- Deep links & per-project windows ------------------------------------

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
