mod patchmatch;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
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
    /// Bright background color (hex, e.g. "#ffd23f") for this project's Git
    /// companion window. Blank = a default bright. Set via the repo card's
    /// swatch row in the Workspace tab.
    #[serde(default, rename = "gitColor")]
    git_color: String,
    /// Project-wide accent color (hex, e.g. "#ff5d8f"). Used to tint windows
    /// opened in relation to this project. Set via the Mode switcher's color
    /// swatches; intended to supersede the per-repo `gitColor`.
    #[serde(default)]
    color: String,
    #[serde(default)]
    figma: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default)]
    scripts: Vec<String>,
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
    /// Named window-layout snapshots (Code / Design / Default, plus any the
    /// user adds), each recorded via the Workspace tab's record/play buttons.
    #[serde(default = "default_modes")]
    modes: Vec<WorkspaceMode>,
}

fn default_modes() -> Vec<WorkspaceMode> {
    ["Code", "Design", "Default"]
        .iter()
        .map(|name| WorkspaceMode {
            id: name.to_lowercase(),
            name: name.to_string(),
            layout: Vec::new(),
            recorded_at: None,
        })
        .collect()
}

/// One Workspace mode: a name and its recorded window layout (empty until
/// the user hits Record).
#[derive(Clone, Serialize, Deserialize, Default)]
struct WorkspaceMode {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    layout: Vec<WindowSnapshot>,
    /// ISO timestamp of the last successful Record, shown in the UI as
    /// "Saved <when>". Set by the frontend, not Rust — Record's result
    /// already round-trips through JS either way.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "recordedAt")]
    recorded_at: Option<String>,
}

/// One recorded window: which app/title owned it and its on-screen frame.
#[derive(Clone, Serialize, Deserialize, Default)]
struct WindowSnapshot {
    #[serde(default)]
    app: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    x: i32,
    #[serde(default)]
    y: i32,
    #[serde(default)]
    w: i32,
    #[serde(default)]
    h: i32,
    /// Git-window-only: the repo path + companion-window color/editor, so a
    /// Git window that's since been *closed* (which deletes its entry from
    /// git-windows.json — see `remove_git_window`) can still be rebuilt from
    /// the snapshot alone, not just reopened from a live store entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    editor: Option<String>,
    /// Tool-window-only (label starts with "tool-"): the `src/tools/*.html`
    /// file + query string (or, for `tool_kind: "color"`, the bare color) it
    /// was opened with, captured at record time from `TOOL_WINDOWS` — needed
    /// to rebuild it if it's not open yet (e.g. a fresh launch, before the
    /// user has opened that tool this session) since its label alone (often
    /// a hash) can't be reversed back into one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_query: Option<String>,
    /// "plain" (reopen via `open_tool`) or "color" (reopen via
    /// `open_tool_window_with_color` — a different label scheme, so it must
    /// be replayed through that same function). Missing/absent = "plain".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_kind: Option<String>,
}

/// label → (file, query/color, kind) for every tool window opened this
/// session, so a Workspace mode recorded while one was open can store enough
/// to rebuild it later — even after a restart, since a label alone (often a
/// hash, or otherwise unparseable) can't be reversed back into the args its
/// opener needs. `kind` is `"plain"` (reopen via `open_tool`, used by
/// `open_tool`/`open_tool_window_near`/`open_tool_window`) or `"color"`
/// (reopen via `open_tool_window_with_color`, which uses a different label
/// scheme — filename-with-extension, not file_stem — so it must be replayed
/// through that exact function for the label, and thus the position/size
/// restore that depends on it, to match).
static TOOL_WINDOWS: OnceLock<Mutex<HashMap<String, (String, Option<String>, String)>>> =
    OnceLock::new();

fn tool_windows_store() -> &'static Mutex<HashMap<String, (String, Option<String>, String)>> {
    TOOL_WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn track_tool_window(label: &str, file: &str, query: Option<String>, kind: &str) {
    tool_windows_store()
        .lock()
        .unwrap()
        .insert(label.to_string(), (file.to_string(), query, kind.to_string()));
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
    /// Tool file in `src/tools/` to open when this task fires, e.g.
    /// "daily-briefing.html". When set, firing opens that tool's window
    /// instead of running a `claude -p` prompt — the "open a tool at a time"
    /// mode. Empty = legacy prompt task (`prompt`/`model`/`output_file`).
    #[serde(default)]
    tool: String,
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
    /// A file each per-project Code Editor window should load on launch, keyed by
    /// window label. One-shot: the window consumes its entry via
    /// `take_pending_open` on first load, so a dev-watcher reload (which reloads
    /// every webview) falls back to the restored session instead of snapping
    /// back to this file. Keyed by label — not a single global slot — so opening
    /// a file for one project can't be grabbed by another project's window.
    pending_open: Mutex<HashMap<String, String>>,
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

#[derive(serde::Serialize)]
struct SpotlightTool {
    name: String,
    file: String,
}

/// Tool list for the Spotlight launcher: name + bare filename (so the
/// frontend can pass it straight to `open_tool`).
#[tauri::command]
fn list_tools(app: AppHandle) -> Vec<SpotlightTool> {
    scan_tools(&app)
        .into_iter()
        .map(|p| SpotlightTool {
            name: p.name,
            file: Path::new(&p.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string(),
        })
        .collect()
}

/// Show/hide the Spotlight-style quick launcher (Option+Space). Built once,
/// then just shown/hidden/focused — transparent + undecorated + always-on-top,
/// centered on screen, with a fixed size; the page itself stays visually
/// empty except for a floating card so unfilled space reads as transparent.
fn toggle_spotlight_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("spotlight") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.emit("spotlight-shown", ());
        }
        return;
    }

    let url = WebviewUrl::App("tools/spotlight.html".into());
    if let Ok(win) = WebviewWindowBuilder::new(app, "spotlight", url)
        .inner_size(640.0, 460.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .center()
        .visible(false)
        .build()
    {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Show/hide the giant-text Mode switcher (Ctrl+Space). Same transparent,
/// undecorated, always-on-top card treatment as Spotlight; switches the active
/// project's window-layout modes via arrow keys + Enter.
fn toggle_mode_switcher_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("mode-switcher") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.emit("mode-switcher-shown", ());
        }
        return;
    }

    let url = WebviewUrl::App("tools/mode-switcher.html".into());
    if let Ok(win) = WebviewWindowBuilder::new(app, "mode-switcher", url)
        .inner_size(960.0, 690.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .center()
        .visible(false)
        .build()
    {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Open (or focus) a tool's HTML file in its own native window.
/// How a tool window is chromed. One source of truth so the look of a tool is
/// decided in exactly one place — every builder below routes through
/// `apply_tool_chrome`, so a style fix can't drift between them (it used to:
/// the same per-tool `if` was copy-pasted into three builders).
enum Chrome {
    /// Fully custom: no native title bar / traffic lights. The page paints its
    /// own draggable bar + close button + rounded corners (see
    /// `src/kit/window-chrome.js`) and reads `?color=` for its tint.
    Custom,
    /// Native title bar, transparent + tinted to the window's color (or paper).
    NativeTint,
    /// Plain native title bar with the OS default look.
    Native,
}

/// Where a tool window's tint comes from.
enum Tint {
    /// The active project's accent / git color (passed in as `color`).
    Project,
    /// The Runes paper background (#f7f5f0) — for global, project-less tools.
    Paper,
    /// No tint (Native chrome).
    None,
}

struct ToolStyle {
    w: f64,
    h: f64,
    /// Blank the native title (the page owns the bar) vs. show the tool name.
    empty_title: bool,
    chrome: Chrome,
    tint: Tint,
}

/// Per-tool window style table. To migrate a tool to the custom chrome: flip
/// its `chrome` to `Chrome::Custom` here AND give its HTML the kit window-chrome
/// (link `kit/window-chrome.css`, import `kit/window-chrome.js`, mark its top
/// bar `data-window-bar`). Spotlight / Mode switcher have their own bespoke
/// invisible windows and never come through here.
fn tool_style(filename: &str) -> ToolStyle {
    let s = |w, h, empty_title, chrome, tint| ToolStyle { w, h, empty_title, chrome, tint };
    match filename {
        "code-editor.html" => s(900.0, 640.0, true, Chrome::Custom, Tint::Project),
        "code-preview.html" => s(900.0, 640.0, true, Chrome::NativeTint, Tint::Project),
        "daily-notes.html" => s(300.0, 600.0, true, Chrome::NativeTint, Tint::Paper),
        "ram-overview.html" => s(380.0, 440.0, true, Chrome::NativeTint, Tint::Paper),
        "file-directory.html" => s(350.0, 640.0, true, Chrome::Custom, Tint::Paper),
        "tasks.html" => s(800.0, 800.0, true, Chrome::NativeTint, Tint::Paper),
        "modes.html" => s(320.0, 480.0, true, Chrome::NativeTint, Tint::Paper),
        "kit-gallery.html" => s(900.0, 640.0, true, Chrome::NativeTint, Tint::Paper),
        "daily-briefing.html" => s(1080.0, 760.0, true, Chrome::NativeTint, Tint::Paper),
        "mycelium.html" => s(1100.0, 760.0, false, Chrome::Native, Tint::None),
        _ => s(900.0, 640.0, false, Chrome::Native, Tint::None),
    }
}

/// Apply a tool's window style (size + chrome) to its builder. `color` is the
/// resolved tint color hex (project/repo accent), or empty for none.
fn apply_tool_chrome<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::webview::WebviewWindowBuilder<'a, R, M>,
    filename: &str,
    color: &str,
) -> tauri::webview::WebviewWindowBuilder<'a, R, M> {
    let st = tool_style(filename);
    let mut builder = builder.inner_size(st.w, st.h);
    match st.chrome {
        Chrome::Custom => {
            // `decorations(false)` removes the native bar + traffic lights;
            // `transparent(true)` lets the page's rounded corners show the
            // desktop through them. `shadow(false)` is required: the default
            // macOS window shadow is drawn around the SQUARE window bounds,
            // which reads as a 1px black border + square corners (same recipe
            // as the Spotlight / Mode switcher windows).
            builder = builder.decorations(false).transparent(true).shadow(false);
        }
        Chrome::NativeTint => {
            let (r, g, b) = match st.tint {
                Tint::Project if !color.is_empty() => parse_hex(color),
                _ => (0xf7, 0xf5, 0xf0),
            };
            builder = builder
                .title_bar_style(tauri::TitleBarStyle::Transparent)
                .background_color(tauri::webview::Color(r, g, b, 0xff));
        }
        Chrome::Native => {}
    }
    builder
}

fn open_tool_window(app: &AppHandle, path: &str) {
    open_tool_window_near(app, path, None);
}

fn open_tool_window_with_color(app: &AppHandle, path: &str, color: &str) {
    // The Code Editor is opened per-project, not as a shared singleton.
    if Path::new(path).file_name().and_then(|n| n.to_str()) == Some("code-editor.html") {
        open_code_editor_window(app, color, &active_project_path(app), None);
        return;
    }
    if color.is_empty() {
        open_tool_window_near(app, path, None);
        return;
    }
    // Encode the color into the URL so the tool can apply it immediately on
    // first paint (before any Tauri events fire), matching the git window pattern.
    let filename = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let label = format!(
        "tool-{}",
        filename
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect::<String>()
    );
    track_tool_window(&label, filename, Some(color.to_string()), "color");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let url = format!("tools/{}?color={}", filename, url_encode(color));
    let title = if tool_style(filename).empty_title {
        String::new()
    } else {
        Path::new(filename)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .replace('-', " ")
            .split_whitespace()
            .map(|w| { let mut c = w.chars(); c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default() })
            .collect::<Vec<_>>()
            .join(" ")
    };
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into())).title(title);
    let _ = apply_tool_chrome(builder, filename, color).build();
}

/// Per-project window label for the Code Editor, so each project gets its own
/// editor window + restored session (keyed by the same project path on the JS
/// side via the `?session=` param). Empty path → the project-less "none" scope.
fn code_editor_label(project_path: &str) -> String {
    let scope = if project_path.is_empty() {
        "none".to_string()
    } else {
        slugify(project_path)
    };
    format!("tool-code-editor-html-{}", scope)
}

/// Open (or focus) the Code Editor window for `project_path`. Unlike a generic
/// tool window it is keyed per project: the label carries a project slug and the
/// URL carries `?session=<project_path>` so the page scopes its restored session
/// to that project (see `restore()` in code-editor.html). `color` is the
/// first-paint tint hint; the page re-derives it per open file afterwards.
///
/// `open_file` is an optional path to load: for an already-open window it's
/// delivered as a `ce:open-file` event *to that window only*; for a fresh window
/// it's stashed one-shot in `pending_open` keyed by this window's label. Both
/// are window-scoped, so opening a file for one project never loads it into
/// another's editor, and a reload falls back to the restored session.
fn open_code_editor_window(app: &AppHandle, color: &str, project_path: &str, open_file: Option<String>) {
    let filename = "code-editor.html";
    let label = code_editor_label(project_path);
    // Track with the project path as the query + a dedicated kind, so a saved
    // Workspace mode can rebuild this exact per-project window later.
    track_tool_window(&label, filename, Some(project_path.to_string()), "code-editor");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        if let Some(file) = open_file {
            // Stamp the target label so other editor windows that also receive
            // this event (global JS listeners) ignore it.
            let _ = app.emit_to(&label, "ce:open-file", serde_json::json!({ "label": label, "file": file }));
        }
        return;
    }
    // One-shot file to load on first launch, keyed by this window's label so it
    // can't be consumed by another project's window, and so a dev-watcher reload
    // (no entry the second time) falls back to the restored session rather than
    // re-loading this file over wherever the user navigated.
    if let Some(file) = open_file {
        app.state::<AppState>()
            .pending_open
            .lock()
            .unwrap()
            .insert(label.clone(), file);
    }
    let mut params: Vec<String> = Vec::new();
    if !color.is_empty() {
        params.push(format!("color={}", url_encode(color)));
    }
    if !project_path.is_empty() {
        params.push(format!("session={}", url_encode(project_path)));
    }
    let qs = if params.is_empty() {
        String::new()
    } else {
        format!("?{}", params.join("&"))
    };
    let url = format!("tools/{}{}", filename, qs);
    // code-editor has empty_title (the page paints its own bar).
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(String::new());
    let _ = apply_tool_chrome(builder, filename, color).build();
}

/// The active project's folder path, or empty if none is active.
fn active_project_path(app: &AppHandle) -> String {
    app.state::<AppState>()
        .active
        .lock()
        .unwrap()
        .clone()
        .map(|p| p.path)
        .unwrap_or_default()
}

/// The project that owns `file`: the project whose folder — or whose workspace
/// `repo` (resolved, since a repo often lives outside the project folder, e.g.
/// `~/Documents/GitHub/Studio`) — is the longest path prefix of the file. This
/// is how the Code Editor scopes by the *file's* project rather than whichever
/// project happens to be active. Returns None if the file is under no project.
fn project_path_for_file(app: &AppHandle, file: &str) -> Option<String> {
    let home = app.path().home_dir().ok();
    let target = PathBuf::from(file);
    let mut best: Option<(usize, String)> = None;
    for p in scan_projects(app) {
        let project_dir = PathBuf::from(&p.path);
        let mut roots = vec![project_dir.clone()];
        if let (Ok(ws), Some(home)) = (read_workspace(p.path.clone()), home.as_ref()) {
            if !ws.repo.trim().is_empty() {
                roots.push(resolve_path(home, &project_dir, &ws.repo));
            }
        }
        for root in roots {
            if target.starts_with(&root) {
                let len = root.as_os_str().len();
                if best.as_ref().map_or(true, |(l, _)| len > *l) {
                    best = Some((len, p.path.clone()));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Open a tool window, optionally positioned just below a tray icon's rect
/// (as reported by `TrayIconEvent::Click`).
fn open_tool_window_near(app: &AppHandle, path: &str, near: Option<tauri::Rect>) {
    // The Code Editor is opened per-project, not as a shared singleton.
    if Path::new(path).file_name().and_then(|n| n.to_str()) == Some("code-editor.html") {
        let color = active_git_color_hex(app).unwrap_or_default();
        open_code_editor_window(app, &color, &active_project_path(app), None);
        return;
    }
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

    // Load via the app's tauri://localhost protocol (the tool's HTML lives
    // in src/tools/, part of frontendDist) rather than file://: file://
    // windows send `Origin: null`, which Tauri's IPC rejects ("Origin
    // header not valid URL").
    let Some(filename) = Path::new(path).file_name().and_then(|n| n.to_str()) else {
        return;
    };
    track_tool_window(&label, filename, None, "plain");

    if let Some(win) = app.get_webview_window(&label) {
        if let Some(rect) = near {
            // Tray-icon click: toggle visibility instead of always showing.
            if win.is_visible().unwrap_or(false) {
                let _ = win.hide();
                return;
            }
            position_below_tray_icon(&win, &rect);
        }
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let style = tool_style(filename);
    let title = if style.empty_title {
        String::new()
    } else {
        Path::new(path)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("Tool")
            .to_string()
    };

    // Resolve the tint: project-tinted tools (e.g. code-preview) pick up the
    // active project's color and pass it through the URL so the page can paint
    // its own bar on first frame; paper/none tools need no color.
    let color = match style.tint {
        Tint::Project => active_git_color_hex(app).unwrap_or_default(),
        _ => String::new(),
    };
    let url = if color.is_empty() {
        format!("tools/{filename}")
    } else {
        format!("tools/{filename}?color={}", url_encode(&color))
    };

    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into())).title(title);
    let builder = apply_tool_chrome(builder, filename, &color);

    if let Ok(win) = builder.build() {
        if let Some(rect) = near {
            position_below_tray_icon(&win, &rect);
        }
    }
}

/// Position a window's top-left just below and left-aligned with a tray
/// icon's rect, clamped so it doesn't go off the right edge of the screen.
fn position_below_tray_icon(win: &tauri::WebviewWindow, rect: &tauri::Rect) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let icon_pos = rect.position.to_physical::<f64>(scale);
    let icon_size = rect.size.to_physical::<f64>(scale);
    let win_size = win.outer_size().unwrap_or_default();

    let mut x = icon_pos.x + icon_size.width - win_size.width as f64;
    let y = icon_pos.y + icon_size.height;

    if x < 0.0 {
        x = 0.0;
    }

    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
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

/// One entry in `TrayItems.json` — controls the order and icon of Studio's
/// menu-bar items.
#[derive(Deserialize)]
struct TrayItemEntry {
    id: String,
    #[serde(default)]
    icon: Option<String>,
}

/// `TrayItems.json`, bundled with Studio (see `tauri.conf.json` →
/// `bundle.resources`) — order and optional icon overrides for Studio's
/// menu-bar items: "studio" (main menu), "tools" (wrench dropdown), "ram"
/// (RAM overview), and "daily-notes". Missing/unreadable file falls back to
/// the default order with no overrides.
fn read_tray_items_manifest(app: &AppHandle) -> Option<Vec<TrayItemEntry>> {
    let dir = app.path().resource_dir().ok()?;
    let text = std::fs::read_to_string(dir.join("TrayItems.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Left-to-right order of Studio's menu-bar items, from `TrayItems.json` if
/// present, otherwise the default `["studio", "ram", "daily-notes"]`.
fn tray_item_order(app: &AppHandle) -> Vec<String> {
    match read_tray_items_manifest(app) {
        Some(entries) if !entries.is_empty() => {
            entries.into_iter().map(|e| e.id).collect()
        }
        _ => vec![
            "studio".to_string(),
            "tools".to_string(),
            "ram".to_string(),
            "daily-notes".to_string(),
        ],
    }
}

/// Icon override for a given tray item id, loaded from `icons/<file>` (see
/// `bundle.resources` → `"tray-icons"`). Returns `None` if `TrayItems.json`
/// doesn't specify an `icon` for this id, or the file can't be loaded.
fn tray_item_icon(app: &AppHandle, id: &str) -> Option<Image<'static>> {
    let entries = read_tray_items_manifest(app)?;
    let file = entries.into_iter().find(|e| e.id == id)?.icon?;
    let dir = app.path().resource_dir().ok()?;
    Image::from_path(dir.join("tray-icons").join(file)).ok()
}

/// Build Studio's main tray icon: project list menu, "New Project", tools, etc.
fn build_studio_tray(app: &AppHandle, icon: Option<Image<'static>>) -> tauri::Result<()> {
    let projects = scan_projects(app);
    let menu = build_tray_menu(app, &projects, None)?;
    let icon = icon.unwrap_or_else(|| app.default_window_icon().unwrap().clone());

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
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
                "quit" => app.exit(0),
                _ if id.starts_with(PROJECT_PREFIX) => {
                    activate_project(app, &id[PROJECT_PREFIX.len()..]);
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/// Build the RAM-overview tray icon: a live "X.X GB" text label; click opens
/// the details window below it.
fn build_ram_tray(app: &AppHandle, icon: Option<Image<'static>>) -> tauri::Result<()> {
    let ram_title = match get_memory_stats() {
        Ok(stats) => format!("{:.1} GB", stats.system_used_gb),
        Err(_) => "RAM".to_string(),
    };
    let icon = icon.unwrap_or_else(|| app.default_window_icon().unwrap().clone());

    TrayIconBuilder::with_id("ram-tray")
        .icon(icon)
        .icon_as_template(true)
        .title(ram_title)
        .tooltip("RAM overview")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                rect,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                open_tool_window_near(tray.app_handle(), "ram-overview.html", Some(rect));
            }
        })
        .build(app)?;
    Ok(())
}

/// Build the Daily Notes tray icon: one click away, no menu.
fn build_daily_notes_tray(app: &AppHandle, icon: Option<Image<'static>>) -> tauri::Result<()> {
    let icon = match icon {
        Some(icon) => icon,
        None => Image::from_bytes(include_bytes!("../icons/daily-notes-tray.png"))?,
    };

    TrayIconBuilder::with_id("daily-notes-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Daily Notes")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                rect,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                open_tool_window_near(tray.app_handle(), "daily-notes.html", Some(rect));
            }
        })
        .build(app)?;
    Ok(())
}

/// Build the Tools tray icon: a wrench dropdown with the built-in Scheduled
/// Tasks / Video Editor windows, then any user tools from `scan_tools()`.
fn build_tools_tray(app: &AppHandle, icon: Option<Image<'static>>) -> tauri::Result<()> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    items.push(Box::new(MenuItem::with_id(
        app,
        "open_schedules",
        "🗓 Scheduled Tasks",
        true,
        None::<&str>,
    )?));
    items.push(Box::new(MenuItem::with_id(
        app,
        "open_video",
        "🎬 Video Editor",
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
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
    let menu = Menu::with_items(app, &refs)?;

    let icon = match icon {
        Some(icon) => icon,
        None => Image::from_bytes(include_bytes!("../icons/hexagon.png"))?,
    };

    TrayIconBuilder::with_id("tools-tray")
        .icon(icon)
        .tooltip("Tools")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "open_schedules" => {
                    let _ = open_schedules_window(app.clone());
                }
                "open_video" => {
                    if let Some(project) = app.state::<AppState>().active.lock().unwrap().clone() {
                        let _ = open_video_window(app.clone(), project.path, None);
                    }
                }
                _ if id.starts_with(TOOL_PREFIX) => {
                    open_tool_window(app, &id[TOOL_PREFIX.len()..]);
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
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

    // Tidy the per-project Code Editor windows: hide every other project's, and
    // raise this project's if it's already open. Without this, switching
    // projects leaves the previous project's editor frontmost (per-project
    // windows are independent — nothing else brings the active one forward).
    // Runs before any mode apply below, which can still override the layout.
    let active_editor = code_editor_label(&project.path);
    for (label, win) in app.webview_windows() {
        if !label.starts_with("tool-code-editor-html-") {
            continue;
        }
        if label == active_editor {
            let _ = win.show();
            let _ = win.set_focus();
        } else {
            let _ = win.hide();
        }
    }

    // Auto-apply the project's first recorded Mode (first with a saved layout),
    // so activating a project snaps its windows into place.
    if let Ok(ws) = read_workspace(project.path.clone()) {
        if let Some(mode) = ws.modes.iter().find(|m| !m.layout.is_empty()) {
            let _ = apply_window_layout(app.clone(), mode.layout.clone());
        }
    }
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

#[derive(Deserialize)]
struct ExportAsset {
    /// Filename to write inside `assets/` (no slashes).
    name: String,
    /// Absolute source path to copy from (must be inside the active project).
    source: String,
}

/// Save a multi-file export bundle (e.g. a web presentation) into the active
/// project's `designs/<folder>/`. Writes `index.html` and copies each asset's
/// source file into `designs/<folder>/assets/<name>`. Returns the folder path.
/// Used by the Slides tool's "Export for web". Source paths are restricted to
/// within the active project so a deck can only bundle its own media.
#[tauri::command]
fn save_export_dir(
    state: tauri::State<AppState>,
    folder: String,
    html: String,
    assets: Vec<ExportAsset>,
) -> Result<String, String> {
    if folder.is_empty() || folder.contains(['/', '\\']) || folder.starts_with('.') {
        return Err("Invalid folder name.".into());
    }
    let project = state
        .active
        .lock()
        .unwrap()
        .clone()
        .ok_or("No active project.")?;
    let dir = PathBuf::from(&project.path).join("designs").join(&folder);
    let assets_dir = dir.join("assets");
    std::fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("index.html"), html).map_err(|e| e.to_string())?;
    for a in &assets {
        if a.name.is_empty() || a.name.contains(['/', '\\']) || a.name.starts_with('.') {
            continue;
        }
        let src = PathBuf::from(&a.source);
        if !src.starts_with(&project.path) {
            continue; // never copy from outside the project tree
        }
        std::fs::copy(&src, assets_dir.join(&a.name)).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string_lossy().to_string())
}

// --- Artifacts (designs/brand-kits/etc. as schema'd files) ----------------
// See docs/artifacts.md. An artifact is a JSON file under <project>/artifacts/
// carrying a `kind`; tools edit them, Claude authors them, the Artifacts panel
// displays them.

#[derive(Serialize)]
struct ArtifactInfo {
    path: String,
    kind: String,
    name: String,
    /// Raw file contents, so the panel can render a preview without a 2nd call.
    content: String,
}

fn collect_artifacts(dir: &Path, out: &mut Vec<ArtifactInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_artifacts(&path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        if kind.is_empty() {
            continue;
        }
        let name = v
            .get("name")
            .and_then(|n| n.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("artifact")
                    .to_string()
            });
        out.push(ArtifactInfo {
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            name,
            content,
        });
    }
}

/// List artifacts under `<project>/artifacts/` (recursively), each a `*.json`
/// file with a `kind` field. Sorted by name.
#[tauri::command]
fn list_artifacts(project_path: String) -> Vec<ArtifactInfo> {
    let root = PathBuf::from(&project_path).join("artifacts");
    let mut out = Vec::new();
    collect_artifacts(&root, &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Read a single artifact file (so a tool can open-on-artifact by path).
#[tauri::command]
fn read_artifact(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Overwrite an artifact at its existing absolute path.
/// Path must be under ~/Projects to prevent writes outside the project tree.
#[tauri::command]
fn overwrite_artifact(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let home = std::env::var("HOME").map_err(|_| "No HOME env var.")?;
    let projects = std::path::Path::new(&home).join("Projects");
    if !p.starts_with(&projects) {
        return Err("Path outside ~/Projects.".into());
    }
    std::fs::write(p, content).map_err(|e| e.to_string())
}

/// Delete an artifact at an absolute path. Path must be under ~/Projects.
#[tauri::command]
fn delete_artifact(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let home = std::env::var("HOME").map_err(|_| "No HOME env var.")?;
    let projects = std::path::Path::new(&home).join("Projects");
    if !p.starts_with(&projects) {
        return Err("Path outside ~/Projects.".into());
    }
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// Save an artifact into the active project's `artifacts/<kind>/<name>.json`.
/// Used by tools (e.g. the Brand Explorer) in place of `save_tool_export` when
/// the output is a schema'd artifact rather than a raw export.
#[tauri::command]
fn save_artifact(
    state: tauri::State<AppState>,
    kind: String,
    name: String,
    content: String,
) -> Result<String, String> {
    if kind.is_empty() || kind.contains(['/', '\\']) || kind.contains("..") {
        return Err("Invalid kind.".into());
    }
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("Invalid name.".into());
    }
    let project = state
        .active
        .lock()
        .unwrap()
        .clone()
        .ok_or("No active project.")?;
    let dir = PathBuf::from(&project.path).join("artifacts").join(&kind);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{name}.json"));
    std::fs::write(&file, content).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().to_string())
}

/// A short stable hash, used to give an artifact-scoped tool window its own label
/// (so opening a different artifact opens/focuses a distinct window).
fn tool_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:x}", h.finish())
}

/// Open a tool window from the frontend, optionally with a query string (e.g.
/// `artifact=<encoded path>`). A non-empty query gets its own window label so
/// different artifacts don't collide on one shared `tool-<stem>` window.
#[tauri::command]
fn open_tool(app: AppHandle, file: String, query: Option<String>) {
    // The Code Editor is opened per-project, not as a shared singleton.
    if Path::new(&file).file_name().and_then(|n| n.to_str()) == Some("code-editor.html") {
        let color = active_git_color_hex(&app).unwrap_or_default();
        open_code_editor_window(&app, &color, &active_project_path(&app), None);
        return;
    }
    let stem: String = Path::new(&file)
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or("tool")
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let q = query.filter(|q| !q.is_empty());
    let label = match &q {
        Some(q) => format!("tool-{stem}-{}", tool_hash(q)),
        None => format!("tool-{stem}"),
    };
    track_tool_window(&label, &file, q.clone(), "plain");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let style = tool_style(&file);
    let color = match style.tint {
        Tint::Project => active_git_color_hex(&app).unwrap_or_default(),
        _ => String::new(),
    };
    // Compose the query: any caller-supplied query plus the resolved color.
    let mut parts: Vec<String> = Vec::new();
    if let Some(q) = &q { parts.push(q.clone()); }
    if !color.is_empty() { parts.push(format!("color={}", url_encode(&color))); }
    let url = if parts.is_empty() {
        format!("tools/{file}")
    } else {
        format!("tools/{file}?{}", parts.join("&"))
    };

    let title = if style.empty_title {
        String::new()
    } else {
        Path::new(&file)
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("Tool")
            .to_string()
    };

    let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .min_inner_size(280.0, 320.0)
        .title(title);
    let _ = apply_tool_chrome(builder, &file, &color).build();
}

// Note: the artifact formats Claude writes to are documented in the
// `studio-artifacts` skill (repo `skills/studio-artifacts/`, symlinked into
// ~/.claude/skills), with JSON Schemas as the source of truth — so the companion
// Claude knows them without a per-project CLAUDE.md block.

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

/// One entry returned by `list_dir`.
#[derive(Clone, Serialize)]
struct DirEntry2 {
    name: String,
    path: String,
    is_dir: bool,
    /// Last-modified time, as Unix epoch seconds (0 if unavailable).
    modified: u64,
}

/// Shallow listing of a folder's immediate children (dotfiles skipped),
/// directories first then alphabetical. Used by the File Directory tool to
/// lazily expand a folder tree without walking the whole filesystem.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry2>, String> {
    let mut entries: Vec<DirEntry2> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| {
            let is_dir = e.path().is_dir();
            let modified = std::fs::metadata(e.path())
                .and_then(|m| m.modified())
                .map(|t| {
                    t.duration_since(std::time::SystemTime::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0)
                })
                .unwrap_or(0);
            DirEntry2 {
                name: e.file_name().to_string_lossy().to_string(),
                path: e.path().to_string_lossy().to_string(),
                is_dir,
                modified,
            }
        })
        .collect();
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

// ── Video edits ─────────────────────────────────────────────────────────────
// A project can hold several edits, one JSON file each under `<project>/videos/`
// (e.g. `videos/tutorial-intro.json`). Each doc is free-form Value (schema owned
// by the frontend + Claude Code) and carries a `name` for display. See
// docs/video-plan.md.

/// The default empty video edit, written when a new edit is created.
fn default_video_doc(name: &str) -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "name": name,
        "preset": "youtube",
        "hdr": "sdr",
        "clips": [],
        "text": [],
    })
}

fn videos_dir(path: &str) -> PathBuf {
    PathBuf::from(path).join("videos")
}

/// Slugify a display name into a filesystem-safe basename (no extension).
fn slugify(name: &str) -> String {
    let mut s: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "untitled".into() } else { s }
}

/// One video edit found in a project.
#[derive(Clone, Serialize)]
struct VideoEdit {
    file: String, // basename, e.g. "tutorial-intro.json"
    name: String, // display name from the doc
    modified: u64,
}

/// List a project's video edits (newest first).
#[tauri::command]
fn list_videos(path: String) -> Vec<VideoEdit> {
    let dir = videos_dir(&path);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(file) = p.file_name().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            let doc: serde_json::Value = std::fs::read_to_string(&p)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();
            let name = doc
                .get("name")
                .and_then(|n| n.as_str())
                .map(String::from)
                .unwrap_or_else(|| file.trim_end_matches(".json").to_string());
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(VideoEdit { file, name, modified });
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

/// Read one edit's JSON (`file` is a basename under `videos/`). Errors if
/// missing — callers list/create first.
#[tauri::command]
fn read_video(path: String, file: String) -> Result<serde_json::Value, String> {
    let p = videos_dir(&path).join(&file);
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Write one edit (pretty-printed). The frontend debounces via
/// scheduleVideoSave(); Claude Code writes the same file directly.
#[tauri::command]
fn write_video(path: String, file: String, doc: serde_json::Value) -> Result<(), String> {
    let dir = videos_dir(&path);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&file), text).map_err(|e| e.to_string())
}

/// Create a new empty edit with a display name, returning its basename.
#[tauri::command]
fn create_video(path: String, name: String) -> Result<String, String> {
    let dir = videos_dir(&path);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = slugify(&name);
    let mut file = format!("{stem}.json");
    let mut n = 1;
    while dir.join(&file).exists() {
        file = format!("{stem}-{n}.json");
        n += 1;
    }
    let text = serde_json::to_string_pretty(&default_video_doc(&name)).unwrap();
    std::fs::write(dir.join(&file), text).map_err(|e| e.to_string())?;
    Ok(file)
}

/// Delete an edit.
#[tauri::command]
fn delete_video(path: String, file: String) -> Result<(), String> {
    std::fs::remove_file(videos_dir(&path).join(&file)).map_err(|e| e.to_string())
}

/// Create a temp directory for the frontend's rendered overlay frames (one
/// export's worth; removed by `export_video` when the export finishes).
#[tauri::command]
fn create_export_frames_dir() -> Result<String, String> {
    let dir = std::env::temp_dir().join(format!(
        "studio-vidframes-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Save one overlay frame (PNG data URL from the export canvas) into a frames
/// dir made by `create_export_frames_dir`. Frames are named f%06d.png; missing
/// indices mean "fully transparent" to the compositor.
#[tauri::command]
fn save_export_frame(dir: String, idx: u32, data: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let dir_path = std::path::PathBuf::from(&dir);
    if !dir_path.starts_with(std::env::temp_dir()) {
        return Err("frames dir must be under the temp dir".into());
    }
    let b64 = data.split(',').nth(1).ok_or("bad data URL")?;
    let bytes = STANDARD.decode(b64).map_err(|e| e.to_string())?;
    std::fs::write(dir_path.join(format!("f{idx:06}.png")), bytes).map_err(|e| e.to_string())
}

/// Render an edit to an MP4 via the native AVFoundation helper. `spec` is the
/// fully-resolved export spec (absolute clip paths, render width/height/fps,
/// and the overlay frames dir rendered by the frontend); `dst` is the chosen
/// output file. Streams `video-export-progress` events (0..1) and returns the
/// output path on done.
#[tauri::command]
fn export_video(app: AppHandle, spec: serde_json::Value, dst: String) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    let mut spec = spec;
    spec["output"] = serde_json::json!(dst);
    let tmp = std::env::temp_dir().join(format!("studio-vidspec-{}.json", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string(&spec).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let mut child = Command::new(env!("VIDEXPORT_BIN"))
        .arg(&tmp)
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let mut done_path = None;
    let mut err = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(p) = line.strip_prefix("PROGRESS ") {
            if let Ok(f) = p.trim().parse::<f64>() {
                let _ = app.emit("video-export-progress", f);
            }
        } else if let Some(p) = line.strip_prefix("DONE ") {
            done_path = Some(p.to_string());
        } else if let Some(e) = line.strip_prefix("ERROR ") {
            err = Some(e.to_string());
        }
    }
    let _ = child.wait();
    let _ = std::fs::remove_file(&tmp);
    // Overlay frames are single-use; clean them up (guard: temp dir only).
    if let Some(frames) = spec.get("framesDir").and_then(|v| v.as_str()) {
        let p = std::path::PathBuf::from(frames);
        if p.starts_with(std::env::temp_dir()) {
            let _ = std::fs::remove_dir_all(&p);
        }
    }

    if let Some(e) = err {
        return Err(e);
    }
    let path = done_path.ok_or("export produced no output")?;
    let _ = Command::new("open").arg("-R").arg(&path).spawn();
    Ok(path)
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
    quicklook_thumb_impl(&app, &path, size)
}

/// Resolve a Workspace "app" entry (e.g. "Finder") to its `.app` bundle's icon
/// (via NSWorkspace), cached as a PNG. Returns the cached PNG path.
#[tauri::command]
fn app_icon(app: AppHandle, name: String) -> Result<String, String> {
    use std::hash::{Hash, Hasher};

    // Resolve the app name to a `.app` bundle path without launching it
    // (AppleScript's `path to application` launches the app as a side effect).
    let app_path = ["/Applications", "/System/Applications", "/System/Applications/Utilities"]
        .iter()
        .map(|dir| format!("{dir}/{name}.app"))
        .find(|p| std::path::Path::new(p).exists())
        .or_else(|| {
            let out = Command::new("mdfind")
                .arg(format!(
                    "kMDItemContentTypeTree == 'com.apple.application-bundle' && kMDItemFSName == '{}.app'",
                    name.replace('\'', "")
                ))
                .output()
                .ok()?;
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(|s| s.to_string())
        })
        .ok_or_else(|| format!("application \"{name}\" not found"))?;

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    app_path.hash(&mut hasher);
    let key = hasher.finish();

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("appicons");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out_path = dir.join(format!("{key:x}.png"));

    if !out_path.exists() {
        let status = Command::new(env!("APPICON_BIN"))
            .arg(&app_path)
            .arg("128")
            .arg(&out_path)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("failed to render app icon".into());
        }
    }
    Ok(out_path.to_string_lossy().to_string())
}

fn quicklook_thumb_impl(app: &AppHandle, path: &str, size: u32) -> Result<String, String> {
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

#[tauri::command]
fn open_in_chrome(url: String) -> Result<(), String> {
    Command::new("open")
        .args(["-a", "Google Chrome", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open a file in this Studio repo's source tree at a given line in Zed.
/// `file` is a path relative to the repo root (e.g. "src/styles.css").
#[tauri::command]
fn open_in_zed(file: String, line: u32) -> Result<(), String> {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("no repo root")?;
    let target = repo_root.join(&file);
    Command::new("/Applications/Zed.app/Contents/MacOS/cli")
        .arg(format!("{}:{}", target.display(), line))
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

/// Run a workspace "Script" card: spawn the file directly (not via `open`,
/// which would launch a `.sh` in its default text editor instead of running
/// it) with its own directory as cwd, so relative paths inside the script
/// resolve the way they would from a terminal in that folder.
#[tauri::command]
fn run_script(path: String) -> Result<(), String> {
    let path = path.trim();
    let script = if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var("HOME").map_err(|_| "No HOME env var.")?;
        format!("{home}/{rest}")
    } else {
        path.to_string()
    };
    let dir = Path::new(&script).parent().ok_or("no parent dir")?;
    Command::new(&script)
        .current_dir(dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
struct RepoScripts {
    start: Option<String>,
    stop: Option<String>,
}

/// Convention-based Start/Stop for the repo card: if `dev-open.sh` /
/// `dev-stop.sh` exist at the repo root, the card surfaces matching buttons
/// without any per-project Studio config — drop the script in, the button
/// appears.
#[tauri::command]
fn repo_scripts(repo: String) -> RepoScripts {
    let root = Path::new(repo.trim());
    let check = |name: &str| -> Option<String> {
        let p = root.join(name);
        p.is_file().then(|| p.to_string_lossy().to_string())
    };
    RepoScripts {
        start: check("dev-open.sh"),
        stop: check("dev-stop.sh"),
    }
}

const WINBOUNDS_BIN: &str = env!("WINBOUNDS_BIN");
const DAYAGENDA_BIN: &str = env!("DAYAGENDA_BIN");
const CALREAD_BIN: &str = env!("CALREAD_BIN");
const TRANSIT_BIN: &str = env!("TRANSIT_BIN");

/// Today's calendar events as a JSON array string:
/// `[{"time":"10:00 AM–10:30 AM","title":"…","location":"…"}]` (EventKit, via the
/// `dayagenda` Swift helper). Returns `"[]"` if calendar access is denied or
/// there are no events; the calendar-access prompt (attributed to Studio) is
/// shown by macOS on first call. Used by the Daily Briefing tool.
#[tauri::command]
async fn day_agenda() -> Result<String, String> {
    let out = Command::new(DAYAGENDA_BIN)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Next 7 days of calendar events as a rich JSON array string (EventKit, via the
/// `calread` Swift helper) — `[{"id","title","start","end","allDay","location",
/// "notes","url"}]`. Returns `"[]"` if calendar access is denied or there are no
/// events. Drives the Tasks subsystem (see docs/tasks.md).
#[tauri::command]
async fn cal_read() -> Result<String, String> {
    let out = Command::new(CALREAD_BIN)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ---- Tasks store (app config dir / tasks/<id>.json) ------------------------
// Global, not project-bound — a directory of per-Task JSON files so Claude can
// author/edit one Task without racing Studio's writes. See docs/tasks.md.

/// Directory holding per-Task JSON files.
fn tasks_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("tasks"))
}

/// Reject ids that aren't a plain slug, so a Task id can't escape tasks_dir.
fn safe_task_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid task id".into());
    }
    Ok(())
}

/// All Tasks as a JSON array string (each file's contents, parsed). Skips files
/// that don't parse. Returns "[]" if the dir is missing.
#[tauri::command]
fn list_tasks(app: AppHandle) -> Result<String, String> {
    let dir = tasks_dir(&app).ok_or("no app config dir")?;
    let mut items: Vec<serde_json::Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                    items.push(val);
                }
            }
        }
    }
    serde_json::to_string(&items).map_err(|e| e.to_string())
}

/// Write one Task file (pretty-printed). `id` names the file; `data` is its JSON.
#[tauri::command]
fn save_task(app: AppHandle, id: String, data: String) -> Result<(), String> {
    safe_task_id(&id)?;
    let dir = tasks_dir(&app).ok_or("no app config dir")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Re-serialize so we both validate the JSON and store it pretty.
    let val: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&val).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{id}.json")), text).map_err(|e| e.to_string())
}

/// Delete one Task file. Missing file is not an error (idempotent).
#[tauri::command]
fn delete_task(app: AppHandle, id: String) -> Result<(), String> {
    safe_task_id(&id)?;
    let dir = tasks_dir(&app).ok_or("no app config dir")?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Travel time (minutes) between two addresses for in-person Tasks, via the
/// `transit` Swift helper (CLGeocoder + MKDirections). Returns its JSON —
/// `{"minutes":N,"mode":"driving"}` or `{"error":"…"}`. `mode` is
/// "driving" (default) or "walking".
#[tauri::command]
async fn transit_eta(from: String, to: String, mode: Option<String>) -> Result<String, String> {
    let out = Command::new(TRANSIT_BIN)
        .arg(&from)
        .arg(&to)
        .arg(mode.unwrap_or_else(|| "driving".into()))
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Tasks settings (origin address, travel mode, buffer) for transit estimates —
/// app config dir / tasks-config.json. Returns "{}" if unset.
#[tauri::command]
fn read_tasks_config(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(std::fs::read_to_string(dir.join("tasks-config.json")).unwrap_or_else(|_| "{}".into()))
}

#[tauri::command]
fn save_tasks_config(app: AppHandle, data: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("tasks-config.json"), data).map_err(|e| e.to_string())
}

/// Return the frontmost non-utility window's info as "app,title,x,y,w,h".
/// Calls the compiled winbounds Swift helper which uses CGWindowListCopyWindowInfo
/// for compositor Z-order — reliable across mixed NSWindowLevel windows.
#[tauri::command]
fn get_focused_window_bounds() -> Result<String, String> {
    let out = Command::new(WINBOUNDS_BIN)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

const WINLAYOUT_BIN: &str = env!("WINLAYOUT_BIN");

/// Sentinel `app` value marking a `WindowSnapshot` as one of Studio's own
/// windows, handled natively via Tauri (not the AX helper — see below).
const STUDIO_APP: &str = "Studio";

/// Studio's own visible windows, identified by Tauri window label (more
/// reliable than matching process names across APIs — see
/// `apply_window_layout`'s doc comment for why that broke).
fn studio_window_snapshots(app: &AppHandle) -> Vec<WindowSnapshot> {
    let git_windows = read_git_windows(app);
    let tool_windows = tool_windows_store().lock().unwrap().clone();
    app.webview_windows()
        .into_iter()
        .filter(|(_, win)| win.is_visible().unwrap_or(false))
        // Global-shortcut overlays (Spotlight, Mode switcher) are transient
        // launchers, never part of a saved layout — don't record them.
        .filter(|(label, _)| label != "spotlight" && label != "mode-switcher")
        .filter_map(|(label, win)| {
            let pos = win.outer_position().ok()?;
            // inner_size, not outer_size: apply_window_layout restores via
            // set_size(), which sets the inner (content) size — pairing it
            // with outer_size would re-add the title bar height on restore.
            let size = win.inner_size().ok()?;
            let git = git_windows.iter().find(|w| git_label(&w.repo) == label);
            let tool = tool_windows.get(&label);
            Some(WindowSnapshot {
                app: STUDIO_APP.to_string(),
                title: label,
                x: pos.x,
                y: pos.y,
                w: size.width as i32,
                h: size.height as i32,
                repo: git.map(|w| w.repo.clone()),
                color: git.map(|w| w.color.clone()),
                editor: git.map(|w| w.editor.clone()),
                tool_file: tool.map(|(file, _, _)| file.clone()),
                tool_query: tool.and_then(|(_, query, _)| query.clone()),
                tool_kind: tool.map(|(_, _, kind)| kind.clone()),
            })
        })
        .collect()
}

/// List every on-screen window (any app), for recording a Workspace mode.
/// Studio's own windows come from Tauri directly; everything else from the
/// winlayout helper (Accessibility-API based, for other processes).
#[tauri::command]
fn list_windows(app: AppHandle) -> Result<Vec<WindowSnapshot>, String> {
    let out = Command::new(WINLAYOUT_BIN)
        .arg("list")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut snapshots: Vec<WindowSnapshot> =
        serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    snapshots.extend(studio_window_snapshots(&app));
    Ok(snapshots)
}

/// Restore a saved window layout: move/resize/un-minimize each window in
/// `layout`, then minimize every other on-screen window not in it.
///
/// Studio's own windows are restored directly through Tauri, not handed to
/// the winlayout helper — matching them by process name across CGWindowList
/// and the Accessibility API is unreliable for Studio's own (unbundled, dev-
/// mode) process, which previously made Play think Studio wasn't running and
/// launch a duplicate instance. Every other app still goes through winlayout
/// (Accessibility API), which needs the user to grant Studio Accessibility
/// permission once; until granted, its AX calls are silent no-ops.
#[tauri::command]
fn apply_window_layout(app: AppHandle, layout: Vec<WindowSnapshot>) -> Result<(), String> {
    use std::io::Write;

    let (studio_targets, other_targets): (Vec<_>, Vec<_>) =
        layout.into_iter().partition(|w| w.app == STUDIO_APP);

    let mut matched_labels: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (label, win) in app.webview_windows() {
        if let Some(target) = studio_targets.iter().find(|t| t.title == label) {
            matched_labels.insert(label);
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_position(tauri::PhysicalPosition::new(target.x, target.y));
            let _ = win.set_size(tauri::PhysicalSize::new(
                target.w.max(0) as u32,
                target.h.max(0) as u32,
            ));
        } else {
            // hide(), not minimize(): instant (no genie animation) and the
            // same "hide, don't quit" semantics the close button already
            // uses elsewhere — Play's un-hiding via show() above works the
            // same either way.
            let _ = win.hide();
        }
    }

    // Targets that weren't found among currently open windows are either
    // closed (Git windows — closing one wipes its git-windows.json entry, see
    // remove_git_window, so the live store can't be relied on) or simply
    // never opened this session (tool windows are built lazily on first open;
    // on a fresh launch, before the user has opened one, it doesn't exist
    // yet). Both are rebuilt from data captured into the snapshot itself at
    // record time. Other Studio windows (main, etc.) are always open, so
    // there's nothing more to do for them.
    for target in studio_targets.iter().filter(|t| !matched_labels.contains(&t.title)) {
        if let Some(repo) = &target.repo {
            let win = GitWindow {
                repo: repo.clone(),
                color: target.color.clone().unwrap_or_default(),
                editor: target.editor.clone().unwrap_or_default(),
                ..Default::default()
            };
            upsert_git_window(&app, &win);
            build_git_window(&app, &win);
        } else if let Some(file) = &target.tool_file {
            // Each kind must go through the exact function that produced the
            // original label, since several tool windows use a label scheme
            // that the generic open_tool can't reproduce — otherwise the
            // position/size lookup by `target.title` below silently misses.
            match target.tool_kind.as_deref() {
                Some("color") => {
                    open_tool_window_with_color(&app, file, target.tool_query.as_deref().unwrap_or(""))
                }
                Some("code-editor") => {
                    let proj = target.tool_query.clone().unwrap_or_default();
                    let color = if proj.is_empty() {
                        active_git_color_hex(&app).unwrap_or_default()
                    } else {
                        git_color_for_path(app.clone(), proj.clone())
                    };
                    open_code_editor_window(&app, &color, &proj, None);
                }
                Some("git-pulse") => {
                    let Some(repo) = &target.tool_query else { continue };
                    open_git_pulse(app.clone(), repo.clone());
                }
                Some("schedules") => {
                    let _ = open_schedules_window(app.clone());
                }
                Some("video") => {
                    let Some(path) = &target.tool_query else { continue };
                    let _ = open_video_window(app.clone(), path.clone(), None);
                }
                Some("claude") => {
                    let _ = open_claude_window(app.clone(), None, target.tool_query.clone());
                }
                _ => open_tool(app.clone(), file.clone(), target.tool_query.clone()),
            }
        } else {
            continue;
        }
        if let Some(win) = app.get_webview_window(&target.title) {
            let _ = win.set_position(tauri::PhysicalPosition::new(target.x, target.y));
            let _ = win.set_size(tauri::PhysicalSize::new(
                target.w.max(0) as u32,
                target.h.max(0) as u32,
            ));
        }
    }

    let mut child = Command::new(WINLAYOUT_BIN)
        .arg("apply")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let payload = serde_json::to_vec(&other_targets).map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(&payload)
        .map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("winlayout apply failed".to_string())
    }
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

/// Copy a video file into a project's `media/` folder (keeping the original),
/// de-duplicating the name. Used by the Video window's "Browse…" → Add clip so
/// imported clips live under ~/Projects (and so stay within the asset-protocol
/// scope for preview). Returns the new absolute path.
#[tauri::command]
fn import_clip(project_path: String, file: String) -> Result<String, String> {
    let src = PathBuf::from(&file);
    let is_video = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false);
    if !is_video {
        return Err("Not a video file.".into());
    }
    let media_dir = PathBuf::from(&project_path).join("media");
    std::fs::create_dir_all(&media_dir).map_err(|e| e.to_string())?;
    let dest = unique_dest(&media_dir, &src).ok_or("Bad file name.")?;
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
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

/// Read the Daily Notes store (app config dir / daily-notes.json).
#[tauri::command]
fn read_daily_notes(app: AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    match std::fs::read_to_string(dir.join("daily-notes.json")) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::json!({})),
    }
}

/// Write the Daily Notes store (app config dir / daily-notes.json, pretty-printed).
#[tauri::command]
fn save_daily_notes(app: AppHandle, store: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("daily-notes.json"), text).map_err(|e| e.to_string())
}

/// Read the Mycelium store (app config dir / mycelium.json) — the local social
/// graph (trees, people, your card). Same global-store pattern as Daily Notes.
#[tauri::command]
fn read_mycelium(app: AppHandle) -> Result<serde_json::Value, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    match std::fs::read_to_string(dir.join("mycelium.json")) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::json!({ "version": 1, "trees": [], "people": [] })),
    }
}

/// Write the Mycelium store (app config dir / mycelium.json, pretty-printed).
#[tauri::command]
fn save_mycelium(app: AppHandle, store: serde_json::Value) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("mycelium.json"), text).map_err(|e| e.to_string())
}

const CONTACTSDUMP_BIN: &str = env!("CONTACTSDUMP_BIN");

/// Mac Contacts export as a JSON array string — `[{"name","emails":[],
/// "phones":[]}]` (Contacts framework, via the `contactsdump` Swift helper).
/// Returns `"[]"` if Contacts access is denied. Used by Mycelium's "match
/// Mac Contacts" feature to fill in email/phone for people already in your
/// graph.
#[tauri::command]
async fn contacts_dump() -> Result<String, String> {
    let out = Command::new(CONTACTSDUMP_BIN)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
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

// --- Git companion windows ---------------------------------------------
//
// Small bright-colored windows, one per repo, showing branch + changed files +
// a commit box. Because `tauri dev` rebuilds restart Studio (killing its
// windows), the set of open Git windows is persisted to `git-windows.json` and
// reopened on startup, with each window's unsent commit-message `draft` saved
// too so it survives the rebuild blink.

/// One persisted Git window: which repo, its bright color + editor (copied from
/// the project's workspace so the window is self-contained), and the unsent
/// commit-message draft.
#[derive(Clone, Serialize, Deserialize, Default)]
struct GitWindow {
    repo: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    editor: String,
    #[serde(default)]
    draft: String,
    /// Last known window geometry (physical pixels), saved during the session so
    /// it survives a `tauri dev` rebuild — which SIGKILLs the process before the
    /// window-state plugin can flush on exit. `None` until the window first
    /// moves/resizes or loses focus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    w: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    h: Option<u32>,
}

/// Stable window label for a repo path (so reopening the same repo focuses the
/// existing window instead of duplicating it).
fn git_label(repo: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    repo.hash(&mut h);
    format!("git-{:x}", h.finish())
}

fn git_windows_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("git-windows.json"))
}

fn read_git_windows(app: &AppHandle) -> Vec<GitWindow> {
    git_windows_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_git_windows(app: &AppHandle, list: &[GitWindow]) {
    if let Some(path) = git_windows_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(list) {
            let _ = std::fs::write(path, text);
        }
    }
}

/// Insert or update a repo's entry in the store, preserving its existing draft.
fn upsert_git_window(app: &AppHandle, win: &GitWindow) {
    let mut list = read_git_windows(app);
    if let Some(existing) = list.iter_mut().find(|w| w.repo == win.repo) {
        existing.color = win.color.clone();
        existing.editor = win.editor.clone();
    } else {
        list.push(win.clone());
    }
    write_git_windows(app, &list);
}

fn remove_git_window(app: &AppHandle, repo: &str) {
    let mut list = read_git_windows(app);
    list.retain(|w| w.repo != repo);
    write_git_windows(app, &list);
}

/// Persist a Git window's current geometry (physical px) to the store, so it
/// reopens in place after a rebuild. Called from window move/resize/blur events.
/// No-op if the window or its store entry is gone.
fn save_git_geometry(app: &AppHandle, label: &str) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let pos = win.outer_position().ok();
    let size = win.inner_size().ok();
    let mut list = read_git_windows(app);
    let Some(entry) = list.iter_mut().find(|w| git_label(&w.repo) == label) else {
        return;
    };
    let mut changed = false;
    if let Some(p) = pos {
        if entry.x != Some(p.x) || entry.y != Some(p.y) {
            entry.x = Some(p.x);
            entry.y = Some(p.y);
            changed = true;
        }
    }
    if let Some(s) = size {
        if entry.w != Some(s.width) || entry.h != Some(s.height) {
            entry.w = Some(s.width);
            entry.h = Some(s.height);
            changed = true;
        }
    }
    if changed {
        write_git_windows(app, &list);
    }
}

/// Parse "#rrggbb" to (r, g, b); falls back to a bright amber on bad input.
fn parse_hex(hex: &str) -> (u8, u8, u8) {
    let h = hex.trim().trim_start_matches('#');
    if h.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&h[0..2], 16),
            u8::from_str_radix(&h[2..4], 16),
            u8::from_str_radix(&h[4..6], 16),
        ) {
            return (r, g, b);
        }
    }
    (0xff, 0xd2, 0x3f)
}

/// Build (or focus) a Git window for a stored entry. Runs on the main thread —
/// `WebviewWindowBuilder::build()` must, on macOS.
fn build_git_window(app: &AppHandle, win: &GitWindow) {
    let label = git_label(&win.repo);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let color = if win.color.is_empty() {
        "#ffd23f".to_string()
    } else {
        win.color.clone()
    };
    let (r, g, b) = parse_hex(&color);
    let url = format!(
        "git/index.html?repo={}&color={}",
        url_encode(&win.repo),
        url_encode(&color),
    );
    // Empty native title — the project name + branch show in the page's own
    // title strip instead (like the Daily Notes window).
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("")
        .inner_size(400.0, 400.0)
        .min_inner_size(300.0, 280.0)
        .title_bar_style(tauri::TitleBarStyle::Transparent)
        .background_color(tauri::webview::Color(r, g, b, 0xff))
        .build();
    // Restore saved geometry from our own store. We can't use the window-state
    // plugin here: a `tauri dev` rebuild SIGKILLs the process, so the plugin
    // never flushes on exit. We instead save geometry live (see
    // `save_git_geometry`) and re-apply it after building.
    if let Ok(w) = built {
        if let (Some(x), Some(y)) = (win.x, win.y) {
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
        if let (Some(width), Some(height)) = (win.w, win.h) {
            let _ = w.set_size(tauri::PhysicalSize::new(width, height));
        }
    }
}

/// Open (or focus) a Git window for a repo, persisting it so it reopens after a
/// Studio rebuild. `color`/`editor` come from the project's workspace.
#[tauri::command]
fn open_git_window(
    app: AppHandle,
    repo: String,
    color: String,
    editor: String,
) -> Result<(), String> {
    let win = GitWindow {
        repo: repo.clone(),
        color,
        editor,
        ..Default::default()
    };
    upsert_git_window(&app, &win);
    // Build from the merged store entry so a previously-saved position/size (and
    // draft) is honored, not the fresh values just passed in.
    let merged = read_git_windows(&app)
        .into_iter()
        .find(|w| w.repo == repo)
        .unwrap_or(win);
    build_git_window(&app, &merged);
    Ok(())
}

#[tauri::command]
fn open_git_pulse(app: AppHandle, repo: String) {
    // Unique label per repo so each repo gets its own pulse window.
    let slug: String = repo
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let label = format!("tool-git-pulse-{}", &slug[slug.len().saturating_sub(40)..]);
    track_tool_window(&label, "git-pulse.html", Some(repo.clone()), "git-pulse");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let url = format!("tools/git-pulse.html?repo={}", url_encode(&repo));
    if let Ok(win) = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title("")
        .inner_size(820.0, 600.0)
        .title_bar_style(tauri::TitleBarStyle::Transparent)
        .background_color(tauri::webview::Color(0xf7, 0xf5, 0xf0, 0xff))
        .build()
    {
        let _ = win.show();
    }
}

#[tauri::command]
fn git_get_draft(app: AppHandle, repo: String) -> String {
    read_git_windows(&app)
        .into_iter()
        .find(|w| w.repo == repo)
        .map(|w| w.draft)
        .unwrap_or_default()
}

#[tauri::command]
fn git_set_draft(app: AppHandle, repo: String, draft: String) {
    let mut list = read_git_windows(&app);
    if let Some(w) = list.iter_mut().find(|w| w.repo == repo) {
        w.draft = draft;
        write_git_windows(&app, &list);
    }
}

/// One changed file in `git status`: the two-char XY code and its path.
#[derive(Serialize)]
struct GitFile {
    status: String,
    path: String,
}

#[derive(Serialize)]
struct GitCommit {
    hash: String,
    subject: String,
    rel: String,
}

#[derive(Serialize)]
struct GitStatus {
    branch: String,
    files: Vec<GitFile>,
    #[serde(rename = "lastCommit")]
    last_commit: Option<GitCommit>,
}

/// Read branch, changed files, and the last commit for a repo.
#[tauri::command]
fn git_status(repo: String) -> Result<GitStatus, String> {
    let out = Command::new("git")
        .args(["-C", &repo, "status", "--porcelain=v1", "-b"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut branch = String::new();
    let mut files = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // e.g. "main...origin/main [ahead 1]" or "main" or "No commits yet on main"
            branch = rest
                .split("...")
                .next()
                .unwrap_or(rest)
                .split(" [")
                .next()
                .unwrap_or(rest)
                .trim()
                .to_string();
        } else if line.len() > 3 {
            let status = line[..2].to_string();
            // Renames show "old -> new"; keep the new path.
            let path = line[3..]
                .rsplit(" -> ")
                .next()
                .unwrap_or(&line[3..])
                .trim()
                .to_string();
            files.push(GitFile { status, path });
        }
    }

    let log = Command::new("git")
        .args(["-C", &repo, "log", "-1", "--format=%h%x1f%s%x1f%cr"])
        .output()
        .map_err(|e| e.to_string())?;
    let last_commit = if log.status.success() {
        let l = String::from_utf8_lossy(&log.stdout);
        let mut parts = l.trim().split('\u{1f}');
        match (parts.next(), parts.next(), parts.next()) {
            (Some(h), Some(s), Some(r)) if !h.is_empty() => Some(GitCommit {
                hash: h.to_string(),
                subject: s.to_string(),
                rel: r.to_string(),
            }),
            _ => None,
        }
    } else {
        None
    };

    Ok(GitStatus {
        branch,
        files,
        last_commit,
    })
}

/// List the files changed in a single commit (status + path), for expanding the
/// previous-commit row in the Git window.
#[tauri::command]
fn git_commit_files(repo: String, hash: String) -> Result<Vec<GitFile>, String> {
    let out = Command::new("git")
        .args(["-C", &repo, "show", "--name-status", "--format=", &hash])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut files = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        // "M\tpath", "A\tpath", or "R100\told\tnew" (keep the new path).
        let mut parts = line.split('\t');
        let Some(code) = parts.next() else { continue };
        let path = parts.last().unwrap_or("").trim();
        if path.is_empty() {
            continue;
        }
        files.push(GitFile {
            status: code.chars().take(1).collect(),
            path: path.to_string(),
        });
    }
    Ok(files)
}

/// Open a native file picker and return the chosen path (or None if cancelled).
/// Used by the Code Editor tool to load an arbitrary file to edit.
#[tauri::command]
async fn pick_text_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .add_filter(
            "Web / text",
            &["html", "htm", "css", "js", "mjs", "json", "svg", "md", "txt"],
        )
        .pick_file(move |picked| {
            let _ = tx.try_send(picked);
        });
    let picked = rx.recv().await.ok_or("dialog closed")?;
    match picked {
        Some(fp) => Ok(Some(
            fp.into_path()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string(),
        )),
        None => Ok(None),
    }
}

/// Open the Code Editor's companion preview window (a separate tool window that
/// renders the HTML the editor pushes to it over Tauri events).
#[tauri::command]
fn open_code_preview(app: AppHandle, color: Option<String>) {
    match color.filter(|c| !c.is_empty()) {
        Some(c) => open_tool_window_with_color(&app, "tools/code-preview.html", &c),
        None => open_tool_window(&app, "tools/code-preview.html"),
    }
}

/// The active project's Git-window color (hex), used to tint the Code Editor /
/// Preview title bars. Defaults to the Git window's own default bright when a
/// project is active but unset; `None` when no project is active.
fn active_git_color_hex(app: &AppHandle) -> Option<String> {
    let project = app.state::<AppState>().active.lock().unwrap().clone()?;
    let ws = read_workspace(project.path).ok()?;
    // Prefer the project accent color; fall back to the legacy per-repo
    // gitColor, then a default bright.
    let c = ws.color.trim().to_string();
    let c = if c.is_empty() { ws.git_color.trim().to_string() } else { c };
    Some(if c.is_empty() { "#ffd23f".to_string() } else { c })
}

/// Exposed to the Code Editor / Preview windows so they can tint their in-page
/// title strip to match. Empty string when no project is active.
#[tauri::command]
fn active_git_color(app: AppHandle) -> String {
    active_git_color_hex(&app).unwrap_or_default()
}

/// The Git-window color for whichever known repo contains `path` (longest repo
/// match wins), independent of which project is active in the main window. Empty
/// string if the file isn't under any repo that has a Git window. Used by the
/// Code Editor to tint its title bar based on the open file.
#[tauri::command]
fn git_color_for_path(app: AppHandle, path: String) -> String {
    let home = app.path().home_dir().ok();
    let target = PathBuf::from(&path);
    let mut best: Option<(usize, String)> = None;
    for w in read_git_windows(&app) {
        // Expand a leading "~" so repos stored as "~/Projects/x" still match.
        let repo = match (&home, w.repo.strip_prefix("~/")) {
            (Some(h), Some(rest)) => h.join(rest),
            _ => PathBuf::from(&w.repo),
        };
        if target.starts_with(&repo) {
            let len = repo.as_os_str().len();
            if best.as_ref().map_or(true, |(l, _)| len > *l) {
                let c = if w.color.trim().is_empty() { "#ffd23f".to_string() } else { w.color.clone() };
                best = Some((len, c));
            }
        }
    }
    best.map(|(_, c)| c).unwrap_or_default()
}

/// Read a UTF-8 text file by absolute path. Used by the Code Editor tool.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write a UTF-8 text file by absolute path. Used by the Code Editor tool.
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Unified `git diff` for a single file against HEAD, deriving the repo from the
/// file's own directory (the file may live outside any Studio project). Returns
/// the raw diff text; errors (not a repo, etc.) are surfaced so the editor can
/// fall back to showing no diff. Used by the Code Editor tool.
#[tauri::command]
fn git_diff_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let dir = p.parent().ok_or("file has no parent directory")?;
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["diff", "--no-color", "HEAD", "--"])
        .arg(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Unified `git diff` for what the *last commit* changed in a file
/// (`HEAD~1..HEAD`), as opposed to uncommitted working-tree changes. Repo is
/// derived from the file's own directory. Used by the Code Editor's "Last
/// commit" diff mode.
#[tauri::command]
fn git_diff_file_committed(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let dir = p.parent().ok_or("file has no parent directory")?;
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["diff", "--no-color", "HEAD~1", "HEAD", "--"])
        .arg(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Stage everything and commit. Returns an error string on failure (e.g.
/// nothing to commit), which the window surfaces.
#[tauri::command]
fn git_commit(app: AppHandle, repo: String, message: String) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Empty commit message".to_string());
    }
    let add = Command::new("git")
        .args(["-C", &repo, "add", "-A"])
        .output()
        .map_err(|e| e.to_string())?;
    if !add.status.success() {
        return Err(String::from_utf8_lossy(&add.stderr).trim().to_string());
    }
    let out = Command::new("git")
        .args(["-C", &repo, "commit", "-m", &message])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err.trim().to_string()
        };
        return Err(msg);
    }
    // Committed — clear the saved draft.
    git_set_draft(app, repo, String::new());
    Ok(())
}

/// Un-commit the last commit, keeping its changes staged (soft reset).
#[tauri::command]
fn git_undo(repo: String) -> Result<(), String> {
    let out = Command::new("git")
        .args(["-C", &repo, "reset", "--soft", "HEAD~1"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// The sentinel `editor` value meaning "open in Studio's built-in Code Editor
/// tool" instead of an external macOS app.
const STUDIO_EDITOR: &str = "Studio Code Editor";

/// Open one changed file in the project's configured editor (blank = Zed,
/// `STUDIO_EDITOR` = the in-app Code Editor tool).
#[tauri::command]
fn git_log_week(repo: String) -> Result<String, String> {
    let out = Command::new("git")
        .args([
            "-C", &repo,
            "log",
            "--all",
            "--since=7 days ago",
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1f%ai",
            "--date=format:%a %b %d %H:%M",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn git_open_file(
    app: AppHandle,
    state: tauri::State<AppState>,
    repo: String,
    file: String,
) -> Result<(), String> {
    let editor = read_git_windows(&app)
        .into_iter()
        .find(|w| w.repo == repo)
        .map(|w| w.editor)
        .unwrap_or_default();
    let full = Path::new(&repo).join(&file);

    if editor == STUDIO_EDITOR {
        return open_in_code_editor(&app, &state, full.to_string_lossy().to_string());
    }

    let editor = if editor.is_empty() { "Zed" } else { &editor };
    Command::new("open")
        .arg("-a")
        .arg(editor)
        .arg(full)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open the Code Editor tool window and have it load `file`. For a fresh window
/// the path is stashed in `pending_open` (keyed by window label) for the page to
/// pull on launch; for an already-open window it's sent as a label-stamped
/// `ce:open-file` event.
fn open_in_code_editor(
    app: &AppHandle,
    _state: &tauri::State<AppState>,
    file: String,
) -> Result<(), String> {
    let color = git_color_for_path(app.clone(), file.clone());
    // Scope to the project that owns the file (not the active project), so a
    // file from Yuniku always opens in Yuniku's editor even while Studio is
    // active. open_code_editor_window handles the pending/event load itself.
    let proj = project_path_for_file(app, &file).unwrap_or_else(|| active_project_path(app));
    open_code_editor_window(app, &color, &proj, Some(file));
    Ok(())
}

/// The Code Editor tool calls this on launch (passing its own window label) to
/// pick up a file it was asked to open (see `open_in_code_editor`). Removes the
/// entry so a later reload of the same window restores the session instead.
#[tauri::command]
fn take_pending_open(state: tauri::State<AppState>, label: String) -> Option<String> {
    state.pending_open.lock().unwrap().remove(&label)
}

/// Open an arbitrary file in the Code Editor tool window — the generic entry
/// point `git_open_file` wraps for repo files (e.g. used by the File
/// Directory tool for non-artifact files outside a git repo's editor pref).
#[tauri::command]
fn open_file_in_code_editor(
    app: AppHandle,
    state: tauri::State<AppState>,
    file: String,
) -> Result<(), String> {
    open_in_code_editor(&app, &state, file)
}

// --- Claude companion window -------------------------------------------

/// The directory Claude runs in for a project, by mode (the chat's cwd dropdown):
/// - `"repo"` → the workspace's resolved `repo` path (for code work), falling
///   back to the project folder if no repo is set.
/// - anything else (`"project"`, default) → the **project folder**, where media,
///   notes, and `artifacts/` live — so design artifacts land where the Artifacts
///   panel reads them.
/// (Matches the standalone companion's `claude_cwd`.)
fn claude_cwd(app: &AppHandle, project_path: &str, mode: &str) -> PathBuf {
    let project_dir = PathBuf::from(project_path);
    if mode != "repo" {
        return project_dir;
    }
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

/// Start the background loop that fires due `Workspace::schedules` entries.
/// Checks every 30s; a task fires when its `time` matches the current
/// HH:MM, today's weekday is in `days` (or `days` is empty), and it hasn't
/// already run today.
/// Keep the "ram-tray" menu-bar label ("X.X GB") current.
fn start_ram_label_refresh(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        if let Some(tray) = app.tray_by_id("ram-tray") {
            let title = match get_memory_stats() {
                Ok(stats) => format!("{:.1} GB", stats.system_used_gb),
                Err(_) => "RAM".to_string(),
            };
            let _ = tray.set_title(Some(title));
        }
        std::thread::sleep(std::time::Duration::from_secs(5));
    });
}

fn start_scheduler(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        run_due_schedules(&app);
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}

/// Background watcher for Tasks (docs/tasks.md): every 30s, pop a notification
/// card for any Task whose lead time has arrived. Independent of the Tasks tool
/// being open. Mirrors `start_scheduler`.
fn start_task_watcher(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        fire_due_tasks(&app);
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
}

/// Scan Task files; for each whose notification time has arrived — and which
/// hasn't already fired (respecting an active snooze) — pop an always-on-top
/// card and stamp `firedAt` so it fires exactly once. Cards linger until the
/// user acts; we don't auto-dismiss. A stale cutoff (meeting end, or start+15m)
/// avoids popping cards long after a meeting began (e.g. on app launch).
fn fire_due_tasks(app: &AppHandle) {
    use chrono::Utc;
    let dir = match tasks_dir(app) {
        Some(d) => d,
        None => return,
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let now = Utc::now();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let mut task: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let id = task
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }

        let Some(start) = task
            .get("start")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
        else {
            continue;
        };
        let lead = task
            .get("notify")
            .and_then(|n| n.get("leadMinutes"))
            .and_then(|v| v.as_i64())
            .unwrap_or(2);
        let fire_at = start - chrono::Duration::minutes(lead);
        let cutoff = task
            .get("end")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or(start + chrono::Duration::minutes(15));

        // Snooze overrides "already fired": while snoozing, skip; once the
        // snooze elapses, fire again regardless of firedAt.
        if let Some(snooze) = task
            .get("snoozeUntil")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
        {
            if now < snooze {
                continue;
            }
        } else if task.get("firedAt").is_some() {
            continue; // fired once, no re-nag
        }

        if now < fire_at || now > cutoff {
            continue;
        }

        // Fire: pop the card (on the main thread — this is a worker thread) and
        // record that we did, clearing any elapsed snooze.
        let app2 = app.clone();
        let id2 = id.clone();
        let _ = app.run_on_main_thread(move || open_task_notification_window(&app2, &id2));
        task["firedAt"] = serde_json::json!(now.to_rfc3339());
        if let Some(obj) = task.as_object_mut() {
            obj.remove("snoozeUntil");
        }
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&task).unwrap_or(text));
    }
}

/// Build (or focus) a Task notification card — a small, undecorated,
/// always-on-top window at the top-right of the primary monitor. Labeled
/// `tool-task-notify-<id>` so it inherits the `tool-*` capability (invoke +
/// window controls). Must be called on the main thread.
fn open_task_notification_window(app: &AppHandle, id: &str) {
    let label = format!("tool-task-notify-{id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let url = format!("tools/task-notify.html?id={id}");
    if let Ok(win) = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .inner_size(340.0, 150.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()
    {
        if let Ok(Some(mon)) = win.primary_monitor() {
            let sz = mon.size();
            let ws = win.outer_size().unwrap_or_default();
            let margin = 16i32;
            let x = (sz.width as i32 - ws.width as i32 - margin).max(0);
            let y = 16 + margin; // clear of the menu bar
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
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
        if !task.tool.trim().is_empty() {
            // "Open a tool at a time" mode: pop the tool's window (the tool
            // does its own work, e.g. Daily Briefing generates on load).
            // Window creation must run on the main thread — this fires from the
            // scheduler's worker thread.
            let app2 = app.clone();
            let tool = task.tool.clone();
            let _ = app.run_on_main_thread(move || open_tool(app2.clone(), tool, None));
        } else {
            run_scheduled_task(
                app,
                task.project_path.clone(),
                task.prompt.clone(),
                task.model.clone(),
                task.output_file.clone(),
                task.id.clone(),
            );
        }
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

/// Run `claude -p <prompt>` headless in `cwd` and capture `(success, output)`,
/// where `output` is stdout on success or stderr/error on failure. Shared by
/// the scheduler (writes the text to a file) and `run_claude_prompt` (returns
/// it straight to a caller, e.g. a tool generating content live).
fn claude_capture(cwd: &Path, prompt: &str, model: &str) -> (bool, String) {
    let mut cmd = Command::new("claude");
    cmd.env("PATH", claude_path())
        .current_dir(cwd)
        .arg("-p")
        // Headless: nobody is around to approve tool-use prompts.
        .arg("--permission-mode")
        .arg("bypassPermissions");
    if !model.trim().is_empty() {
        cmd.args(["--model", model.trim()]);
    }
    match cmd.arg(prompt).output() {
        Ok(o) if o.status.success() => (true, String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(o) => (false, String::from_utf8_lossy(&o.stderr).to_string()),
        Err(e) => (false, e.to_string()),
    }
}

/// Run `claude -p <prompt>` headless and return its stdout directly (no file
/// written). Tools call this to generate content on demand — e.g. the Daily
/// Briefing asks for JSON and parses it. `project_path` blank = the ~/Projects
/// root; the run uses that project's repo dir as its cwd, so `claude` has the
/// same web/tool access the scheduler gives it.
#[tauri::command]
async fn run_claude_prompt(
    app: AppHandle,
    project_path: String,
    prompt: String,
    model: String,
) -> Result<String, String> {
    let project_path = if project_path.trim().is_empty() {
        projects_root(&app)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(project_path)
    } else {
        project_path
    };
    let cwd = claude_cwd(&app, &project_path, "repo");
    let (ok, text) = claude_capture(&cwd, &prompt, &model);
    if ok {
        Ok(text)
    } else {
        Err(text)
    }
}

/// Path to the global Daily Briefing cache, `~/Projects/today.json`. It's not
/// tied to any one project, so it lives in the Projects root.
fn briefing_path(app: &AppHandle) -> Option<PathBuf> {
    projects_root(app).map(|p| p.join("today.json"))
}

/// Read the cached briefing JSON (the whole `{date, brief}` blob the tool
/// wrote). Returns `""` if it doesn't exist yet.
#[tauri::command]
fn read_briefing(app: AppHandle) -> Result<String, String> {
    let path = briefing_path(&app).ok_or("no home dir")?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Write the briefing JSON cache to `~/Projects/today.json`.
#[tauri::command]
fn save_briefing(app: AppHandle, content: String) -> Result<(), String> {
    let path = briefing_path(&app).ok_or("no home dir")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Path to the editable briefing instructions, `~/Projects/briefing-prompt.txt`
/// — the "what should the briefing fetch & cover?" note, global like the cache.
fn briefing_prompt_path(app: &AppHandle) -> Option<PathBuf> {
    projects_root(app).map(|p| p.join("briefing-prompt.txt"))
}

/// Read the briefing instructions. Returns `""` if not set yet.
#[tauri::command]
fn read_briefing_prompt(app: AppHandle) -> Result<String, String> {
    let path = briefing_prompt_path(&app).ok_or("no home dir")?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Write the briefing instructions to `~/Projects/briefing-prompt.txt`.
#[tauri::command]
fn save_briefing_prompt(app: AppHandle, content: String) -> Result<(), String> {
    let path = briefing_prompt_path(&app).ok_or("no home dir")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Path to the saved weather location (a free-text place name, e.g.
/// "Woodacre, CA"), `~/Projects/weather-location.txt`. Blank = auto-detect by
/// IP, same global-not-per-project convention as the briefing prompt.
fn weather_location_path(app: &AppHandle) -> Option<PathBuf> {
    projects_root(app).map(|p| p.join("weather-location.txt"))
}

#[tauri::command]
fn read_weather_location(app: AppHandle) -> Result<String, String> {
    let path = weather_location_path(&app).ok_or("no home dir")?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_weather_location(app: AppHandle, content: String) -> Result<(), String> {
    let path = weather_location_path(&app).ok_or("no home dir")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Map a WMO weather code (as used by Open-Meteo) to a short human label.
/// https://open-meteo.com/en/docs#weathervariables
fn wmo_condition(code: i64) -> &'static str {
    match code {
        0 => "Clear sky",
        1 | 2 | 3 => "Partly cloudy",
        45 | 48 => "Foggy",
        51 | 53 | 55 => "Drizzle",
        56 | 57 => "Freezing drizzle",
        61 | 63 | 65 => "Rain",
        66 | 67 => "Freezing rain",
        71 | 73 | 75 => "Snow",
        77 => "Snow grains",
        80 | 81 | 82 => "Rain showers",
        85 | 86 => "Snow showers",
        95 => "Thunderstorm",
        96 | 99 => "Thunderstorm with hail",
        _ => "Unknown",
    }
}

/// Current weather as a JSON object string: `{"tempF":62,"condition":"Partly
/// cloudy","windMph":5,"label":"Woodacre, CA"}`. Used by the Daily Briefing
/// tool so the prompt states the weather as fact instead of asking the LLM to
/// web-search for it (unreliable — it doesn't always have/use a search tool
/// or know the location).
///
/// `location`: a free-text place name to geocode, or blank to auto-detect via
/// IP (ipapi.co). Both calls hit free, keyless APIs (Open-Meteo + ipapi.co).
#[tauri::command]
fn get_weather(location: String) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(10))
        .build();

    let (lat, lon, label): (f64, f64, String) = if location.trim().is_empty() {
        let body: serde_json::Value = agent
            .get("https://ipapi.co/json/")
            .call()
            .map_err(|e| format!("IP geolocation failed: {e}"))?
            .into_json()
            .map_err(|e| e.to_string())?;
        let lat = body["latitude"].as_f64().ok_or("no latitude in IP lookup")?;
        let lon = body["longitude"].as_f64().ok_or("no longitude in IP lookup")?;
        let city = body["city"].as_str().unwrap_or("").to_string();
        let region = body["region_code"].as_str().unwrap_or("").to_string();
        let label = if region.is_empty() { city } else { format!("{city}, {region}") };
        (lat, lon, label)
    } else {
        let body: serde_json::Value = agent
            .get("https://geocoding-api.open-meteo.com/v1/search")
            .query("name", location.trim())
            .query("count", "1")
            .call()
            .map_err(|e| format!("Geocoding failed: {e}"))?
            .into_json()
            .map_err(|e| e.to_string())?;
        let hit = body["results"]
            .get(0)
            .ok_or_else(|| format!("No location found for \"{}\"", location.trim()))?;
        let lat = hit["latitude"].as_f64().ok_or("no latitude in geocoding result")?;
        let lon = hit["longitude"].as_f64().ok_or("no longitude in geocoding result")?;
        let name = hit["name"].as_str().unwrap_or(location.trim()).to_string();
        let admin1 = hit["admin1"].as_str().unwrap_or("").to_string();
        let label = if admin1.is_empty() { name } else { format!("{name}, {admin1}") };
        (lat, lon, label)
    };

    let forecast: serde_json::Value = agent
        .get("https://api.open-meteo.com/v1/forecast")
        .query("latitude", &lat.to_string())
        .query("longitude", &lon.to_string())
        .query("current", "temperature_2m,weather_code,wind_speed_10m")
        .query("temperature_unit", "fahrenheit")
        .query("wind_speed_unit", "mph")
        .call()
        .map_err(|e| format!("Forecast request failed: {e}"))?
        .into_json()
        .map_err(|e| e.to_string())?;

    let current = &forecast["current"];
    let temp_f = current["temperature_2m"]
        .as_f64()
        .ok_or("no temperature in forecast response")?;
    let wind_mph = current["wind_speed_10m"].as_f64().unwrap_or(0.0);
    let code = current["weather_code"].as_i64().unwrap_or(-1);

    serde_json::to_string(&serde_json::json!({
        "tempF": temp_f.round() as i64,
        "condition": wmo_condition(code),
        "windMph": wind_mph.round() as i64,
        "label": label,
    }))
    .map_err(|e| e.to_string())
}

/// Decode HTML/XML entities found in RSS feed text: the standard named ones
/// plus numeric (`&#8217;`) and hex (`&#x2019;`) character references — RSS
/// titles commonly use numeric entities for curly quotes/dashes.
fn unescape_entities(s: &str) -> String {
    let named = s
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&apos;", "'");

    let mut out = String::with_capacity(named.len());
    let mut rest = named.as_str();
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let parsed = tail.find(';').filter(|&semi| semi <= 10).and_then(|semi| {
            let body = &tail[1..semi];
            let code = body.strip_prefix('#').and_then(|n| {
                if let Some(hex) = n.strip_prefix('x').or_else(|| n.strip_prefix('X')) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    n.parse::<u32>().ok()
                }
            });
            code.and_then(char::from_u32).map(|c| (c, semi + 1))
        });
        match parsed {
            Some((c, len)) => {
                out.push(c);
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Strip HTML tags, leaving just the text content.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Today's Wikimedia Commons "Picture of the Day" as a JSON object string:
/// `{"imageUrl":"https://…","blurb":"Flower of a Geranium…","pageUrl":"https://…"}`.
/// Used by the Daily Briefing tool to put a real image + caption under the
/// generated body. The feed is a flat RSS list of recent days (oldest first)
/// rather than "just today", so we take the last `<item>`.
#[tauri::command]
fn get_picture_of_day() -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(10))
        .build();

    let rss = agent
        .get("https://commons.wikimedia.org/w/api.php?action=featuredfeed&feed=potd&feedformat=rss&language=en")
        // Wikimedia's API etiquette policy blocks generic/empty User-Agents —
        // a descriptive one keeps this from 403ing.
        .set("User-Agent", "Studio-DailyBriefing/1.0 (desktop app; single user)")
        .call()
        .map_err(|e| format!("Commons feed request failed: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;

    let item_start = rss.rfind("<item>").ok_or("no <item> in Commons feed")?;
    let item = &rss[item_start..];
    let item_end = item.find("</item>").map(|i| i + "</item>".len()).unwrap_or(item.len());
    let item = &item[..item_end];

    let page_url = item
        .find("<link>")
        .and_then(|s| item[s..].find("</link>").map(|e| (s + "<link>".len(), s + e)))
        .map(|(s, e)| item[s..e].trim().to_string());

    let desc_start = item.find("<description>").ok_or("no <description> in Commons feed item")?
        + "<description>".len();
    let desc_end = item[desc_start..]
        .find("</description>")
        .ok_or("unterminated <description> in Commons feed item")?
        + desc_start;
    let desc_html = unescape_entities(&item[desc_start..desc_end]);

    let img_start = desc_html.find("<img ").ok_or("no <img> in Commons feed description")?;
    let src_start = desc_html[img_start..]
        .find("src=\"")
        .map(|i| img_start + i + "src=\"".len())
        .ok_or("no src attr on <img>")?;
    let src_end = desc_html[src_start..]
        .find('"')
        .map(|i| src_start + i)
        .ok_or("unterminated src attr")?;
    let image_url = desc_html[src_start..src_end].to_string();

    let blurb = desc_html
        .find("class=\"description")
        .and_then(|s| desc_html[s..].find('>').map(|i| s + i + 1))
        .and_then(|s| desc_html[s..].find("</div>").map(|e| (s, s + e)))
        .map(|(s, e)| strip_tags(&desc_html[s..e]))
        .unwrap_or_default();

    serde_json::to_string(&serde_json::json!({
        "imageUrl": image_url,
        "blurb": blurb,
        "pageUrl": page_url,
    }))
    .map_err(|e| e.to_string())
}

/// Extract an RSS `<tag>…</tag>` element's text content, unwrapping a
/// `<![CDATA[…]]>` block if present (most WordPress feeds wrap `<title>` /
/// `<description>` in one), else HTML-unescaping it.
fn tag_text(item: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = item.find(&open)? + open.len();
    let end = item[start..].find(&close)? + start;
    let raw = item[start..end].trim();
    if let Some(rest) = raw.strip_prefix("<![CDATA[") {
        let cdata_end = rest.find("]]>").unwrap_or(rest.len());
        Some(rest[..cdata_end].to_string())
    } else {
        Some(unescape_entities(raw))
    }
}

/// Given an RSS item's (already CDATA-unwrapped) HTML description, return the
/// image src and text of its first `<p>` — Colossal's feed opens each post's
/// description with `<p><img .../>blurb text…</p>` followed by boilerplate
/// paragraphs ("Become a Colossal Member…") we don't want.
fn first_paragraph_image_and_text(html: &str) -> (Option<String>, String) {
    let Some(p_start) = html.find("<p>") else { return (None, String::new()) };
    let inner_start = p_start + "<p>".len();
    let Some(rel_end) = html[inner_start..].find("</p>") else { return (None, String::new()) };
    let inner = &html[inner_start..inner_start + rel_end];

    let image_url = inner.find("<img ").and_then(|i| {
        let src_start = inner[i..].find("src=\"")? + i + "src=\"".len();
        let src_end = inner[src_start..].find('"')? + src_start;
        Some(inner[src_start..src_end].to_string())
    });

    (image_url, strip_tags(inner).trim().to_string())
}

/// The 2 latest posts from Colossal's RSS feed (art/craft/visual-culture
/// blog) as a JSON array of `{imageUrl, blurb, pageUrl, title}`. Used by the
/// Daily Briefing gallery alongside the Wikimedia picture of the day.
#[tauri::command]
fn get_colossal_items() -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(10))
        .build();

    let rss = agent
        .get("https://www.thisiscolossal.com/feed/")
        .set("User-Agent", "Studio-DailyBriefing/1.0 (desktop app; single user)")
        .call()
        .map_err(|e| format!("Colossal feed request failed: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for chunk in rss.split("<item>").skip(1).take(2) {
        let item_end = chunk.find("</item>").unwrap_or(chunk.len());
        let item = &chunk[..item_end];

        let title = tag_text(item, "title").unwrap_or_default();
        let page_url = tag_text(item, "link").unwrap_or_default();
        let desc = tag_text(item, "description").unwrap_or_default();
        let (image_url, blurb) = first_paragraph_image_and_text(&desc);

        if let Some(image_url) = image_url {
            items.push(serde_json::json!({
                "imageUrl": image_url,
                "blurb": if blurb.is_empty() { title.clone() } else { blurb },
                "pageUrl": page_url,
                "title": title,
            }));
        }
    }

    serde_json::to_string(&items).map_err(|e| e.to_string())
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
    // Scheduled/headless runs operate on the code repo (preserves prior behavior).
    let cwd = claude_cwd(&app, &project_path, "repo");
    std::thread::spawn(move || {
        let (ok, text) = claude_capture(&cwd, &prompt, &model);

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
    track_tool_window("schedules", "", None, "schedules");
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

/// Stable per-project label for a Video window (one window per project folder).
fn video_label(path: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    format!("video-{:x}", h.finish())
}

/// Open (or focus) the Video editor window for a project. Edit documents live
/// under `<path>/videos/`, shared live with Claude Code. `file` optionally
/// selects which edit to show (a basename, e.g. from an Artifacts-panel card);
/// an already-open window receives it as a `video-open-edit` event. See
/// docs/video.md.
#[tauri::command]
fn open_video_window(app: AppHandle, path: String, file: Option<String>) -> Result<(), String> {
    let label = video_label(&path);
    track_tool_window(&label, "", Some(path.clone()), "video");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        if let Some(f) = file {
            let _ = app.emit_to(&label, "video-open-edit", f);
        }
        return Ok(());
    }
    use tauri_plugin_window_state::{StateFlags, WindowExt};
    let mut url = format!("video/index.html?path={}", url_encode(&path));
    if let Some(f) = &file {
        url.push_str(&format!("&file={}", url_encode(f)));
    }
    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title("")
        .inner_size(900.0, 640.0)
        .min_inner_size(560.0, 420.0)
        .title_bar_style(tauri::TitleBarStyle::Transparent)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.restore_state(StateFlags::SIZE | StateFlags::POSITION);
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
    track_tool_window("claude", "", project_path.clone(), "claude");
    if let Some(win) = app.get_webview_window("claude") {
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        use tauri_plugin_window_state::{StateFlags, WindowExt};
        // Custom chrome: the page paints its own title bar + project-color tint
        // (kit/window-chrome.js). transparent + shadowless so the rounded corners
        // read cleanly. Matches the standalone companion window.
        let win =
            WebviewWindowBuilder::new(&app, "claude", WebviewUrl::App("claude/index.html".into()))
                .title("Claude")
                .inner_size(600.0, 800.0)
                .min_inner_size(420.0, 360.0)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .build()
                .map_err(|e| e.to_string())?;
        // The window is created dynamically, so the window-state plugin doesn't
        // auto-restore it — apply the saved size/position explicitly. It's saved
        // again on app exit by the plugin.
        let _ = win.restore_state(StateFlags::SIZE | StateFlags::POSITION);
    }
    let ws = project_path
        .as_ref()
        .and_then(|p| read_workspace(p.clone()).ok())
        .unwrap_or_default();
    let _ = app.emit(
        "claude-jump",
        serde_json::json!({
            "key": key,
            "projectPath": project_path,
            "sprite": ws.sprite,
            "color": ws.color,
        }),
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

/// Launch (or focus) the standalone Claude companion app for a project. The
/// companion is a separate process (it survives Studio rebuilds) that runs as a
/// single owner with one window per project. We launch with `open -n … --args
/// <url>`: `-n` forces a fresh instance whose argv the companion's single-instance
/// plugin forwards to the running owner (then the new instance exits), which opens
/// or focuses that project's window. This avoids deep links, whose warm
/// Apple-Event delivery to a running macOS app is unreliable. (The in-Studio
/// `open_claude_window` above is kept for live frontend dev.)
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
        .args(["-n", "-b", "com.studio.claude", "--args"])
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
fn list_claude_project_sessions(
    app: AppHandle,
    project_path: String,
    cwd: Option<String>,
) -> Vec<ClaudeHistorySession> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    // Claude records sessions under the cwd it ran in, so encode the mode's
    // resolved path (project folder or repo) to find them.
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

/// Rotate a video file in place by `degrees` (90/180/270 clockwise), losslessly
/// (remux only, via vidrotate's AVFoundation passthrough export) — the same
/// trick QuickTime/Finder use, so there's no re-encode/quality loss.
#[tauri::command]
fn rotate_video(path: String, degrees: i32) -> Result<(), String> {
    let src = PathBuf::from(&path);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("mov");
    let tmp = src.with_extension(format!("rotating.{ext}"));
    let _ = std::fs::remove_file(&tmp);

    let output = Command::new(env!("VIDROTATE_BIN"))
        .arg(&src)
        .arg(degrees.to_string())
        .arg(&tmp)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    std::fs::rename(&tmp, &src).map_err(|e| e.to_string())
}

/// Hide the macOS traffic-light buttons on a window while keeping its native
/// frame, shadow, rounded corners, and title-bar dragging (so the project-color
/// strip stays draggable). The main window uses titleBarStyle: Overlay, which
/// otherwise floats the buttons over the header.
#[cfg(target_os = "macos")]
fn hide_traffic_lights(win: &tauri::WebviewWindow) {
    use cocoa::appkit::{NSWindow, NSWindowButton};
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};
    let Ok(ptr) = win.ns_window() else { return };
    let ns = ptr as id;
    unsafe {
        for b in [
            NSWindowButton::NSWindowCloseButton,
            NSWindowButton::NSWindowMiniaturizeButton,
            NSWindowButton::NSWindowZoomButton,
        ] {
            let btn: id = ns.standardWindowButton_(b);
            if !btn.is_null() {
                let _: () = msg_send![btn, setHidden: true];
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Only persist geometry. The default flags also save/restore
        // DECORATIONS + VISIBLE, which clobbers per-window styling — e.g. it
        // would force decorations back ON for our custom (decorationless) tool
        // windows, re-adding the native title bar + traffic lights.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        use tauri_plugin_global_shortcut::{Code, Modifiers};
                        if shortcut.mods.contains(Modifiers::CONTROL)
                            && shortcut.key == Code::Space
                        {
                            toggle_mode_switcher_window(app);
                        } else {
                            toggle_spotlight_window(app);
                        }
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .manage(ClaudeState::default())
        .invoke_handler(tauri::generate_handler![
            open_claude_window,
            launch_claude_app,
            open_schedules_window,
            claude_send,
            claude_stop,
            run_schedule_now,
            run_claude_prompt,
            day_agenda,
            cal_read,
            list_tasks,
            save_task,
            delete_task,
            transit_eta,
            read_tasks_config,
            save_tasks_config,
            read_briefing,
            save_briefing,
            read_briefing_prompt,
            save_briefing_prompt,
            read_weather_location,
            save_weather_location,
            get_weather,
            get_picture_of_day,
            get_colossal_items,
            update_wake_schedule,
            read_claude_sessions,
            save_claude_sessions,
            list_claude_project_sessions,
            read_claude_session_log,
            get_claude_usage,
            get_active_project,
            clear_active_project,
            save_tool_export,
            save_export_dir,
            list_artifacts,
            read_artifact,
            save_artifact,
            overwrite_artifact,
            delete_artifact,
            open_tool,
            list_tools,
            list_projects,
            open_project,
            create_project,
            read_workspace,
            save_workspace,
            list_dir,
            list_videos,
            read_video,
            write_video,
            create_video,
            delete_video,
            create_export_frames_dir,
            save_export_frame,
            export_video,
            open_video_window,
            get_memory_stats,
            get_top_processes,
            read_notes,
            save_notes,
            list_media,
            quicklook_thumb,
            edited_thumb,
            save_edited_thumb,
            open_path,
            open_in_chrome,
            app_icon,
            open_in_zed,
            open_app,
            run_script,
            repo_scripts,
            open_in_photos,
            run_shortcut,
            heic_preview,
            import_media,
            import_clip,
            handle_dropped_paths,
            read_media_meta,
            save_media_meta,
            read_project_order,
            save_project_order,
            read_daily_notes,
            save_daily_notes,
            read_mycelium,
            save_mycelium,
            contacts_dump,
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
            rotate_video,
            trash_project,
            set_window_width,
            open_git_window,
            git_status,
            git_commit_files,
            git_commit,
            git_undo,
            git_open_file,
            open_file_in_code_editor,
            git_get_draft,
            git_set_draft,
            take_pending_open,
            active_git_color,
            git_color_for_path,
            git_diff_file_committed,
            pick_text_file,
            open_code_preview,
            read_text_file,
            write_text_file,
            git_diff_file,
            git_log_week,
            open_git_pulse,
            get_focused_window_bounds,
            list_windows,
            apply_window_layout
        ])
        // Closing the window should NOT quit Studio — it lives in the menu bar.
        // Hide the window instead of destroying it; only "Quit Studio" exits.
        .on_window_event(|window, event| {
            // Git windows: persist geometry live (a dev rebuild SIGKILLs us
            // before any exit-time save), so they reopen where you left them.
            if window.label().starts_with("git-") {
                match event {
                    tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::Focused(false) => {
                        save_git_geometry(window.app_handle(), window.label());
                    }
                    _ => {}
                }
            }
            // Spotlight: losing focus means the user clicked away — dismiss it
            // like the real Spotlight does, instead of leaving it stranded
            // on top of whatever else they're doing.
            if window.label() == "spotlight" || window.label() == "mode-switcher" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Git windows are real, dismissible windows: closing one means
                // "I'm done with this repo" — drop it from the persisted set so
                // it doesn't reopen on the next rebuild, and let it close.
                if window.label().starts_with("git-") {
                    let app = window.app_handle();
                    let list = read_git_windows(app);
                    if let Some(w) = list.iter().find(|w| git_label(&w.repo) == window.label()) {
                        remove_git_window(app, &w.repo.clone());
                    }
                    return;
                }
                // Other windows live in the menu bar — hide, don't quit Studio.
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            // Menu-bar app: no Dock icon, lives in the system tray.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Hide the main window's traffic lights (kept frameless-looking but
            // still a normal decorated window for shadow + dragging).
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                hide_traffic_lights(&win);
            }

            let handle = app.handle().clone();

            // Option+Space opens/hides the Spotlight-style tool launcher.
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                    Some(tauri_plugin_global_shortcut::Modifiers::ALT),
                    tauri_plugin_global_shortcut::Code::Space,
                );
                let _ = handle.global_shortcut().register(shortcut);

                // Ctrl+Space opens/hides the giant-text Mode switcher.
                let mode_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
                    Some(tauri_plugin_global_shortcut::Modifiers::CONTROL),
                    tauri_plugin_global_shortcut::Code::Space,
                );
                let _ = handle.global_shortcut().register(mode_shortcut);
            }

            // Build Studio's tray icons in the order given by TrayItems.json
            // (default: studio, tools, ram, daily-notes), reversed — macOS adds new
            // menu-bar items to the *left* of existing ones, so building in
            // reverse makes the manifest order read left-to-right.
            for id in tray_item_order(&handle).into_iter().rev() {
                let icon_override = tray_item_icon(&handle, &id);
                match id.as_str() {
                    "studio" => build_studio_tray(&handle, icon_override)?,
                    "tools" => build_tools_tray(&handle, icon_override)?,
                    "ram" => build_ram_tray(&handle, icon_override)?,
                    "daily-notes" => build_daily_notes_tray(&handle, icon_override)?,
                    _ => {}
                }
            }

            // Live-refresh when files change in ~/Projects (Finder, other apps).
            start_watching(&handle);

            // Periodically run any due scheduled `claude -p` tasks.
            start_scheduler(&handle);

            // Periodically pop notification cards for due Tasks (docs/tasks.md).
            start_task_watcher(&handle);

            // Periodically refresh the tray's RAM-usage label.
            start_ram_label_refresh(&handle);

            // Reopen any Git companion windows that were open before the last
            // rebuild/quit (drafts intact). Runs here on the main thread.
            for win in read_git_windows(&handle) {
                build_git_window(&handle, &win);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Studio")
        .run(|_app, event| {
            // Menu-bar app: never quit just because the last window closed.
            // Only the tray's "Quit Studio" (app.exit) should end the process.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
