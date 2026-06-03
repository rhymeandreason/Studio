use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// Show and focus the main Studio window, creating nothing new — there is only one.
fn show_studio(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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

            // --- Tray menu ---------------------------------------------------
            // M1: a hardcoded "Hello" stands in for the project list (M2 makes it real).
            let open_item = MenuItem::with_id(app, "open_studio", "Open Studio", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let hello_item = MenuItem::with_id(app, "proj_hello", "Hello", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Studio", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[&open_item, &sep1, &hello_item, &sep2, &quit_item],
            )?;

            let _tray = TrayIconBuilder::with_id("studio-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open_studio" => show_studio(app),
                    // Clicking a project opens it in the one Studio window (M2 wires real activation).
                    "proj_hello" => show_studio(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Studio");
}
