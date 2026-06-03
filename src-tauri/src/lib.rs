use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Wry,
};

/// A discovered project: a folder directly under ~/Projects/.
#[derive(Clone, serde::Serialize)]
struct Project {
    name: String,
    path: String,
}

/// App-wide state: which project is currently active (if any).
#[derive(Default)]
struct AppState {
    active: Mutex<Option<Project>>,
}

const TRAY_ID: &str = "studio-tray";
const PROJECT_PREFIX: &str = "proj:";

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
                projects.push(Project {
                    name: name.to_string(),
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }
    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    projects
}

/// Build the tray menu: optional active-project header, Open Studio, the project
/// list (active one check-marked), then Quit.
fn build_tray_menu(
    app: &AppHandle,
    projects: &[Project],
    active: Option<&str>,
) -> tauri::Result<Menu<Wry>> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();

    if let Some(active_path) = active {
        let name = projects
            .iter()
            .find(|p| p.path == active_path)
            .map(|p| p.name.as_str())
            .unwrap_or("(active)");
        items.push(Box::new(MenuItem::with_id(
            app,
            "active_header",
            format!("● {name}"),
            false,
            None::<&str>,
        )?));
        items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }

    items.push(Box::new(MenuItem::with_id(
        app,
        "open_studio",
        "Open Studio",
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

/// Show and focus the single Studio window.
fn show_studio(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Activate a project: store it, refresh the tray, open the window, notify the UI.
fn activate_project(app: &AppHandle, path: &str) {
    let projects = scan_projects(app);
    let Some(project) = projects.iter().find(|p| p.path == path).cloned() else {
        return;
    };

    *app.state::<AppState>().active.lock().unwrap() = Some(project.clone());

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app, &projects, Some(&project.path)) {
            let _ = tray.set_menu(Some(menu));
        }
    }

    show_studio(app);
    let _ = app.emit("project-activated", &project);
}

/// Frontend calls this on load to render the currently-active project (if any).
#[tauri::command]
fn get_active_project(state: tauri::State<AppState>) -> Option<Project> {
    state.active.lock().unwrap().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![get_active_project])
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
                        "open_studio" => show_studio(app),
                        "quit" => app.exit(0),
                        _ if id.starts_with(PROJECT_PREFIX) => {
                            activate_project(app, &id[PROJECT_PREFIX.len()..]);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Studio");
}
