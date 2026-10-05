//! The tool registry: `Tools.json` (repo root) lists the single-file tools in
//! `src/tools/` — which show in the wrench menu + Spotlight, in what order — and
//! carries each tool's window traits (size, tint, headless/floating). Rust has
//! no per-tool table of its own.
//!
//! Read fresh on every use. Dev builds read the checkout directly (the same
//! `src/` the webviews are served from), and `watch` rebuilds the wrench menu
//! when the list changes — so adding, renaming, resizing or retinting a tool
//! needs no restart. Release builds read the copy bundled as a resource
//! (`bundle.resources` in tauri.conf.json).

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

/// One entry in `Tools.json`.
#[derive(Deserialize, Clone)]
pub struct ToolEntry {
    /// Filename relative to `src/tools/`.
    pub file: String,
    /// Menu label; defaults to the filename without `.html`.
    #[serde(default)]
    pub name: Option<String>,
    /// `false` keeps it out of the wrench menu and Spotlight while its `window`
    /// traits still apply (Code Preview, the Dock's popovers, Git Pulse…).
    #[serde(default = "yes")]
    pub menu: bool,
    #[serde(default)]
    pub window: WindowSpec,
}

fn yes() -> bool {
    true
}

/// `"window": { "w": 350, "h": 640, "tint": "project", "kind": "floating" }` —
/// every field optional.
#[derive(Deserialize, Clone, Default)]
pub struct WindowSpec {
    pub w: Option<f64>,
    pub h: Option<f64>,
    #[serde(default)]
    pub tint: Tint,
    #[serde(default)]
    pub kind: Kind,
}

/// Where a tool window's tint comes from. All tool windows share the minimal
/// custom chrome (the page paints its own bar via `src/kit/window-chrome.js`,
/// reading `?color=` for its tint) — only the tint source varies.
#[derive(Deserialize, Clone, Copy, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Tint {
    /// The active project's accent / git color (passed in as `color`).
    Project,
    /// The Runes paper background — for global, project-less tools (no
    /// `?color=` is passed; the bar falls back to `var(--bg)`).
    #[default]
    Paper,
}

#[derive(Deserialize, Clone, Copy, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A normal tool window: native frame, kit-painted bar.
    #[default]
    Normal,
    /// No UI of its own: the window is built invisible and the page closes it
    /// when its work is done (the Color Picker *is* the macOS sampler loupe).
    Headless,
    /// Just a shape on the desktop (the Camera Bubble): borderless,
    /// transparent, shadowless, always on top on every Space; the page paints
    /// its own shape and sizes the window around it.
    Floating,
}

pub struct ToolStyle {
    pub w: f64,
    pub h: f64,
    pub tint: Tint,
    pub kind: Kind,
}

/// A menu-listed tool, resolved against the tools dir.
#[derive(Clone, PartialEq)]
pub struct ListedTool {
    pub name: String,
    /// Bare filename, as `open_tool` takes it.
    pub file: String,
    /// Absolute path (the wrench menu's item id).
    pub path: String,
}

struct Roots {
    manifest: PathBuf,
    tools: PathBuf,
}

static ROOTS: OnceLock<Roots> = OnceLock::new();

/// Resolve where `Tools.json` and the tool files live. Call once in setup,
/// before anything opens a tool window.
#[cfg_attr(debug_assertions, allow(unused_variables))]
pub fn init(app: &AppHandle) {
    // Dev: the checkout this binary was compiled from — the same `src/` the
    // webviews load (`frontendDist`), so the list and the files never disagree.
    #[cfg(debug_assertions)]
    let (manifest, tools) = {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let repo = repo.canonicalize().unwrap_or(repo);
        (repo.join("Tools.json"), repo.join("src").join("tools"))
    };
    #[cfg(not(debug_assertions))]
    let (manifest, tools) = {
        use tauri::Manager;
        let res = app.path().resource_dir().unwrap_or_default();
        (res.join("Tools.json"), res.join("tools"))
    };
    let _ = ROOTS.set(Roots { manifest, tools });
}

/// The last `Tools.json` that parsed. A save that leaves it half-written (an
/// editor mid-write, a stray comma) keeps this instead of dropping to the
/// scan-everything fallback, so the menu doesn't flicker to every file.
static LAST_GOOD: Mutex<Option<Vec<ToolEntry>>> = Mutex::new(None);

/// `Tools.json`'s entries, or `None` if the file doesn't exist (→ scan all).
fn manifest() -> Option<Vec<ToolEntry>> {
    let roots = ROOTS.get()?;
    let text = std::fs::read_to_string(&roots.manifest).ok()?;
    match serde_json::from_str::<Vec<ToolEntry>>(&text) {
        Ok(entries) => {
            *LAST_GOOD.lock().unwrap() = Some(entries.clone());
            Some(entries)
        }
        Err(e) => {
            eprintln!("Tools.json: {e} — keeping the last good copy");
            LAST_GOOD.lock().unwrap().clone()
        }
    }
}

fn stem_of(file: &str) -> String {
    Path::new(file)
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or(file)
        .to_string()
}

/// Tools for the wrench menu + Spotlight: `Tools.json`'s `menu` entries whose
/// file exists, in the order listed. No `Tools.json` → every `*.html` in the
/// tools dir, by name.
pub fn listed() -> Vec<ListedTool> {
    let Some(roots) = ROOTS.get() else {
        return Vec::new();
    };
    let dir = &roots.tools;
    let tool = |file: &str, name: String| ListedTool {
        name,
        file: file.to_string(),
        path: dir.join(file).to_string_lossy().to_string(),
    };

    if let Some(entries) = manifest() {
        return entries
            .into_iter()
            .filter(|e| e.menu && dir.join(&e.file).is_file())
            .map(|e| {
                let name = e.name.clone().unwrap_or_else(|| stem_of(&e.file));
                tool(&e.file, name)
            })
            .collect();
    }

    let mut tools: Vec<ListedTool> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().to_str()?.to_string();
            let html = Path::new(&file).extension().and_then(|e| e.to_str()) == Some("html");
            (html && !file.starts_with('.') && entry.path().is_file())
                .then(|| tool(&file, stem_of(&file)))
        })
        .collect();
    tools.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    tools
}

/// A tool's window style from its `Tools.json` entry; 900×640 paper, normal,
/// for anything unlisted.
pub fn style(file: &str) -> ToolStyle {
    let spec = manifest()
        .and_then(|entries| entries.into_iter().find(|e| e.file == file))
        .map(|e| e.window)
        .unwrap_or_default();
    ToolStyle {
        w: spec.w.unwrap_or(900.0),
        h: spec.h.unwrap_or(640.0),
        tint: spec.tint,
        kind: spec.kind,
    }
}

pub fn is_headless(file: &str) -> bool {
    style(file).kind == Kind::Headless
}

pub fn is_floating(file: &str) -> bool {
    style(file).kind == Kind::Floating
}

/// The `tool-<stem>` window label `open_tool_window` gives a plain tool.
pub fn label_for(file: &str) -> String {
    let stem: String = stem_of(file)
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    format!("tool-{stem}")
}

/// True for the window label of a headless or floating tool
/// (`tool-color-picker`, `tool-camera-bubble`). Those windows are throwaway —
/// one per run — so `CloseRequested` must let them actually close instead of
/// hiding them like every other menu-bar window: a hidden headless leftover
/// would make the next launch a no-op, and a hidden Camera Bubble would keep
/// the camera (and its green light) on.
pub fn is_disposable_label(label: &str) -> bool {
    if !label.starts_with("tool-") {
        return false;
    }
    manifest().unwrap_or_default().iter().any(|e| {
        matches!(e.window.kind, Kind::Headless | Kind::Floating) && label_for(&e.file) == label
    })
}

/// Dev only: call `on_change` whenever `Tools.json` or the set of files in
/// `src/tools/` changes. (Release builds read a bundled copy that can't change.)
#[cfg(debug_assertions)]
pub fn watch(on_change: impl Fn() + Send + 'static) {
    use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};

    let Some(roots) = ROOTS.get() else {
        return;
    };
    let manifest = roots.manifest.clone();
    let debouncer = new_debouncer(
        std::time::Duration::from_millis(250),
        move |res: DebounceEventResult| {
            let Ok(events) = res else {
                return;
            };
            // Tool *edits* land here too; the caller diffs the resulting list,
            // so only a real change to what's listed costs a menu rebuild.
            let relevant = events.iter().any(|e| {
                e.path == manifest
                    || e.path.extension().and_then(|x| x.to_str()) == Some("html")
            });
            if relevant {
                on_change();
            }
        },
    );
    let Ok(mut d) = debouncer else {
        return;
    };
    // Watch the manifest's *folder*: editors save by rename, which would
    // orphan a watch on the file itself.
    let repo = roots.manifest.parent().unwrap_or(Path::new("."));
    let ok = d.watcher().watch(repo, RecursiveMode::NonRecursive).is_ok()
        && d.watcher().watch(&roots.tools, RecursiveMode::NonRecursive).is_ok();
    if ok {
        // Leak: the watcher must outlive this fn for the app's lifetime.
        std::mem::forget(d);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The checked-in `Tools.json` parses (a bad `tint`/`kind` value would
    /// otherwise only show up as an eprintln at runtime) and every entry's
    /// file exists.
    #[test]
    fn manifest_parses_and_files_exist() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let text = std::fs::read_to_string(repo.join("Tools.json")).unwrap();
        let entries: Vec<ToolEntry> = serde_json::from_str(&text).unwrap();
        for e in &entries {
            assert!(repo.join("src/tools").join(&e.file).is_file(), "missing {}", e.file);
        }
    }
}
