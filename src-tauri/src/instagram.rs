//! Instagram Saved — pulls the signed-in account's saved posts through
//! Instagram's own web endpoints (the ones instagram.com's JS calls), using
//! the session cookies from a native login webview.
//!
//! Flow: `instagram_open_login` opens instagram.com in a plain WebviewWindow;
//! the user signs in there. WKWebView keeps those cookies in the app's shared
//! data store, so any webview can read them back (`instagram_session`).
//! `instagram_fetch` / `instagram_download` replay them over `ureq` — and that
//! is all Rust does. Paging, parsing, collections and the thumbnail cache live
//! in `src/tools/instagram-saved.html` so they can change without an app
//! restart. See docs/instagram.md.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LOGIN_LABEL: &str = "instagram-login";
const IG_ORIGIN: &str = "https://www.instagram.com";
/// instagram.com's own web app id — required on every /api/v1 call.
const IG_APP_ID: &str = "936619743392459";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 \
    (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

#[derive(Serialize, Clone)]
pub struct Session {
    pub logged_in: bool,
    pub user_id: String,
    pub login_window_open: bool,
}

/// Open (or focus) the native login window at instagram.com. It's a plain
/// remote-URL webview — no Tauri IPC is injected into instagram.com; all we
/// want from it is the cookie jar it fills.
#[tauri::command]
pub fn instagram_open_login(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let url = tauri::Url::parse(&format!("{IG_ORIGIN}/accounts/login/")).map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Instagram")
        .inner_size(520.0, 800.0)
        .user_agent(USER_AGENT)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn instagram_close_login(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.close();
    }
}

/// Instagram cookies from the shared WKWebView store, as name → value.
fn cookie_jar(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    // Cookies live in the app-wide data store, so any webview will do; prefer
    // the login window when it's open (cheapest, definitely has the jar).
    let webview = app
        .get_webview_window(LOGIN_LABEL)
        .or_else(|| app.webview_windows().into_values().next())
        .ok_or("no webview available to read cookies from")?;
    // Not `cookies_for_url`: wry matches the cookie domain against the URL
    // host *exactly*, and Instagram's session cookies live on `.instagram.com`,
    // so that filter returns nothing for www.instagram.com. Filter by suffix.
    let cookies = webview.cookies().map_err(|e| e.to_string())?;
    Ok(cookies
        .into_iter()
        .filter(|c| {
            c.domain()
                .map(|d| d.trim_start_matches('.').ends_with("instagram.com"))
                .unwrap_or(false)
        })
        .map(|c| (c.name().to_string(), c.value().to_string()))
        .collect())
}

#[tauri::command]
pub fn instagram_session(app: AppHandle) -> Result<Session, String> {
    let jar = cookie_jar(&app)?;
    let user_id = jar.get("ds_user_id").cloned().unwrap_or_default();
    Ok(Session {
        logged_in: jar.contains_key("sessionid") && !user_id.is_empty(),
        user_id,
        login_window_open: app.get_webview_window(LOGIN_LABEL).is_some(),
    })
}

struct Client {
    agent: ureq::Agent,
    cookie_header: String,
    csrf: String,
}

impl Client {
    fn from_jar(jar: &HashMap<String, String>) -> Result<Self, String> {
        if !jar.contains_key("sessionid") {
            return Err("Not signed in — open the Instagram window and log in first.".into());
        }
        let mut pairs: Vec<String> = jar.iter().map(|(k, v)| format!("{k}={v}")).collect();
        pairs.sort();
        Ok(Client {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(10))
                .timeout_read(Duration::from_secs(30))
                .build(),
            cookie_header: pairs.join("; "),
            csrf: jar.get("csrftoken").cloned().unwrap_or_default(),
        })
    }

    fn get_text(&self, path: &str) -> Result<String, String> {
        let url = format!("{IG_ORIGIN}{path}");
        let resp = self
            .agent
            .get(&url)
            .set("User-Agent", USER_AGENT)
            .set("Cookie", &self.cookie_header)
            .set("x-ig-app-id", IG_APP_ID)
            .set("x-csrftoken", &self.csrf)
            .set("x-requested-with", "XMLHttpRequest")
            .set("x-asbd-id", "129477")
            .set("Referer", &format!("{IG_ORIGIN}/"))
            .set("Accept", "*/*")
            .call();
        match resp {
            Ok(r) => r.into_string().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => Err(
                "Instagram rejected the session (401/403). Sign in again in the Instagram window."
                    .into(),
            ),
            Err(ureq::Error::Status(429, _)) => {
                Err("Instagram is rate-limiting this account — wait a while and pull again.".into())
            }
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                Err(format!("Instagram {code} on {path}: {}", body.chars().take(200).collect::<String>()))
            }
            Err(e) => Err(format!("request failed: {e}")),
        }
    }

    fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .agent
            .get(url)
            .set("User-Agent", USER_AGENT)
            .set("Referer", &format!("{IG_ORIGIN}/"))
            .call()
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut resp.into_reader(), &mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

/// Raw GET against instagram.com with the session attached; the page parses
/// the JSON. Keeping Rust this dumb means endpoint/paging/parsing changes are
/// a page reload, not an app restart (see docs/instagram.md).
#[tauri::command]
pub async fn instagram_fetch(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = Client::from_jar(&cookie_jar(&app)?)?;
        client.get_text(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download a URL (CDN image/video) to `dest`, creating parent dirs. A file
/// already at `dest` is left alone — thumbnails are content-addressed by post
/// id, so this is what makes re-pulls cheap.
#[tauri::command]
pub async fn instagram_download(app: AppHandle, url: String, dest: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&dest);
        if path.is_file() {
            return Ok(false);
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let client = Client::from_jar(&cookie_jar(&app)?)?;
        let bytes = client.get_bytes(&url)?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where the page caches thumbnails: `$APPCACHE/instagram-thumbs/`.
#[tauri::command]
pub fn instagram_cache_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("instagram-thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
