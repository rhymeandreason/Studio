mod bridge;

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

fn load_workspace(project_path: &str) -> Workspace {
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
    let ws = load_workspace(project_path);
    core::claude_cwd(home.as_deref(), project_path, mode, &ws.repo)
}

// --- Events -----------------------------------------------------------------

/// Emit an event to this app's windows AND to bridge clients (Studio's
/// embedded panel). Every event a view listens for must go through here.
fn emit_all(app: &AppHandle, event: &str, payload: String) {
    let _ = app.emit(event, payload.clone());
    bridge::broadcast(app, event, &payload);
}

/// Put a synthetic message on a session's stream, so every view of it (this
/// app's window and Studio's panel) sees the same thing. Types are `__x__`.
fn emit_stream(app: &AppHandle, key: &str, msg: serde_json::Value) {
    emit_all(app, &format!("claude-stream-{key}"), msg.to_string());
}

// --- Claude subprocesses --------------------------------------------------

#[derive(Default)]
struct ClaudeState {
    procs: Mutex<HashMap<String, ClaudeSession>>,
}

// Each command is one function taking its args struct; the #[tauri::command]
// wrappers (this app's windows) and `bridge_call` (Studio's panel) both call it.
// Field names are camelCase on the wire, matching Tauri's invoke convention.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendArgs {
    key: String,
    project_path: String,
    model: String,
    text: String,
    resume: Option<String>,
    permission_mode: Option<String>,
    cwd: Option<String>,
    resume_cwd: Option<String>,
    content: Option<serde_json::Value>,
    /// The user's message as the sending view shows it ({text, images: thumbs,
    /// origin}); echoed on the stream as `__user__` so other views show it too.
    echo: Option<serde_json::Value>,
}

/// Send a message to a chat session, spawning the `claude` subprocess on first
/// use. Streamed output is routed back via `claude-stream-<key>` events.
/// Returns the process pid.
fn send_impl(app: &AppHandle, a: SendArgs) -> Result<u32, String> {
    let state = app.state::<ClaudeState>();
    let mut procs = state.procs.lock().unwrap();
    // A process that already exited (crash, failed resume) can't take input;
    // drop it so this send respawns with --resume.
    if procs.get_mut(&a.key).is_some_and(|p| !p.is_alive()) {
        procs.remove(&a.key);
    }
    if !procs.contains_key(&a.key) {
        let mode = a.cwd.as_deref().unwrap_or("project");
        // The session last ran in a different working directory: bring its
        // log along so --resume can find it here.
        if let (Some(id), Some(from), Ok(home)) =
            (a.resume.as_deref(), a.resume_cwd.as_deref(), app.path().home_dir())
        {
            if !id.trim().is_empty() && from != mode {
                let _ = core::carry_session(
                    &home,
                    &claude_cwd(app, &a.project_path, from),
                    &claude_cwd(app, &a.project_path, mode),
                    id.trim(),
                );
            }
        }
        let (out_app, out_key) = (app.clone(), a.key.clone());
        let (err_app, err_key) = (app.clone(), a.key.clone());
        let session = core::spawn_claude_session(
            &claude_cwd(app, &a.project_path, mode),
            &a.model,
            a.permission_mode.as_deref(),
            a.resume.as_deref(),
            move |line| emit_all(&out_app, &format!("claude-stream-{out_key}"), line),
            move |line| emit_stream(&err_app, &err_key, serde_json::json!({ "type": "__stderr__", "line": line })),
        )?;
        // Every view learns the pid (to tell a stale close from a live one).
        emit_stream(app, &a.key, serde_json::json!({ "type": "__spawned__", "pid": session.pid() }));
        procs.insert(a.key.clone(), session);
    }

    if let Some(mut echo) = a.echo {
        echo["type"] = "__user__".into();
        emit_stream(app, &a.key, echo);
    }
    let session = procs.get_mut(&a.key).unwrap();
    // `content` (text + image blocks, built by the UI) wins over plain `text`.
    match a.content {
        Some(c) => session.send_content(c)?,
        None => session.send_text(&a.text)?,
    }
    Ok(session.pid())
}

#[derive(Deserialize)]
struct ControlArgs {
    key: String,
    message: serde_json::Value,
    /// What this message means for the UI — an ask's outcome label ("Allowed",
    /// …) or "interrupt". Broadcast as `__control__` so every view of the
    /// session reacts the same way (settles the card, expects the stop).
    note: Option<String>,
}

/// Write a raw stream-json message (control protocol: permission answers,
/// interrupt, set_model, set_permission_mode) to a running session's stdin.
fn control_impl(app: &AppHandle, a: ControlArgs) -> Result<(), String> {
    {
        let state = app.state::<ClaudeState>();
        let mut procs = state.procs.lock().unwrap();
        let Some(p) = procs.get_mut(&a.key) else {
            return Err("no running claude process for this session".into());
        };
        if !p.is_alive() {
            return Err("claude process has exited".into());
        }
        p.send_json(&a.message)?;
    }
    if let Some(note) = a.note {
        let request_id = a.message["response"]["request_id"].clone();
        emit_stream(app, &a.key, serde_json::json!({ "type": "__control__", "request_id": request_id, "note": note }));
    }
    Ok(())
}

/// Kill a chat session's subprocess, if running.
fn stop_impl(app: &AppHandle, key: &str) {
    if let Some(mut session) = app.state::<ClaudeState>().procs.lock().unwrap().remove(key) {
        session.kill();
    }
}

#[tauri::command]
async fn claude_send(
    app: AppHandle,
    key: String,
    project_path: String,
    model: String,
    text: String,
    resume: Option<String>,
    permission_mode: Option<String>,
    cwd: Option<String>,
    resume_cwd: Option<String>,
    content: Option<serde_json::Value>,
    echo: Option<serde_json::Value>,
) -> Result<u32, String> {
    // Async so it runs off the main thread: spawning can take a moment.
    send_impl(&app, SendArgs { key, project_path, model, text, resume, permission_mode, cwd, resume_cwd, content, echo })
}

#[tauri::command]
fn claude_control(app: AppHandle, key: String, message: serde_json::Value, note: Option<String>) -> Result<(), String> {
    control_impl(&app, ControlArgs { key, message, note })
}

#[tauri::command]
fn claude_stop(app: AppHandle, key: String) {
    stop_impl(&app, &key)
}

/// Read an image file dropped on the chat as base64 (HEIC etc. converted to
/// JPEG); see `studio_claude_core::read_chat_image`. Async: `sips` can be slow.
#[tauri::command]
async fn read_chat_image(path: String) -> Result<core::ChatImage, String> {
    tauri::async_runtime::spawn_blocking(move || core::read_chat_image(std::path::Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
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

fn read_sessions_impl(app: &AppHandle, project: Option<String>) -> String {
    if let Some(f) = sessions_file(app, &project) {
        if let Some(text) = core::read_json_store(&f) {
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

/// Save a project's sessions, then tell every other view of that project to
/// merge them in (`origin` is the saving view, which skips its own echo).
fn save_sessions_impl(app: &AppHandle, project: Option<String>, data: String, origin: Option<String>) -> Result<(), String> {
    let file = sessions_file(app, &project).ok_or("no config dir")?;
    core::write_atomic(&file, &data)?;
    let payload = serde_json::json!({ "project": project, "origin": origin });
    emit_all(app, "claude-sessions-changed", payload.to_string());
    Ok(())
}

#[tauri::command]
fn read_claude_sessions(app: AppHandle, project: Option<String>) -> String {
    read_sessions_impl(&app, project)
}

#[tauri::command]
fn save_claude_sessions(app: AppHandle, project: Option<String>, data: String, origin: Option<String>) -> Result<(), String> {
    save_sessions_impl(&app, project, data, origin)
}

/// Remember the most recent project so a cold launch (no deep link, e.g. Dock)
/// can reopen something useful.
fn save_last_project_impl(app: &AppHandle, path: String, name: String, sprite: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let v = serde_json::json!({ "path": path, "name": name, "sprite": sprite });
    std::fs::write(dir.join("last-project.json"), v.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_last_project(app: AppHandle, path: String, name: String, sprite: String) -> Result<(), String> {
    save_last_project_impl(&app, path, name, sprite)
}

/// Open an http(s) link from the chat in the default browser (same command
/// name as Studio's, so the shared frontend works in both).
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if !(path.starts_with("https://") || path.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A project's color/sprite (same command name as Studio's, which returns the
/// whole workspace; the chat only reads these).
#[tauri::command]
fn read_workspace(path: String) -> serde_json::Value {
    let ws = load_workspace(&path);
    serde_json::json!({ "color": ws.color, "sprite": ws.sprite, "repo": ws.repo })
}

// --- Recorded session history (~/.claude/projects) -----------------------

fn list_history_impl(app: &AppHandle, project_path: &str, cwd: Option<String>) -> Vec<ClaudeHistorySession> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let cwd_path = claude_cwd(app, project_path, cwd.as_deref().unwrap_or("project"));
    core::list_project_sessions(&home, &cwd_path)
}

fn read_log_impl(app: &AppHandle, project_path: &str, session_id: &str, cwd: Option<String>) -> Vec<ClaudeLogMessage> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let cwd_path = claude_cwd(app, project_path, cwd.as_deref().unwrap_or("project"));
    core::read_session_log(&home, &cwd_path, session_id)
}

#[tauri::command]
fn list_claude_project_sessions(app: AppHandle, project_path: String, cwd: Option<String>) -> Vec<ClaudeHistorySession> {
    list_history_impl(&app, &project_path, cwd)
}

#[tauri::command]
fn read_claude_session_log(app: AppHandle, project_path: String, session_id: String, cwd: Option<String>) -> Vec<ClaudeLogMessage> {
    read_log_impl(&app, &project_path, &session_id, cwd)
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

// --- Bridge dispatch (Studio's embedded panel) ----------------------------

/// The same commands as the invoke handler, for bridge clients. Runs on a
/// bridge worker thread, so blocking work is fine here.
fn bridge_call(app: &AppHandle, cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::{from_value, to_value, Value};
    let str_arg = |k: &str| args.get(k).and_then(Value::as_str).map(String::from);
    let req = |k: &str| str_arg(k).ok_or_else(|| format!("{cmd}: missing {k}"));
    let json = |r: Result<Value, serde_json::Error>| r.map_err(|e| e.to_string());
    match cmd {
        "claude_send" => {
            let a: SendArgs = from_value(args.clone()).map_err(|e| e.to_string())?;
            Ok(send_impl(app, a)?.into())
        }
        "claude_control" => {
            let a: ControlArgs = from_value(args.clone()).map_err(|e| e.to_string())?;
            control_impl(app, a).map(|_| Value::Null)
        }
        "claude_stop" => {
            stop_impl(app, &req("key")?);
            Ok(Value::Null)
        }
        "read_chat_image" => json(to_value(core::read_chat_image(std::path::Path::new(&req("path")?))?)),
        "read_claude_sessions" => Ok(read_sessions_impl(app, str_arg("project")).into()),
        "save_claude_sessions" => {
            save_sessions_impl(app, str_arg("project"), req("data")?, str_arg("origin")).map(|_| Value::Null)
        }
        "save_last_project" => save_last_project_impl(
            app,
            req("path")?,
            str_arg("name").unwrap_or_default(),
            str_arg("sprite").unwrap_or_default(),
        )
        .map(|_| Value::Null),
        "open_path" => open_path(req("path")?).map(|_| Value::Null),
        "read_workspace" => Ok(read_workspace(req("path")?)),
        "list_claude_project_sessions" => json(to_value(list_history_impl(app, &req("projectPath")?, str_arg("cwd")))),
        "read_claude_session_log" => {
            json(to_value(read_log_impl(app, &req("projectPath")?, &req("sessionId")?, str_arg("cwd"))))
        }
        "get_claude_usage" => core::fetch_usage(),
        // Pop the panel's project out into this app's own window.
        "claude_open_window" => {
            let (h, project) = (app.clone(), req("project")?);
            let name = str_arg("name").unwrap_or_default();
            app.run_on_main_thread(move || open_project_window(&h, &project, &name))
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err(format!("unknown command {cmd}")),
    }
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
        // The window persists (hidden) across activations rather than being
        // rebuilt, so its color/sprite are whatever they were on first open —
        // re-read workspace.json now in case they've changed since (see
        // claude.js's "claude-jump" listener).
        let ws = load_workspace(project);
        let _ = win.emit(
            "claude-jump",
            serde_json::json!({
                "sprite": ws.sprite,
                "color": ws.color,
            }),
        );
        return;
    }

    let ws = load_workspace(project);
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

/// Handle `studio-claude://open?project=<path>&name=<name>`, or
/// `studio-claude://start` (just be running — for Studio's embedded panel —
/// without opening a window).
fn handle_open_url(app: &AppHandle, url: &Url) {
    if url.host_str() == Some("start") {
        return;
    }
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
        .manage(bridge::Bridge::default())
        .invoke_handler(tauri::generate_handler![
            claude_send,
            claude_stop,
            claude_control,
            read_chat_image,
            read_claude_sessions,
            save_claude_sessions,
            save_last_project,
            open_path,
            read_workspace,
            list_claude_project_sessions,
            read_claude_session_log,
            get_claude_usage,
        ])
        .setup(|app| {
            // Studio's embedded panel connects over the local bridge.
            if let Ok(dir) = app.path().app_config_dir() {
                if let Err(e) = bridge::start(app.handle().clone(), &dir, bridge_call) {
                    eprintln!("[companion] bridge failed to start: {e}");
                }
            }
            // Cold launch: the project URL rides in on our own argv. A
            // `studio-claude://start` launch (from the panel) opens no window.
            let argv: Vec<String> = std::env::args().collect();
            let background = argv.iter().any(|a| a.starts_with("studio-claude://start"));
            let opened = handle_open_args(app.handle(), &argv);
            if background {
                return Ok(());
            }
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
            // macOS: clicking the Dock icon reopens a hidden window — or, if
            // it was started for the panel with no window, the last project.
            if let tauri::RunEvent::Reopen { .. } = event {
                if app.webview_windows().is_empty() {
                    open_last_project(app);
                } else {
                    show_any_window(app);
                }
            }
        });
}
