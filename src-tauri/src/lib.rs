mod patchmatch;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry,
};

/// A discovered project: a folder directly under ~/Projects/.
#[derive(Clone, Serialize, Default)]
struct Project {
    name: String,
    path: String,
    /// Last-modified time of the project folder, as Unix epoch seconds.
    modified: u64,
    /// Animal sprite from workspace.json, if any (see sprites.js registry).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    sprite: String,
}

/// The `claude` block of a workspace manifest.
#[derive(Clone, Serialize, Deserialize, Default)]
struct ClaudeCfg {
    #[serde(default)]
    mode: String,
}

/// workspace.json — the project's launch manifest. Missing fields default,
/// so partial / hand-edited manifests load fine.
#[derive(Clone, Serialize, Deserialize, Default)]
struct Workspace {
    #[serde(default)]
    apps: Vec<String>,
    #[serde(default)]
    repo: String,
    /// Code editor to open the repo in. Blank = Zed (the default).
    #[serde(default)]
    editor: String,
    #[serde(default)]
    figma: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default)]
    claude: ClaudeCfg,
    /// Animal sprite shown on the Workspace tab and in the Claude window
    /// status bar (a key into the frontend's sprite registry).
    #[serde(default)]
    sprite: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "pinnedTab")]
    pinned_tab: Option<String>,
    /// Recurring `claude -p` prompts run by the background scheduler.
    #[serde(default)]
    schedules: Vec<ScheduledTask>,
    /// The 3 shared "HH:MM" times tasks can be grouped under, shown in the
    /// Workspace UI as 3 slots.
    #[serde(default = "default_schedule_slots", rename = "scheduleSlots")]
    schedule_slots: Vec<String>,
}

fn default_schedule_model() -> String {
    "haiku".to_string()
}

fn default_schedule_output_file() -> String {
    "Scheduled Output.md".to_string()
}

/// A recurring task: run `claude -p <prompt>` in a project's repo. Its *when*
/// (time + days) comes from the slot it's assigned to (`SlotDef`), not the
/// task itself.
#[derive(Clone, Serialize, Deserialize, Default)]
struct ScheduledTask {
    #[serde(default)]
    id: String,
    #[serde(default)]
    prompt: String,
    /// Legacy: days used to live per-task; they now live on the slot. Kept
    /// only so `read_schedules_file` can migrate old data into `SlotDef::days`
    /// once, after which it's cleared and no longer serialized.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    days: Vec<u8>,
    #[serde(default)]
    enabled: bool,
    /// Model passed to `claude --model`, e.g. "haiku", "sonnet", "opus".
    #[serde(default = "default_schedule_model")]
    model: String,
    /// Markdown file (relative to the project folder) the output is written
    /// to, overwritten on each run. Blank = `default_schedule_output_file()`.
    #[serde(default, rename = "outputFile")]
    output_file: String,
    /// "YYYY-MM-DD" of the last day this task ran, to avoid double-firing.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "lastRun")]
    last_run: Option<String>,
    /// "YYYY-MM-DD HH:MM" of the last time this task ran (scheduled or "Run
    /// now"), shown in the UI.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "lastRunAt")]
    last_run_at: Option<String>,
    /// Whether the last run's `claude` process exited successfully.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "lastRunOk")]
    last_run_ok: Option<bool>,
    /// Index (0-2) into `SchedulesFile::slots`, grouping this task under one
    /// of the 3 shared time slots shown in the UI.
    #[serde(default)]
    slot: u8,
    /// Folder the `claude -p` run uses as its working dir, and where the
    /// output file is written. Blank = the ~/Projects root ("Global").
    #[serde(default, rename = "projectPath")]
    project_path: String,
}

fn default_schedule_slots() -> Vec<String> {
    vec!["09:00".to_string(), "13:00".to_string(), "17:00".to_string()]
}

fn default_slot_time() -> String {
    "09:00".to_string()
}

/// One of the 3 shared time slots: a local time + the weekdays it fires on
/// (empty `days` = every day). All tasks assigned to a slot share its timing.
#[derive(Clone, Serialize, Default)]
struct SlotDef {
    /// "HH:MM", 24-hour, local time.
    time: String,
    /// 0 = Sunday .. 6 = Saturday. Empty = every day.
    days: Vec<u8>,
}

// Accept both the old form (a bare "HH:MM" string) and the new object form, so
// existing schedules.json files migrate without a separate pass.
impl<'de> Deserialize<'de> for SlotDef {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Time(String),
            Obj {
                #[serde(default = "default_slot_time")]
                time: String,
                #[serde(default)]
                days: Vec<u8>,
            },
        }
        Ok(match Repr::deserialize(d)? {
            Repr::Time(time) => SlotDef { time, days: Vec::new() },
            Repr::Obj { time, days } => SlotDef { time, days },
        })
    }
}

/// How many shared time slots the UI exposes.
const SLOT_COUNT: usize = 2;

fn default_slots() -> Vec<SlotDef> {
    vec![
        SlotDef { time: "09:00".to_string(), days: Vec::new() },
        SlotDef { time: "17:00".to_string(), days: Vec::new() },
    ]
}

/// The single global schedules store (app config dir / schedules.json): the 3
/// shared time slots plus every scheduled task across all projects. Replaces
/// the old per-project `Workspace::schedules`.
#[derive(Clone, Serialize, Deserialize, Default)]
struct SchedulesFile {
    #[serde(default = "default_slots")]
    slots: Vec<SlotDef>,
    #[serde(default)]
    tasks: Vec<ScheduledTask>,
}

/// App-wide state: which project is currently active (if any).
#[derive(Default)]
struct AppState {
    active: Mutex<Option<Project>>,
}

const TRAY_ID: &str = "studio-tray";
const PROJECT_PREFIX: &str = "proj:";
const TOOL_PREFIX: &str = "tool:";

/// ~/Projects — the single folder Studio scans for projects.
fn projects_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().home_dir().ok().map(|home| home.join("Projects"))
}

/// Scan ~/Projects for immediate subfolders, skipping hidden dirs, sorted by name.
fn scan_projects(app: &AppHandle) -> Vec<Project> {
    let mut projects = Vec::new();
    if let Some(root) = projects_root(app) {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if name.starts_with('.') {
                    continue;
                }
                let modified = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let sprite = read_workspace(path.to_string_lossy().to_string())
                    .map(|ws| ws.sprite)
                    .unwrap_or_default();
                projects.push(Project {
                    name: name.to_string(),
                    path: path.to_string_lossy().to_string(),
                    modified,
                    sprite,
                });
            }
        }
    }
    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    projects
}

/// `tools/` — single-file HTML utilities bundled with Studio (see
/// `bundle.resources` in `tauri.conf.json`), opened in their own window.
fn tools_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|d| d.join("tools"))
}

/// One entry in `~/Projects/Tools/Tools.json`.
#[derive(Deserialize)]
struct ToolEntry {
    file: String,
    #[serde(default)]
    name: Option<String>,
}

/// `Tools.json`, bundled with Studio (see `tauri.conf.json` →
/// `bundle.resources`) — explicit list/order of tools to show in the tray.
/// `file` paths within it are resolved relative to `~/Projects/Tools/`.
/// Missing/unreadable file falls back to `None` (scan all *.html).
fn read_tools_manifest(app: &AppHandle) -> Option<Vec<ToolEntry>> {
    let dir = app.path().resource_dir().ok()?;
    let text = std::fs::read_to_string(dir.join("Tools.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Tools to show in the tray: from `Tools.json` if present (in the order
/// listed there), otherwise every *.html file in ~/Projects/Tools, sorted by
/// name.
fn scan_tools(app: &AppHandle) -> Vec<Project> {
    let Some(dir) = tools_dir(app) else {
        return Vec::new();
    };

    if let Some(entries) = read_tools_manifest(app) {
        return entries
            .into_iter()
            .filter_map(|entry| {
                let path = dir.join(&entry.file);
                if !path.is_file() {
                    return None;
                }
                let name = entry.name.unwrap_or_else(|| {
                    Path::new(&entry.file)
                        .file_stem()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&entry.file)
                        .to_string()
                });
                Some(Project {
                    name,
                    path: path.to_string_lossy().to_string(),
                    modified: 0,
                    ..Default::default()
                })
            })
            .collect();
    }

    let mut tools = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("html") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|n| n.to_str()) else {
                continue;
            };
            if stem.starts_with('.') {
                continue;
            }
            tools.push(Project {
                name: stem.to_string(),
                path: path.to_string_lossy().to_string(),
                modified: 0,
                ..Default::default()
            });
        }
    }
    tools.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    tools
}

/// Open (or focus) a tool's HTML file in its own native window.
fn open_tool_window(app: &AppHandle, path: &str) {
    let label = format!(
        "tool-{}",
        Path::new(path)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("tool")
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect::<String>()
    );

    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    // Load via the app's tauri://localhost protocol (the tool's HTML lives
    // in src/tools/, part of frontendDist) rather than file://: file://
    // windows send `Origin: null`, which Tauri's IPC rejects ("Origin
    // header not valid URL").
    let Some(filename) = Path::new(path).file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let title = Path::new(path)
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("Tool")
        .to_string();

    let _ = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("tools/{filename}").into()),
    )
    .title(title)
    .inner_size(900.0, 640.0)
    .build();
}

/// Build the tray menu: optional active-project header, Open Studio, New Project,
/// the project list (active one check-marked), then Quit.
fn build_tray_menu(
    app: &AppHandle,
    projects: &[Project],
    active: Option<&str>,
) -> tauri::Result<Menu<Wry>> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();

    items.push(Box::new(MenuItem::with_id(
        app,
        "open_studio",
        "All Projects",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "new_project",
        "New Project…",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(PredefinedMenuItem::separator(app)?));

    if projects.is_empty() {
        items.push(Box::new(MenuItem::with_id(
            app,
            "no_projects",
            "No projects in ~/Projects",
            false,
            None::<&str>,
        )?));
    } else {
        for p in projects {
            let label = if Some(p.path.as_str()) == active {
                format!("✓ {}", p.name)
            } else {
                format!("   {}", p.name)
            };
            items.push(Box::new(MenuItem::with_id(
                app,
                format!("{PROJECT_PREFIX}{}", p.path),
                label,
                true,
                None::<&str>,
            )?));
        }
    }

    // Tools section: the built-in Scheduled Tasks window, then any user tools.
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "open_schedules",
        "🗓 Scheduled Tasks",
        true,
        None::<&str>,
    )?));
    for t in &scan_tools(app) {
        items.push(Box::new(MenuItem::with_id(
            app,
            format!("{TOOL_PREFIX}{}", t.path),
            format!("🔧 {}", t.name),
            true,
            None::<&str>,
        )?));
    }

    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "quit",
        "Quit Studio",
        true,
        None::<&str>,
    )?));

    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Refresh the tray menu to reflect the current project list and active project.
fn refresh_tray(app: &AppHandle, active: Option<&str>) {
    let projects = scan_projects(app);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app, &projects, active) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

// Kept alive for the app's lifetime so file watching keeps running.
type Watcher = notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>;
static WATCHER: OnceLock<Mutex<Option<Watcher>>> = OnceLock::new();

/// Watch ~/Projects (recursively) and, on relevant changes, rebuild the tray
/// project list and tell the frontend to refresh. Noise dirs are ignored.
fn start_watching(app: &AppHandle) {
    use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};

    let Some(root) = projects_root(app) else {
        return;
    };
    let _ = std::fs::create_dir_all(&root);
    let handle = app.clone();

    let debouncer = new_debouncer(
        Duration::from_millis(400),
        move |res: DebounceEventResult| {
            let Ok(events) = res else {
                return;
            };
            let relevant = events.iter().any(|e| {
                let p = e.path.to_string_lossy();
                !p.contains("/node_modules/") && !p.contains("/.git/")
            });
            if !relevant {
                return;
            }
            // Project list may have changed — rebuild the tray, keep active.
            let active = handle.state::<AppState>().active.lock().unwrap().clone();
            refresh_tray(&handle, active.as_ref().map(|p| p.path.as_str()));
            let _ = handle.emit("fs-changed", ());
        },
    );

    if let Ok(mut d) = debouncer {
        if d.watcher()
            .watch(root.as_path(), RecursiveMode::Recursive)
            .is_ok()
        {
            let _ = WATCHER.set(Mutex::new(Some(d)));
        }
    }
}

/// Show and focus the single Studio window.
fn show_studio(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Resize the window to a new logical width, keeping the current height.
#[tauri::command]
fn set_window_width(app: AppHandle, width: u32) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("no window")?;
    let size = win.inner_size().map_err(|e| e.to_string())?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let logical_height = (size.height as f64 / scale).round() as u32;
    win.set_size(tauri::LogicalSize::new(width, logical_height))
        .map_err(|e| e.to_string())
}

/// Activate a project: store it, refresh the tray, open the window, notify the UI.
fn activate_project(app: &AppHandle, path: &str) {
    let projects = scan_projects(app);
    let Some(project) = projects.iter().find(|p| p.path == path).cloned() else {
        return;
    };

    *app.state::<AppState>().active.lock().unwrap() = Some(project.clone());
    refresh_tray(app, Some(&project.path));
    show_studio(app);
    let _ = app.emit("project-activated", &project);
}

/// Frontend calls this on load to render the currently-active project (if any).
#[tauri::command]
fn get_active_project(state: tauri::State<AppState>) -> Option<Project> {
    state.active.lock().unwrap().clone()
}

/// Frontend calls this when showing the "All Projects" overview, so nothing
/// is considered active (e.g. `save_tool_export` falls back to a save
/// dialog instead of writing into a project's `designs/` folder).
#[tauri::command]
fn clear_active_project(app: AppHandle, state: tauri::State<AppState>) {
    *state.active.lock().unwrap() = None;
    refresh_tray(&app, None);
}

/// Save a Tools export (e.g. from bento-grid.html) into the active project's
/// `designs/` folder. Used by tool windows in lieu of a save-file dialog,
/// which isn't available in a `file://` webview.
#[tauri::command]
async fn save_tool_export(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    filename: String,
    content: String,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    if filename.contains('/') || filename.contains('\\') || filename.starts_with('.') {
        return Err("Invalid filename.".into());
    }

    let project = state.active.lock().unwrap().clone();
    let path = match project {
        Some(project) => {
            let dir = PathBuf::from(&project.path).join("designs");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            dir.join(&filename)
        }
        // No active project — fall back to a normal save dialog. Use the
        // async variant: `blocking_save_file` deadlocks when called from
        // the main thread (the dialog itself needs the main thread).
        None => {
            let (tx, mut rx) = tauri::async_runtime::channel(1);
            app.dialog()
                .file()
                .set_file_name(&filename)
                .save_file(move |picked| {
                    let _ = tx.try_send(picked);
                });
            match rx.recv().await.ok_or("dialog closed")? {
                Some(file_path) => file_path.into_path().map_err(|e| e.to_string())?,
                None => return Err("__cancelled__".into()),
            }
        }
    };
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// All projects under ~/Projects — backs the overview screen.
#[tauri::command]
fn list_projects(app: AppHandle) -> Vec<Project> {
    scan_projects(&app)
}

/// Activate a project from the UI (e.g. clicking a card in the overview).
#[tauri::command]
fn open_project(app: AppHandle, path: String) {
    activate_project(&app, &path);
}

/// Create a new project folder under ~/Projects and activate it.
#[tauri::command]
fn create_project(app: AppHandle, name: String) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name can't be empty.".into());
    }
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err("Project name can't contain slashes or start with a dot.".into());
    }

    let root = projects_root(&app).ok_or("Could not locate ~/Projects.")?;
    let dir = root.join(name);
    if dir.exists() {
        return Err(format!("A project named “{name}” already exists."));
    }

    std::fs::create_dir_all(dir.join("media")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir.join("designs")).map_err(|e| e.to_string())?;

    let notes = serde_json::json!({ "version": 1, "notes": [] });
    std::fs::write(
        dir.join("notes.json"),
        serde_json::to_string_pretty(&notes).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    // Default manifest: repo/figma left blank for the user to fill in.
    let workspace = Workspace {
        claude: ClaudeCfg {
            mode: "terminal".into(),
        },
        ..Default::default()
    };
    std::fs::write(
        dir.join("workspace.json"),
        serde_json::to_string_pretty(&workspace).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    let path = dir.to_string_lossy().to_string();
    activate_project(&app, &path);
    Ok(Project {
        name: name.to_string(),
        path,
        modified: 0,
        ..Default::default()
    })
}

/// Read a project's workspace.json (defaults if absent/partial).
#[tauri::command]
fn read_workspace(path: String) -> Result<Workspace, String> {
    let file = PathBuf::from(&path).join("workspace.json");
    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(Workspace::default()),
    }
}

/// Write a project's workspace.json (pretty-printed).
#[tauri::command]
fn save_workspace(path: String, workspace: Workspace) -> Result<(), String> {
    let file = PathBuf::from(&path).join("workspace.json");
    let text = serde_json::to_string_pretty(&workspace).map_err(|e| e.to_string())?;
    std::fs::write(&file, text).map_err(|e| e.to_string())
}

/// Media extensions surfaced in the grid, by kind.
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "heic", "heif", "svg",
];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "webm", "avi", "mkv"];
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "m4a", "aiff", "aif", "flac", "aac"];
const DOC_EXTS: &[&str] = &["pdf"];

/// Classify a (lowercase) extension into a media kind, or None if not media.
fn media_kind(ext: &str) -> Option<&'static str> {
    if IMAGE_EXTS.contains(&ext) {
        Some("image")
    } else if VIDEO_EXTS.contains(&ext) {
        Some("video")
    } else if AUDIO_EXTS.contains(&ext) {
        Some("audio")
    } else if DOC_EXTS.contains(&ext) {
        Some("doc")
    } else {
        None
    }
}

/// One media file found in a project.
#[derive(Clone, Serialize)]
struct MediaItem {
    name: String,
    path: String,
    ext: String,
    kind: String,
    is_heic: bool,
    modified: u64,
    has_edits: bool,
    edits_mtime: u64,
    file_size: u64,
    width: u32,
    height: u32,
}

/// Recursively collect images under `dir`, skipping noise/hidden directories.
fn walk_media(dir: &Path, out: &mut Vec<MediaItem>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let raw_name = entry.file_name();
        let name = raw_name.to_string_lossy();
        if path.is_dir() {
            // Skip hidden/vendored dirs and `notes/` (image-note assets live
            // there and must not appear in the Media tab).
            if name == ".git"
                || name == "node_modules"
                || name == "notes"
                || name.starts_with('.')
            {
                continue;
            }
            walk_media(&path, out);
            continue;
        }
        // Skip hidden files (e.g. the project's .studio-icon.png).
        if name.starts_with('.') {
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        let ext = ext.to_lowercase();
        let Some(kind) = media_kind(&ext) else {
            continue;
        };
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let path_str = path.to_string_lossy().to_string();
        migrate_sidecar(&path_str);
        let edits_mtime = std::fs::metadata(sidecar_path(&path_str))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let file_size = entry.metadata().ok().map(|m| m.len()).unwrap_or(0);
        let (width, height) = if kind == "image" {
            image::image_dimensions(&path).unwrap_or((0, 0))
        } else {
            (0, 0)
        };
        out.push(MediaItem {
            name: name.to_string(),
            path: path_str,
            kind: kind.to_string(),
            is_heic: ext == "heic" || ext == "heif",
            ext,
            modified,
            has_edits: edits_mtime > 0,
            edits_mtime,
            file_size,
            width,
            height,
        });
    }
}

/// List every image in a project, newest first.
#[tauri::command]
fn list_media(path: String) -> Vec<MediaItem> {
    let mut out = Vec::new();
    walk_media(Path::new(&path), &mut out);
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

/// Generate a QuickLook thumbnail (any file type) into the app cache, returning
/// the cached PNG path (asset-resolved by the frontend). Cached by path+mtime+size.
#[tauri::command]
fn quicklook_thumb(app: AppHandle, path: String, size: u32) -> Result<String, String> {
    use std::hash::{Hash, Hasher};

    let src = PathBuf::from(&path);
    let mtime = std::fs::metadata(&src)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    mtime.hash(&mut hasher);
    size.hash(&mut hasher);
    let key = hasher.finish();

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("qlthumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{key:x}.png"));

    if !out.exists() {
        let status = Command::new(env!("QLTHUMB_BIN"))
            .arg(&src)
            .arg(size.to_string())
            .arg(&out)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("QuickLook thumbnail failed".into());
        }
    }
    Ok(out.to_string_lossy().to_string())
}

/// Path of the on-disk cache file for an edited image's baked thumbnail,
/// keyed by image path + sidecar mtime (so it invalidates when edits change).
fn edited_thumb_file(app: &AppHandle, path: &str, edits_mtime: u64) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    edits_mtime.hash(&mut hasher);
    let key = hasher.finish();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("edited-thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{key:x}.png")))
}

/// Return the cached baked-thumbnail path for an edited image, if present.
#[tauri::command]
fn edited_thumb(app: AppHandle, path: String, edits_mtime: u64) -> Option<String> {
    edited_thumb_file(&app, &path, edits_mtime)
        .ok()
        .filter(|f| f.exists())
        .map(|f| f.to_string_lossy().to_string())
}

/// Persist a baked thumbnail (base64 PNG) for an edited image; return its path.
#[tauri::command]
fn save_edited_thumb(
    app: AppHandle,
    path: String,
    edits_mtime: u64,
    data_base64: String,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let file = edited_thumb_file(&app, &path, edits_mtime)?;
    let bytes = STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().to_string())
}

/// Open a file with its default application.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Launch an application by name: `open -a "AppName"`.
#[tauri::command]
fn open_app(name: String) -> Result<(), String> {
    Command::new("open")
        .args(["-a", name.trim()])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Escape a string for embedding in an AppleScript double-quoted literal.
fn applescript_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Run a macOS Shortcut via the `shortcuts` CLI. Used for Image Playground
/// generation (which the direct ImageCreator API forbids from a background
/// process). One of `input_path` / `input_text` becomes the shortcut's input
/// (`--input-path`); `clipboard_text` is copied to the pasteboard first so a
/// shortcut can read a prompt alongside an image input. Output is written to
/// `output_path`.
#[tauri::command]
fn run_shortcut(
    name: String,
    input_path: Option<String>,
    input_text: Option<String>,
    clipboard_text: Option<String>,
    output_path: String,
) -> Result<(), String> {
    use std::io::Write;

    if let Some(text) = clipboard_text {
        if let Ok(mut child) = Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
    }

    // Resolve the shortcut input: an explicit path, or text written to a temp file.
    let mut temp_input: Option<PathBuf> = None;
    let resolved_input = if let Some(p) = input_path {
        Some(p)
    } else if let Some(t) = input_text {
        let f = std::env::temp_dir().join(format!(
            "studio-shortcut-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&f, t).map_err(|e| e.to_string())?;
        temp_input = Some(f.clone());
        Some(f.to_string_lossy().to_string())
    } else {
        None
    };

    if let Some(parent) = Path::new(&output_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut cmd = Command::new("shortcuts");
    cmd.arg("run").arg(&name);
    if let Some(ref ip) = resolved_input {
        cmd.args(["--input-path", ip]);
    }
    cmd.args(["--output-path", &output_path]);
    let out = cmd.output().map_err(|e| e.to_string())?;

    if let Some(f) = temp_input {
        let _ = std::fs::remove_file(f);
    }

    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(if err.trim().is_empty() {
            format!("shortcut \"{name}\" failed")
        } else {
            err.trim().to_string()
        })
    }
}

/// The album Studio imports extended images into for Clean Up.
const PHOTOS_ALBUM: &str = "Studio";

/// Import `path` into the Studio album in Photos, reveal it, and enter the Edit
/// panel (ready for Clean Up). Uses Photos' native scripting to import + select,
/// then a single Return via System Events to start editing (needs Accessibility).
#[tauri::command]
fn open_in_photos(path: String) -> Result<(), String> {
    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let script = format!(
        r#"
        set imagePath to POSIX file "{path}"
        tell application "Photos"
            reopen
            activate
            delay 0.2
            if not (exists container "{album}") then
                make new album named "{album}"
            end if
            set targetAlbum to container "{album}"
            set importedItems to (import {{imagePath}} into targetAlbum)
            spotlight targetAlbum
            -- Prefer the just-imported item (avoids Spotlight-index lag and
            -- duplicate-name ambiguity); fall back to a name search if Photos
            -- deduped the import and returned nothing.
            if (count of importedItems) > 0 then
                spotlight item 1 of importedItems
            else
                set foundItems to (search for "{name}")
                if (count of foundItems) > 0 then spotlight item 1 of foundItems
            end if
        end tell
        delay 0.6
        tell application "System Events" to keystroke return
    "#,
        path = applescript_quote(&path),
        name = applescript_quote(&name),
        album = PHOTOS_ALBUM,
    );
    let out = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Convert a HEIC to a cached JPEG (in the app cache dir) so the webview can
/// display it. Returns the cached file path; the frontend asset-resolves it.
#[tauri::command]
fn heic_preview(app: AppHandle, path: String) -> Result<String, String> {
    use std::hash::{Hash, Hasher};

    let src = PathBuf::from(&path);
    let mtime = std::fs::metadata(&src)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    mtime.hash(&mut hasher);
    let key = hasher.finish();

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{key:x}.jpg"));

    if !out.exists() {
        let status = Command::new("sips")
            .args(["-s", "format", "jpeg"])
            .arg(&src)
            .arg("--out")
            .arg(&out)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("HEIC conversion (sips) failed".into());
        }
    }
    Ok(out.to_string_lossy().to_string())
}

/// Move dropped image files into a project's media/ folder. Non-image files are
/// skipped. Returns the paths of the files actually imported.
#[tauri::command]
fn import_media(project_path: String, files: Vec<String>) -> Result<Vec<String>, String> {
    let media_dir = PathBuf::from(&project_path).join("media");
    std::fs::create_dir_all(&media_dir).map_err(|e| e.to_string())?;

    let mut imported = Vec::new();
    for file in files {
        let src = PathBuf::from(&file);
        let is_image = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| IMAGE_EXTS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if !is_image {
            continue;
        }
        let Some(fname) = src.file_name() else {
            continue;
        };

        // Avoid clobbering an existing file: name.ext → name-1.ext, name-2.ext…
        let mut dest = media_dir.join(fname);
        if dest.exists() {
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
            let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
            let mut n = 1;
            loop {
                let candidate = media_dir.join(format!("{stem}-{n}.{ext}"));
                if !candidate.exists() {
                    dest = candidate;
                    break;
                }
                n += 1;
            }
        }

        // Move within the same volume via rename; fall back to copy+delete
        // across volumes (rename fails with EXDEV there).
        if std::fs::rename(&src, &dest).is_err() {
            std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
            std::fs::remove_file(&src).map_err(|e| e.to_string())?;
        }
        imported.push(dest.to_string_lossy().to_string());
    }
    Ok(imported)
}

/// A collision-free destination in `dir` for `src`'s filename (name-1.ext, …).
fn unique_dest(dir: &Path, src: &Path) -> Option<PathBuf> {
    let fname = src.file_name()?;
    let mut dest = dir.join(fname);
    if dest.exists() {
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("");
        let mut n = 1;
        loop {
            let cand = if ext.is_empty() {
                dir.join(format!("{stem}-{n}"))
            } else {
                dir.join(format!("{stem}-{n}.{ext}"))
            };
            if !cand.exists() {
                dest = cand;
                break;
            }
            n += 1;
        }
    }
    Some(dest)
}

/// Move a file, falling back to copy+delete across volumes (rename EXDEV).
fn move_into(src: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_err() {
        std::fs::copy(src, dest).map_err(|e| e.to_string())?;
        std::fs::remove_file(src).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct DropResult {
    images: Vec<String>,
    files: Vec<String>,
    folders: Vec<String>,
}

/// Route OS-dropped paths (interaction-spec §8.1): image files → media/,
/// non-image files → the project root, folders → returned for the Workspace
/// (referenced in place, not moved).
#[tauri::command]
fn handle_dropped_paths(project_path: String, paths: Vec<String>) -> Result<DropResult, String> {
    let proj = PathBuf::from(&project_path);
    let media_dir = proj.join("media");
    let mut images = Vec::new();
    let mut files = Vec::new();
    let mut folders = Vec::new();
    for p in &paths {
        let src = PathBuf::from(p);
        if src.is_dir() {
            folders.push(p.clone());
            continue;
        }
        let is_image = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| IMAGE_EXTS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        let dir = if is_image { &media_dir } else { &proj };
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let Some(dest) = unique_dest(dir, &src) else {
            continue;
        };
        if move_into(&src, &dest).is_ok() {
            let s = dest.to_string_lossy().to_string();
            if is_image {
                images.push(s);
            } else {
                files.push(s);
            }
        }
    }
    Ok(DropResult {
        images,
        files,
        folders,
    })
}

/// Global manual project order (paths), persisted in the app config dir.
#[tauri::command]
fn read_project_order(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(std::fs::read_to_string(dir.join("project-order.json")).unwrap_or_default())
}

#[tauri::command]
fn save_project_order(app: AppHandle, data: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("project-order.json"), data).map_err(|e| e.to_string())
}

/// Path to the global schedules store (app config dir / schedules.json).
fn schedules_file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("schedules.json"))
}

/// Fold legacy per-task `days` into their slot's `days` (slots now own the
/// timing), then clear the per-task copies. Returns whether anything changed,
/// so the caller can persist the migration. Idempotent: once slots carry days
/// and tasks don't, it's a no-op.
fn migrate_slot_days(file: &mut SchedulesFile) -> bool {
    let mut changed = false;
    for idx in 0..file.slots.len() {
        if file.slots[idx].days.is_empty() {
            if let Some(days) = file
                .tasks
                .iter()
                .find(|t| t.slot as usize == idx && !t.days.is_empty())
                .map(|t| t.days.clone())
            {
                file.slots[idx].days = days;
                changed = true;
            }
        }
    }
    for task in file.tasks.iter_mut() {
        if !task.days.is_empty() {
            task.days.clear();
            changed = true;
        }
    }
    changed
}

/// Read the global schedules store. If it doesn't exist yet, migrate from the
/// old per-project `Workspace::schedules` (each task tagged with its project
/// path) and persist the result, so existing schedules carry over once. Also
/// folds any legacy per-task `days` into their slot.
fn read_schedules_file(app: &AppHandle) -> SchedulesFile {
    if let Some(path) = schedules_file_path(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let mut file: SchedulesFile = serde_json::from_str(&text).unwrap_or_default();
            let mut changed = migrate_slot_days(&mut file);
            changed |= migrate_slot_count(&mut file);
            if changed {
                let _ = write_schedules_file(app, &file);
            }
            return file;
        }
    }
    // First run after the move to a global store: gather per-project tasks.
    let mut file = SchedulesFile {
        slots: default_slots(),
        tasks: Vec::new(),
    };
    for project in scan_projects(app) {
        if let Ok(ws) = read_workspace(project.path.clone()) {
            if ws.schedule_slots.len() == 3 && file.tasks.is_empty() {
                file.slots = ws
                    .schedule_slots
                    .iter()
                    .map(|time| SlotDef { time: time.clone(), days: Vec::new() })
                    .collect();
            }
            for mut task in ws.schedules {
                task.project_path = project.path.clone();
                file.tasks.push(task);
            }
        }
    }
    migrate_slot_days(&mut file);
    migrate_slot_count(&mut file);
    let _ = write_schedules_file(app, &file);
    file
}

/// Coerce the store to exactly `SLOT_COUNT` slots, reindexing tasks so none
/// are orphaned. Slots with tasks are kept (in order) ahead of empty ones;
/// any used slots beyond `SLOT_COUNT` are merged into the last kept slot, and
/// the list is padded with defaults if short. Idempotent once at the target.
fn migrate_slot_count(file: &mut SchedulesFile) -> bool {
    if file.slots.len() == SLOT_COUNT {
        return false;
    }
    let used: Vec<usize> = (0..file.slots.len())
        .filter(|&i| file.tasks.iter().any(|t| t.slot as usize == i))
        .collect();
    // Used slots first, then empties — so when we truncate we never drop a
    // slot that has tasks before an empty one.
    let order: Vec<usize> = used
        .iter()
        .cloned()
        .chain((0..file.slots.len()).filter(|i| !used.contains(i)))
        .take(SLOT_COUNT)
        .collect();

    let mut new_slots: Vec<SlotDef> = order.iter().map(|&i| file.slots[i].clone()).collect();
    let defaults = default_slots();
    while new_slots.len() < SLOT_COUNT {
        new_slots.push(defaults[new_slots.len()].clone());
    }

    for task in file.tasks.iter_mut() {
        // Kept slot → its new position; dropped (merged) slot → last kept.
        task.slot = order
            .iter()
            .position(|&i| i == task.slot as usize)
            .unwrap_or(SLOT_COUNT - 1) as u8;
    }
    file.slots = new_slots;
    true
}

fn write_schedules_file(app: &AppHandle, file: &SchedulesFile) -> Result<(), String> {
    let path = schedules_file_path(app).ok_or("no app config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_schedules(app: AppHandle) -> Result<String, String> {
    serde_json::to_string(&read_schedules_file(&app)).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_schedules(app: AppHandle, data: String) -> Result<(), String> {
    let file: SchedulesFile = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    write_schedules_file(&app, &file)
}

/// Per-project media view metadata (sort mode + manual order). Stored hidden so
/// it's skipped by walk_media and doesn't show in the Media grid.
#[tauri::command]
fn read_media_meta(path: String) -> Result<String, String> {
    let f = PathBuf::from(&path).join(".studio-media.json");
    Ok(std::fs::read_to_string(f).unwrap_or_default())
}

#[tauri::command]
fn save_media_meta(path: String, data: String) -> Result<(), String> {
    let f = PathBuf::from(&path).join(".studio-media.json");
    std::fs::write(f, data).map_err(|e| e.to_string())
}

/// MIME type for an image extension (used for data URLs).
fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Read an image as a `data:` URL for the editor canvas. HEIC is converted to
/// JPEG first. Loading via data URL (rather than the asset protocol) keeps the
/// canvas untainted so it can be exported with toBlob.
#[tauri::command]
fn read_image_data(app: AppHandle, path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let (bytes, mime) = if ext == "heic" || ext == "heif" {
        let jpg = heic_preview(app, path.clone())?;
        (
            std::fs::read(&jpg).map_err(|e| e.to_string())?,
            "image/jpeg",
        )
    } else {
        (
            std::fs::read(&path).map_err(|e| e.to_string())?,
            mime_for(&ext),
        )
    };

    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Returns the hidden sidecar path for an image: `.<filename>.studio.json` in the same dir.
fn sidecar_path(image_path: &str) -> String {
    let p = std::path::Path::new(image_path);
    let filename = p.file_name().unwrap_or_default().to_string_lossy();
    let parent = p
        .parent()
        .map(|d| format!("{}/", d.to_string_lossy()))
        .unwrap_or_default();
    format!("{}.{}.studio.json", parent, filename)
}

/// Migrate old-style sidecar (`<image>.studio.json`) to hidden (`.<image>.studio.json`).
fn migrate_sidecar(image_path: &str) {
    let old = format!("{}.studio.json", image_path);
    let new = sidecar_path(image_path);
    if std::path::Path::new(&old).exists() && !std::path::Path::new(&new).exists() {
        let _ = std::fs::rename(&old, &new);
    }
}

/// Read an image's edit sidecar (`.<image>.studio.json`); empty object if none.
#[tauri::command]
fn read_edits(path: String) -> Result<serde_json::Value, String> {
    let sidecar = sidecar_path(&path);
    match std::fs::read_to_string(&sidecar) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::json!({})),
    }
}

/// Move media files (and their edit sidecars) to the system Trash.
#[tauri::command]
fn trash_media(paths: Vec<String>) -> Result<(), String> {
    for path in &paths {
        if std::path::Path::new(path).exists() {
            trash::delete(path).map_err(|e| e.to_string())?;
        }
        // The hidden edit sidecar goes with it, if present.
        let sidecar = sidecar_path(path);
        if std::path::Path::new(&sidecar).exists() {
            let _ = trash::delete(&sidecar);
        }
    }
    Ok(())
}

/// Write an image's edit sidecar.
#[tauri::command]
fn save_edits(path: String, edits: serde_json::Value) -> Result<(), String> {
    let sidecar = sidecar_path(&path);
    let text = serde_json::to_string_pretty(&edits).map_err(|e| e.to_string())?;
    std::fs::write(&sidecar, text).map_err(|e| e.to_string())
}

/// Write exported image bytes (base64) to a path. Used by the editor's
/// Export / Replace-original flow.
#[tauri::command]
fn write_image(path: String, data_base64: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Encode a PNG (base64) to WebP at the given quality, returning WebP base64.
/// WKWebView's canvas can't encode WebP, so the frontend hands us PNG and we
/// re-encode via libwebp.
#[tauri::command]
fn encode_webp(png_base64: String, quality: f32) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let png = STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&png)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let encoder = webp::Encoder::from_rgba(img.as_raw(), w, h);
    let out = encoder.encode(quality.clamp(1.0, 100.0));
    Ok(STANDARD.encode(&*out))
}

/// Extend (outpaint) an image's background. Input is a PNG (base64) of the
/// enlarged canvas with the original composited in and the new margins left
/// transparent (alpha 0). PatchMatch synthesizes those margins from the
/// image's own content; returns an opaque PNG (base64).
#[tauri::command]
fn extend_background(png_base64: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let png = STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&png)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let filled = patchmatch::outpaint(img.as_raw(), w as usize, h as usize);

    let mut out = Vec::new();
    {
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(&filled, w, h, image::ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())?;
    }
    Ok(STANDARD.encode(&out))
}

/// Generative outpaint via the Automatic1111 (stable-diffusion-webui) HTTP API.
/// `init_base64` is the enlarged canvas (margins pre-filled), `mask_base64`
/// marks the new margins white. Returns the generated PNG (base64). Requires
/// A1111 running with `--api` (default 127.0.0.1:7860).
#[tauri::command]
fn sd_outpaint(
    init_base64: String,
    mask_base64: String,
    prompt: String,
    negative_prompt: String,
    width: u32,
    height: u32,
    steps: u32,
) -> Result<String, String> {
    let host =
        std::env::var("STUDIO_SD_HOST").unwrap_or_else(|_| "http://127.0.0.1:7860".to_string());
    let body = serde_json::json!({
        "init_images": [init_base64],
        "mask": mask_base64,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "denoising_strength": 1.0,
        "mask_blur": 8,
        "inpainting_fill": 2,       // latent noise — generate new content
        "inpaint_full_res": false,  // use the whole image as context
        "resize_mode": 0,
        "steps": steps,
        "cfg_scale": 7.0,
        "width": width,
        "height": height,
        "seed": -1,
    });

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(600))
        .build();

    let resp = match agent
        .post(&format!("{host}/sdapi/v1/img2img"))
        .send_json(body)
    {
        Ok(r) => r,
        // A non-2xx (e.g. 422) means the server is up but rejected the body —
        // surface its message so we can see which field it dislikes.
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            return Err(format!("SD {code}: {}", detail.trim()));
        }
        Err(e) => {
            return Err(format!(
                "SD request failed — is the A1111 API running at {host} (--api)? ({e})"
            ));
        }
    };
    let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    v["images"][0]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "SD API returned no image".to_string())
}

// --- Background removal (macOS Vision framework) ---------------------------

/// Remove the background from a PNG (base64) using the bundled Swift helper
/// (Apple's Vision foreground-instance mask — the tech behind Finder's
/// Remove Background). Returns a transparent PNG (base64).
#[tauri::command]
fn remove_background(png_base64: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let bytes = STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| e.to_string())?;

    // The Vision helper reads/writes files; use unique temp paths.
    let dir = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let in_path = dir.join(format!("studio-bg-{stamp}-in.png"));
    let out_path = dir.join(format!("studio-bg-{stamp}-out.png"));

    std::fs::write(&in_path, &bytes).map_err(|e| e.to_string())?;
    let result = Command::new(env!("BGREMOVE_BIN"))
        .arg(&in_path)
        .arg(&out_path)
        .output();
    let _ = std::fs::remove_file(&in_path);

    let output = result.map_err(|e| e.to_string())?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&out_path);
        let msg = String::from_utf8_lossy(&output.stderr);
        return Err(if msg.trim().is_empty() {
            "background removal failed".into()
        } else {
            msg.trim().to_string()
        });
    }

    let png = std::fs::read(&out_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out_path);
    Ok(STANDARD.encode(&png))
}

/// Read plain text from the clipboard via pbpaste (macOS).
#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    let out = Command::new("pbpaste")
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Studio-native note clipboard sidecar (interaction-spec §7.3, Option A).
/// WebKit sanitizes clipboard HTML on write (stripping our marker), so the rich
/// payload is stashed in an app-cache file and matched against the live system
/// clipboard text on paste. Works across windows and projects.
#[tauri::command]
fn set_note_clipboard(app: AppHandle, data: String) -> Result<(), String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("note-clipboard.json"), data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_note_clipboard(app: AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("note-clipboard.json");
    Ok(std::fs::read_to_string(path).unwrap_or_default())
}

/// Paste an image from the clipboard into a project's media/ folder (PNG).
/// Returns the new file path; errors if the clipboard has no image.
#[tauri::command]
fn paste_image(project_path: String) -> Result<String, String> {
    let media = PathBuf::from(&project_path).join("media");
    std::fs::create_dir_all(&media).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = media.join(format!("pasted-{stamp}.png"));

    let status = Command::new(env!("PBIMAGE_BIN"))
        .arg(&dest)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("No image in clipboard".into());
    }
    Ok(dest.to_string_lossy().to_string())
}

fn millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Write a clipboard image into `<project>/notes/` for an image note. Returns
/// the project-relative path (e.g. "notes/img-123.png").
#[tauri::command]
fn paste_note_image(project_path: String) -> Result<String, String> {
    let dir = PathBuf::from(&project_path).join("notes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("img-{}.png", millis());
    let dest = dir.join(&name);
    let status = Command::new(env!("PBIMAGE_BIN"))
        .arg(&dest)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("No image in clipboard".into());
    }
    Ok(format!("notes/{name}"))
}

/// Copy an external image file into `<project>/notes/` (cross-project image-note
/// paste). Returns the new project-relative path.
#[tauri::command]
fn copy_note_asset(src_abs: String, project_path: String) -> Result<String, String> {
    let src = PathBuf::from(&src_abs);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_string();
    let dir = PathBuf::from(&project_path).join("notes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("img-{}.{ext}", millis());
    std::fs::copy(&src, dir.join(&name)).map_err(|e| e.to_string())?;
    Ok(format!("notes/{name}"))
}

/// Delete an image note's asset — only if it's note-owned (under `notes/`). A
/// `media/` reference is shared with the Media tab and left untouched.
#[tauri::command]
fn delete_note_asset(project_path: String, src: String) -> Result<(), String> {
    if src.starts_with("notes/") {
        let _ = std::fs::remove_file(PathBuf::from(&project_path).join(&src));
    }
    Ok(())
}

/// Write the clipboard image as a project's icon (`.studio-icon.png`).
#[tauri::command]
fn set_project_icon(project_path: String) -> Result<(), String> {
    let dest = PathBuf::from(&project_path).join(".studio-icon.png");
    let status = Command::new(env!("PBIMAGE_BIN"))
        .arg(&dest)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("No image in clipboard".into());
    }
    // Downsize so the longest side is at most 512px (icons don't need more).
    if let Some(p) = dest.to_str() {
        let _ = Command::new("sips").args(["-Z", "512", p]).status();
    }
    Ok(())
}

/// Reveal a file in Finder.
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .args(["-R"])
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read a project's notes.json (defaults to an empty collection if absent).
#[tauri::command]
fn read_notes(path: String) -> Result<serde_json::Value, String> {
    let file = PathBuf::from(&path).join("notes.json");
    match std::fs::read_to_string(&file) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::json!({ "version": 1, "notes": [] })),
    }
}

/// Write a project's notes.json (pretty-printed).
#[tauri::command]
fn save_notes(path: String, notes: serde_json::Value) -> Result<(), String> {
    let file = PathBuf::from(&path).join("notes.json");
    let text = serde_json::to_string_pretty(&notes).map_err(|e| e.to_string())?;
    std::fs::write(&file, text).map_err(|e| e.to_string())
}

/// Resolve a manifest path entry: expand `~`, leave absolute paths, and treat
/// everything else as relative to the project folder.
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

/// RSS (in MB) for a single pid via `ps`.
fn rss_mb_for_pid(pid: &str) -> Option<f64> {
    let out = Command::new("ps").args(["-o", "rss=", "-p", pid]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().ok().map(|kb| kb / 1024.0)
}

/// Summed RSS (in MB) of all processes whose command line matches `pattern`
/// (`pgrep -f`). Returns 0 if none are running.
fn rss_mb_for_pattern(pattern: &str) -> f64 {
    let out = match Command::new("pgrep").args(["-f", pattern]).output() {
        Ok(o) => o,
        Err(_) => return 0.0,
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|pid| rss_mb_for_pid(pid.trim()))
        .sum()
}

#[derive(Clone, Serialize)]
struct MemoryStats {
    /// Studio app's own resident memory, in MB.
    app_mb: f64,
    /// Vite dev server's resident memory, in MB (0 if not running).
    dev_server_mb: f64,
    /// Total system memory in use, in GB (active + wired + compressed).
    system_used_gb: f64,
    /// Total installed system memory, in GB.
    system_total_gb: f64,
    /// Swap space currently in use, in MB. The clearest "things are getting
    /// tight, consider quitting something" signal — unlike raw memory-used,
    /// macOS keeps memory busy with disk cache even when there's no pressure.
    /// Swap's "total" is a dynamic file size, not a meaningful ceiling, so we
    /// only report usage.
    swap_used_mb: f64,
}

#[derive(Clone, Serialize)]
struct ProcessMemory {
    name: String,
    mb: f64,
    /// How many processes were summed into this entry (e.g. a browser's
    /// renderer/GPU/helper processes are grouped under the app name).
    count: u32,
}

/// macOS app bundles run as `/path/To/App.app/Contents/MacOS/Binary` (often
/// with " Helper (Renderer)" etc suffixes on the binary itself). Group those
/// under the bundle's name so e.g. all of Chrome's helpers count as one
/// "Google Chrome" entry; everything else falls back to its own binary name.
fn process_group_name(comm: &str) -> String {
    let path = Path::new(comm);
    for ancestor in path.ancestors() {
        if let Some(name) = ancestor.file_name().and_then(|n| n.to_str()) {
            if let Some(app_name) = name.strip_suffix(".app") {
                return app_name.to_string();
            }
        }
    }
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| comm.to_string())
}

/// The top 10 apps by resident memory (helper/renderer processes grouped under
/// their parent app), for the memory-usage modal — surfaces background apps
/// the user might not realize are running.
#[tauri::command]
fn get_top_processes() -> Result<Vec<ProcessMemory>, String> {
    let out = Command::new("ps")
        .args(["-axo", "rss=,comm="])
        .output()
        .map_err(|e| e.to_string())?;

    let mut grouped: std::collections::HashMap<String, (f64, u32)> = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        let Some((rss, comm)) = line.split_once(' ') else { continue };
        let Ok(mb) = rss.trim().parse::<f64>().map(|kb| kb / 1024.0) else { continue };
        let entry = grouped.entry(process_group_name(comm.trim())).or_insert((0.0, 0));
        entry.0 += mb;
        entry.1 += 1;
    }

    let mut procs: Vec<ProcessMemory> = grouped
        .into_iter()
        .map(|(name, (mb, count))| ProcessMemory { name, mb, count })
        .collect();
    procs.sort_by(|a, b| b.mb.partial_cmp(&a.mb).unwrap_or(std::cmp::Ordering::Equal));
    procs.truncate(10);
    Ok(procs)
}

/// Parse a `sysctl vm.swapusage`-style value like "1024.00M" or "1.50G" into MB.
fn parse_swap_value_mb(s: &str) -> Option<f64> {
    let s = s.trim();
    let (num, unit) = s.split_at(s.len().checked_sub(1)?);
    let val: f64 = num.parse().ok()?;
    match unit {
        "M" => Some(val),
        "G" => Some(val * 1024.0),
        "K" => Some(val / 1024.0),
        _ => None,
    }
}

/// Memory stats for the Workspace header: Studio's own RAM, the Vite dev
/// server's RAM (if running), and system swap usage.
#[tauri::command]
fn get_memory_stats() -> Result<MemoryStats, String> {
    let app_mb = rss_mb_for_pid(&std::process::id().to_string()).unwrap_or(0.0);
    let dev_server_mb = rss_mb_for_pattern("tauri dev");

    let total_out = Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .map_err(|e| e.to_string())?;
    let total_bytes: f64 = String::from_utf8_lossy(&total_out.stdout)
        .trim()
        .parse()
        .map_err(|_| "could not parse sysctl output".to_string())?;
    let system_total_gb = total_bytes / 1024.0 / 1024.0 / 1024.0;

    let vm_out = Command::new("vm_stat").output().map_err(|e| e.to_string())?;
    let vm_text = String::from_utf8_lossy(&vm_out.stdout);
    let page_size: f64 = vm_text
        .lines()
        .next()
        .and_then(|l| l.split("page size of ").nth(1))
        .and_then(|s| s.split(' ').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(4096.0);
    let page_count = |label: &str| -> f64 {
        vm_text
            .lines()
            .find(|l| l.starts_with(label))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|s| s.trim().trim_end_matches('.').parse().ok())
            .unwrap_or(0.0)
    };
    let used_pages = page_count("Pages active")
        + page_count("Pages wired down")
        + page_count("Pages occupied by compressor");
    let system_used_gb = used_pages * page_size / 1024.0 / 1024.0 / 1024.0;

    let swap_out = Command::new("sysctl")
        .args(["-n", "vm.swapusage"])
        .output()
        .map_err(|e| e.to_string())?;
    let swap_text = String::from_utf8_lossy(&swap_out.stdout);
    let mut swap_used_mb = 0.0;
    for part in swap_text.split_whitespace().collect::<Vec<_>>().windows(3) {
        if let ["used", "=", v] = part {
            swap_used_mb = parse_swap_value_mb(v).unwrap_or(0.0);
        }
    }

    Ok(MemoryStats {
        app_mb,
        dev_server_mb,
        system_used_gb,
        system_total_gb,
        swap_used_mb,
    })
}

/// Launch a project's workspace: open apps, files, URLs, the Figma design, and
/// (per claude.mode) drop into `claude` in a terminal at the repo path.
#[tauri::command]
fn launch_workspace(app: AppHandle, path: String) -> Result<(), String> {
    let project_dir = PathBuf::from(&path);
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let ws = read_workspace(path.clone())?;

    // Apps: open -a "AppName"
    for app_name in ws.apps.iter().filter(|a| !a.trim().is_empty()) {
        let _ = Command::new("open").args(["-a", app_name.trim()]).spawn();
    }

    // Files: resolved relative to the project folder.
    for file in ws.files.iter().filter(|f| !f.trim().is_empty()) {
        let resolved = resolve_path(&home, &project_dir, file);
        let _ = Command::new("open").arg(resolved).spawn();
    }

    // URLs + Figma: hand off to the default handler.
    for url in ws.urls.iter().filter(|u| !u.trim().is_empty()) {
        let _ = Command::new("open").arg(url.trim()).spawn();
    }
    if !ws.figma.trim().is_empty() {
        let _ = Command::new("open").arg(ws.figma.trim()).spawn();
    }

    // Repo location, if set. Used for both the editor and the Claude terminal.
    let repo = if ws.repo.trim().is_empty() {
        None
    } else {
        Some(resolve_path(&home, &project_dir, &ws.repo))
    };

    // Open the repo in the code editor (Zed unless the project overrides it).
    if let Some(repo_path) = &repo {
        let editor = if ws.editor.trim().is_empty() {
            "Zed"
        } else {
            ws.editor.trim()
        };
        let _ = Command::new("open")
            .args(["-a", editor])
            .arg(repo_path)
            .spawn();
    }

    // Claude: open Terminal cd'd into the repo and run `claude`.
    if ws.claude.mode == "terminal" {
        let cwd = repo.clone().unwrap_or_else(|| project_dir.clone());
        let repo_str = cwd.to_string_lossy().replace('\'', "'\\''");
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"cd '{repo_str}' && claude\"\nend tell"
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

// --- Claude companion window -------------------------------------------

/// The directory Claude should run in for a project: the workspace's resolved
/// `repo` path if set, otherwise the project folder itself. Keeps the companion
/// window pointed at the actual git repo, in sync with the terminal-mode launch
/// (which also cd's into the repo).
fn claude_cwd(app: &AppHandle, project_path: &str) -> PathBuf {
    let project_dir = PathBuf::from(project_path);
    let ws = read_workspace(project_path.to_string()).unwrap_or_default();
    if ws.repo.trim().is_empty() {
        return project_dir;
    }
    match app.path().home_dir() {
        Ok(home) => resolve_path(&home, &project_dir, &ws.repo),
        Err(_) => project_dir,
    }
}

/// GUI apps don't inherit the user's shell PATH (nvm, homebrew, etc.), so
/// spawning "claude" — and "claude" itself spawning "node" via its shebang —
/// often fails even though it works fine from a terminal. Resolve PATH via a
/// login shell (which sources nvm/profile scripts) once, falling back to the
/// app's own PATH plus common install dirs.
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

/// Keep the Mac from sleeping while Studio is running, so scheduled tasks
/// fire on time. `caffeinate -s -w <pid>` prevents system sleep on AC power
/// and exits on its own once Studio's process exits — no cleanup needed.
fn start_caffeinate() {
    let pid = std::process::id().to_string();
    let _ = Command::new("caffeinate").args(["-s", "-w", &pid]).spawn();
}

/// Start the background loop that fires due `Workspace::schedules` entries.
/// Checks every 30s; a task fires when its `time` matches the current
/// HH:MM, today's weekday is in `days` (or `days` is empty), and it hasn't
/// already run today.
fn start_scheduler(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        run_due_schedules(&app);
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}

fn run_due_schedules(app: &AppHandle) {
    use chrono::{Datelike, Local};
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let hm = now.format("%H:%M").to_string();
    let weekday = now.weekday().num_days_from_sunday() as u8;

    let mut file = read_schedules_file(app);
    let slots = file.slots.clone();
    let mut changed = false;
    for task in file.tasks.iter_mut() {
        let Some(slot) = slots.get(task.slot as usize) else {
            continue;
        };
        if !task.enabled || slot.time != hm {
            continue;
        }
        if !slot.days.is_empty() && !slot.days.contains(&weekday) {
            continue;
        }
        if task.last_run.as_deref() == Some(today.as_str()) {
            continue;
        }
        task.last_run = Some(today.clone());
        changed = true;
        run_scheduled_task(
            app,
            task.project_path.clone(),
            task.prompt.clone(),
            task.model.clone(),
            task.output_file.clone(),
            task.id.clone(),
        );
    }
    if changed {
        let _ = write_schedules_file(app, &file);
    }
}

/// Recompute the set of upcoming wake times needed for all enabled scheduled
/// tasks (across every project) and apply them via `pmset schedule wake`,
/// replacing any previously-set schedule. Runs `pmset` through `osascript
/// ... with administrator privileges`, which prompts for the admin password —
/// called when the user adds/edits/toggles a scheduled task, so the prompt
/// happens while they're present, not at 5am.
///
/// Note: `pmset schedule cancelall` clears *all* scheduled sleep/wake/poweron
/// events system-wide, not just Studio's — fine for a single-user machine,
/// but worth knowing if something else relies on `pmset schedule`.
/// The next wake time for each enabled scheduled task across every project
/// (today..+7 days, respecting `days`), sorted, deduped, and capped at 3 —
/// `pmset` only holds a handful of scheduled events, and tasks sharing a
/// time collapse into one slot. With one daily task, the 3 slots cover the
/// next 3 days; `roll_wake_schedule` keeps adding a new day's slot after
/// each run.
fn compute_wake_times(app: &AppHandle) -> Vec<chrono::DateTime<chrono::Local>> {
    use chrono::{Datelike, Duration, Local, NaiveTime, TimeZone};

    let now = Local::now();
    let file = read_schedules_file(app);
    let mut times = Vec::new();
    for (idx, slot) in file.slots.iter().enumerate() {
        // Skip slots with no enabled task — nothing to wake for.
        if !file.tasks.iter().any(|t| t.enabled && t.slot as usize == idx) {
            continue;
        }
        let Ok(time_of_day) = NaiveTime::parse_from_str(&slot.time, "%H:%M") else {
            continue;
        };
        // Find the next day (today..+7) whose weekday matches `days`
        // (empty = every day) and whose time hasn't passed yet.
        for offset in 0..8 {
            let day = (now + Duration::days(offset)).date_naive();
            let weekday = day.weekday().num_days_from_sunday() as u8;
            if !slot.days.is_empty() && !slot.days.contains(&weekday) {
                continue;
            }
            let Some(candidate) = Local.from_local_datetime(&day.and_time(time_of_day)).single()
            else {
                continue;
            };
            if candidate > now {
                times.push(candidate);
                break;
            }
        }
    }
    times.sort();
    times.dedup();
    times.truncate(3);
    times
}

/// `pmset schedule cancelall && pmset schedule wake "..." && ...` for each of
/// `times`, as a single shell command string (no leading `sudo` — callers
/// prefix that as needed).
fn wake_schedule_script(times: &[chrono::DateTime<chrono::Local>]) -> String {
    let mut script = String::from("pmset schedule cancelall");
    for t in times {
        script.push_str(&format!(" && pmset schedule wake \"{}\"", t.format("%m/%d/%y %H:%M:%S")));
    }
    script
}

/// Recompute and apply the system wake schedule, prompting for the admin
/// password via `osascript ... with administrator privileges`. Called when
/// the user adds/edits/toggles a scheduled task, so the prompt happens while
/// they're present, not at 5am.
///
/// Note: `pmset schedule cancelall` clears *all* scheduled sleep/wake/poweron
/// events system-wide, not just Studio's — fine for a single-user machine,
/// but worth knowing if something else relies on `pmset schedule`.
#[tauri::command]
fn update_wake_schedule(app: AppHandle) -> Result<(), String> {
    // The admin-password prompt is only worth showing when the wake schedule
    // actually changes. Editing a task's prompt/model/output/project doesn't
    // affect wake times, so skip the prompt when the schedule definition
    // (enabled tasks' time + days) matches the last one we applied.
    let signature = wake_signature(&app);
    if let Some(path) = wake_signature_path(&app) {
        if std::fs::read_to_string(&path).ok().as_deref() == Some(signature.as_str()) {
            return Ok(());
        }
    }

    let script = wake_schedule_script(&compute_wake_times(&app));
    let osa = format!("do shell script \"{}\" with administrator privileges", script.replace('"', "\\\""));
    let out = Command::new("osascript")
        .args(["-e", &osa])
        .output()
        .map_err(|e| e.to_string())?;
    // Record the applied signature only on success, so a cancelled/failed
    // prompt is retried next save.
    if out.status.success() {
        if let Some(path) = wake_signature_path(&app) {
            let _ = std::fs::write(path, signature);
        }
    }
    Ok(())
}

/// Path to the cached "last applied wake schedule" signature.
fn wake_signature_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("wake-signature.txt"))
}

/// A stable string capturing everything about the schedule that affects wake
/// times: each enabled task's time and days, sorted. Unchanged across edits
/// that don't touch timing (prompt, model, output file, project).
fn wake_signature(app: &AppHandle) -> String {
    let file = read_schedules_file(app);
    let mut entries: Vec<String> = file
        .slots
        .iter()
        .enumerate()
        .filter(|(idx, _)| file.tasks.iter().any(|t| t.enabled && t.slot as usize == *idx))
        .map(|(_, slot)| {
            let mut days = slot.days.clone();
            days.sort_unstable();
            let days: Vec<String> = days.iter().map(|d| d.to_string()).collect();
            format!("{}@{}", slot.time, days.join(","))
        })
        .collect();
    entries.sort();
    entries.join(";")
}

/// Best-effort roll-forward of the wake schedule after a scheduled task runs,
/// so a recurring task keeps waking the Mac without the user reopening
/// Studio every week. Uses `sudo -n` (non-interactive): if the admin-password
/// timestamp from an earlier `update_wake_schedule` prompt has expired, this
/// silently does nothing — the schedule just won't extend until the user
/// next edits a task (or grants `pmset` passwordless sudo).
fn roll_wake_schedule(app: &AppHandle) {
    let times = compute_wake_times(app);
    if times.is_empty() {
        return;
    }
    let script = wake_schedule_script(&times)
        .split(" && ")
        .map(|cmd| format!("sudo -n {cmd}"))
        .collect::<Vec<_>>()
        .join(" && ");
    let _ = Command::new("sh").args(["-c", &script]).output();
}

/// Manually fire a scheduled task immediately (the "Run now" button), without
/// waiting for the scheduler loop or touching `lastRun`.
#[tauri::command]
fn run_schedule_now(
    app: AppHandle,
    project_path: String,
    prompt: String,
    model: String,
    output_file: String,
    task_id: String,
) {
    run_scheduled_task(&app, project_path, prompt, model, output_file, task_id);
}

/// Run `claude -p <prompt>` headless in the project's repo dir, write the
/// result to `<project>/<output_file>` (overwriting it), and emit
/// `"schedule-ran"` so the UI can show it if the project is open.
fn run_scheduled_task(
    app: &AppHandle,
    project_path: String,
    prompt: String,
    model: String,
    output_file: String,
    task_id: String,
) {
    let app = app.clone();
    // Blank project = the "Global" default: run in (and write output to) the
    // ~/Projects root.
    let project_path = if project_path.trim().is_empty() {
        projects_root(&app)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(project_path)
    } else {
        project_path
    };
    let cwd = claude_cwd(&app, &project_path);
    std::thread::spawn(move || {
        let mut cmd = Command::new("claude");
        cmd.env("PATH", claude_path())
            .current_dir(&cwd)
            .arg("-p")
            // Headless: nobody is around to approve tool-use prompts.
            .arg("--permission-mode")
            .arg("bypassPermissions");
        if !model.trim().is_empty() {
            cmd.args(["--model", model.trim()]);
        }
        let output = cmd.arg(&prompt).output();
        let (ok, text) = match output {
            Ok(o) if o.status.success() => (true, String::from_utf8_lossy(&o.stdout).to_string()),
            Ok(o) => (false, String::from_utf8_lossy(&o.stderr).to_string()),
            Err(e) => (false, e.to_string()),
        };

        let file_name = if output_file.trim().is_empty() {
            default_schedule_output_file()
        } else {
            output_file.trim().to_string()
        };
        let file_name = if file_name.to_lowercase().ends_with(".md") {
            file_name
        } else {
            format!("{file_name}.md")
        };
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
        let section = if ok { "Output" } else { "Error" };
        let contents = format!("# Scheduled task — {timestamp}\n\n**{section}:**\n\n{text}\n");
        let _ = std::fs::write(PathBuf::from(&project_path).join(&file_name), contents);

        // Record when (and how) this task last ran, for both scheduled and
        // manual runs, in the global schedules store.
        let mut file = read_schedules_file(&app);
        if let Some(task) = file.tasks.iter_mut().find(|t| t.id == task_id) {
            task.last_run_at = Some(timestamp.clone());
            task.last_run_ok = Some(ok);
            let _ = write_schedules_file(&app, &file);
        }

        let _ = app.emit(
            "schedule-ran",
            serde_json::json!({
                "projectPath": project_path,
                "taskId": task_id,
                "ok": ok,
                "output": text,
                "outputFile": file_name,
                "lastRunAt": timestamp,
            }),
        );

        roll_wake_schedule(&app);
    });
}

/// A running `claude -p` subprocess for one companion-window chat session.
struct ClaudeProc {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct ClaudeState {
    procs: Mutex<HashMap<String, ClaudeProc>>,
}

/// Open (or focus) the standalone Scheduled Tasks window, listing scheduled
/// tasks across every project under ~/Projects.
#[tauri::command]
fn open_schedules_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("schedules") {
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        use tauri_plugin_window_state::{StateFlags, WindowExt};
        let win = WebviewWindowBuilder::new(
            &app,
            "schedules",
            WebviewUrl::App("schedules/index.html".into()),
        )
        .title("Scheduled Tasks")
        .inner_size(640.0, 760.0)
        .min_inner_size(420.0, 360.0)
        .build()
        .map_err(|e| e.to_string())?;
        let _ = win.restore_state(StateFlags::SIZE | StateFlags::POSITION);
    }
    Ok(())
}

/// Open (or focus) the Claude companion window, then tell it which session
/// (and project) to show. The frontend listens for "claude-jump".
#[tauri::command]
fn open_claude_window(
    app: AppHandle,
    key: Option<String>,
    project_path: Option<String>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("claude") {
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        use tauri_plugin_window_state::{StateFlags, WindowExt};
        let win =
            WebviewWindowBuilder::new(&app, "claude", WebviewUrl::App("claude/index.html".into()))
                .title("Claude")
                .inner_size(600.0, 800.0)
                .min_inner_size(420.0, 360.0)
                .build()
                .map_err(|e| e.to_string())?;
        // The window is created dynamically, so the window-state plugin doesn't
        // auto-restore it — apply the saved size/position explicitly. It's saved
        // again on app exit by the plugin.
        let _ = win.restore_state(StateFlags::SIZE | StateFlags::POSITION);
    }
    let _ = app.emit(
        "claude-jump",
        serde_json::json!({ "key": key, "projectPath": project_path }),
    );
    Ok(())
}

/// Percent-encode a string for use in a URL query value (RFC 3986 unreserved
/// kept; everything else encoded). Used to build the deep-link URL below.
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

/// Launch (or focus) the standalone Claude companion app for a project, via its
/// `studio-claude://` URL scheme. The companion is a separate process, so it
/// survives Studio rebuilds. (The in-Studio `open_claude_window` above is kept
/// for reference / possible reuse but no longer wired to the UI.)
#[tauri::command]
fn launch_claude_app(project_path: String) -> Result<(), String> {
    let name = Path::new(&project_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let url = format!(
        "studio-claude://open?project={}&name={}",
        url_encode(&project_path),
        url_encode(name),
    );
    Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Send a message to a companion-window chat session, spawning the `claude`
/// subprocess for it on first use. `key` is a UI-side session id used to
/// route streamed output back via the "claude-stream-<key>" event; `resume`
/// is the underlying Claude Code session id to resume, if any.
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

/// Kill a companion-window chat session's subprocess, if running.
#[tauri::command]
fn claude_stop(state: tauri::State<ClaudeState>, key: String) {
    if let Some(mut proc) = state.procs.lock().unwrap().remove(&key) {
        let _ = proc.child.kill();
    }
}

/// Persisted list of companion-window sessions (id, name, project, model, etc),
/// stored as opaque JSON managed entirely by the frontend.
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

/// One existing Claude Code session found on disk for a project.
#[derive(Clone, Serialize)]
struct ClaudeHistorySession {
    session_id: String,
    summary: String,
    modified: u64,
}

/// List Claude Code sessions previously recorded for `project_path`, by
/// reading `~/.claude/projects/<encoded-path>/*.jsonl` (the format Claude
/// Code itself uses for `--resume`). Newest first.
#[tauri::command]
fn list_claude_project_sessions(app: AppHandle, project_path: String) -> Vec<ClaudeHistorySession> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    // Claude records sessions under the cwd it ran in — the repo, not the
    // project folder — so encode that path to find them.
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
struct ClaudeLogMessage {
    role: String,
    text: String,
}

/// Read the full transcript of a recorded Claude Code session
/// (`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`) so the UI can show
/// the past chat log when resuming a session started outside Studio. Returns
/// user/assistant text and a compact summary of each tool call, in order.
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

/// Current account usage (the numbers behind Claude's `/usage`): 5-hour and
/// 7-day quota utilization, fetched from `/api/oauth/usage` with the OAuth
/// token Claude Code stores in the macOS Keychain. Account-wide, not per
/// session. Returns the raw JSON (`five_hour`/`seven_day`/`extra_usage`).
#[tauri::command]
fn get_claude_usage() -> Result<serde_json::Value, String> {
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

/// Move an entire project folder to the Trash.
#[tauri::command]
fn trash_project(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Rename a media file in place, moving its edits sidecar too if present.
#[tauri::command]
fn rename_media(old_path: String, new_name: String) -> Result<String, String> {
    let old = PathBuf::from(&old_path);
    let dir = old.parent().ok_or("no parent dir")?;
    let new = dir.join(&new_name);
    if new.exists() {
        return Err(format!("A file named \"{}\" already exists", new_name));
    }
    std::fs::rename(&old, &new).map_err(|e| e.to_string())?;
    // Move sidecar if present.
    let old_sidecar = PathBuf::from(sidecar_path(&old_path));
    if old_sidecar.exists() {
        let new_sidecar = PathBuf::from(sidecar_path(&new.to_string_lossy()));
        let _ = std::fs::rename(&old_sidecar, &new_sidecar);
    }
    Ok(new.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(ClaudeState::default())
        .invoke_handler(tauri::generate_handler![
            open_claude_window,
            launch_claude_app,
            open_schedules_window,
            claude_send,
            claude_stop,
            run_schedule_now,
            update_wake_schedule,
            read_claude_sessions,
            save_claude_sessions,
            list_claude_project_sessions,
            read_claude_session_log,
            get_claude_usage,
            get_active_project,
            clear_active_project,
            save_tool_export,
            list_projects,
            open_project,
            create_project,
            read_workspace,
            save_workspace,
            launch_workspace,
            get_memory_stats,
            get_top_processes,
            read_notes,
            save_notes,
            list_media,
            quicklook_thumb,
            edited_thumb,
            save_edited_thumb,
            open_path,
            open_app,
            open_in_photos,
            run_shortcut,
            heic_preview,
            import_media,
            handle_dropped_paths,
            read_media_meta,
            save_media_meta,
            read_project_order,
            save_project_order,
            read_schedules,
            save_schedules,
            paste_image,
            paste_note_image,
            copy_note_asset,
            delete_note_asset,
            set_project_icon,
            read_clipboard_text,
            set_note_clipboard,
            get_note_clipboard,
            reveal_in_finder,
            remove_background,
            extend_background,
            sd_outpaint,
            encode_webp,
            read_image_data,
            read_edits,
            save_edits,
            trash_media,
            write_image,
            rename_media,
            trash_project,
            set_window_width
        ])
        // Closing the window should NOT quit Studio — it lives in the menu bar.
        // Hide the window instead of destroying it; only "Quit Studio" exits.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            // Menu-bar app: no Dock icon, lives in the system tray.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            let projects = scan_projects(&handle);
            let menu = build_tray_menu(&handle, &projects, None)?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "open_studio" => {
                            show_studio(app);
                            let _ = app.emit("show-overview", ());
                        }
                        "new_project" => {
                            show_studio(app);
                            let _ = app.emit("new-project-request", ());
                        }
                        "open_schedules" => {
                            let _ = open_schedules_window(app.clone());
                        }
                        "quit" => app.exit(0),
                        _ if id.starts_with(PROJECT_PREFIX) => {
                            activate_project(app, &id[PROJECT_PREFIX.len()..]);
                        }
                        _ if id.starts_with(TOOL_PREFIX) => {
                            open_tool_window(app, &id[TOOL_PREFIX.len()..]);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Live-refresh when files change in ~/Projects (Finder, other apps).
            start_watching(&handle);

            // Periodically run any due scheduled `claude -p` tasks.
            start_scheduler(&handle);

            // Prevent system sleep so scheduled tasks fire while Studio runs.
            start_caffeinate();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Studio");
}
