//! Local bridge: lets Studio's embedded Claude panel drive this app.
//!
//! The panel is the same `src/claude/` page, iframed in Studio's main window.
//! It can't use this app's Tauri IPC (it lives in Studio's process), so it talks
//! over a WebSocket on 127.0.0.1 instead — same commands, same events. This app
//! stays the only owner of the `claude` processes and the session store; the
//! panel is just another view.
//!
//! Security: the port is random and every connection must present a random
//! token, written with 0600 permissions to `<config dir>/bridge.json` (the panel
//! reads it through Studio). Without the token, a web page or other local
//! program can't connect, so it can't drive `claude`.
//!
//! Wire format (JSON text frames):
//!   panel → app  `{"id": 1, "cmd": "claude_send", "args": {...}}`
//!   app → panel  `{"id": 1, "ok": true, "result": ...}` / `{"id": 1, "ok": false, "error": "..."}`
//!   app → panel  `{"event": "claude-stream-<key>", "payload": "<string>"}`

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Error as WsError, Message};

/// A command handler: `(app, cmd, args) -> result`. Runs on its own thread.
pub type Handler = fn(&AppHandle, &str, serde_json::Value) -> Result<serde_json::Value, String>;

#[derive(Default)]
pub struct Bridge {
    clients: Mutex<Vec<(u64, Sender<String>)>>,
}

/// Send an event to every connected panel.
pub fn broadcast(app: &AppHandle, event: &str, payload: &str) {
    let Some(bridge) = app.try_state::<Bridge>() else { return };
    let msg = serde_json::json!({ "event": event, "payload": payload }).to_string();
    // A send only fails for a disconnected client; drop those.
    bridge
        .clients
        .lock()
        .unwrap()
        .retain(|(_, tx)| tx.send(msg.clone()).is_ok());
}

/// 16 random bytes as hex, from the OS.
fn random_token() -> Result<String, String> {
    let mut buf = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Write `bridge.json` readable only by the user.
fn write_info(config_dir: &Path, port: u16, token: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let tmp = config_dir.join("bridge.json.tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    let info = serde_json::json!({ "port": port, "token": token });
    f.write_all(info.to_string().as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, config_dir.join("bridge.json")).map_err(|e| e.to_string())
}

/// Start listening (call once, from setup). Needs `Bridge` to be managed.
pub fn start(app: AppHandle, config_dir: &Path, handler: Handler) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = random_token()?;
    write_info(config_dir, port, &token)?;

    std::thread::spawn(move || {
        let mut next_id = 0u64;
        for stream in listener.incoming().flatten() {
            next_id += 1;
            let (app, token, id) = (app.clone(), token.clone(), next_id);
            std::thread::spawn(move || serve(app, stream, &token, id, handler));
        }
    });
    Ok(())
}

/// One panel connection: authenticate, then pump requests in and replies +
/// events out until it closes.
fn serve(app: AppHandle, stream: TcpStream, token: &str, client_id: u64, handler: Handler) {
    let expected = format!("token={token}");
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let ok = req.uri().query().is_some_and(|q| q.split('&').any(|p| p == expected));
        if ok {
            Ok(resp)
        } else {
            let mut deny = ErrorResponse::new(Some("bad token".into()));
            *deny.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
            Err(deny)
        }
    };
    let Ok(mut ws) = tungstenite::accept_hdr(stream, check) else { return };
    // Short read timeout so one thread can both read requests and write events.
    let _ = ws.get_mut().set_read_timeout(Some(Duration::from_millis(15)));

    let (tx, rx) = channel::<String>();
    if let Some(bridge) = app.try_state::<Bridge>() {
        bridge.clients.lock().unwrap().push((client_id, tx.clone()));
    }

    'conn: loop {
        match ws.read() {
            Ok(Message::Text(text)) => {
                let (app, tx, text) = (app.clone(), tx.clone(), text.to_string());
                // Commands can block (spawning claude, sips, network) — never
                // stall this connection's event flow on one.
                std::thread::spawn(move || {
                    let reply = handle_request(&app, &text, handler);
                    let _ = tx.send(reply);
                });
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(WsError::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
        while let Ok(out) = rx.try_recv() {
            if ws.send(Message::text(out)).is_err() {
                break 'conn;
            }
        }
    }

    if let Some(bridge) = app.try_state::<Bridge>() {
        bridge.clients.lock().unwrap().retain(|(id, _)| *id != client_id);
    }
}

fn handle_request(app: &AppHandle, text: &str, handler: Handler) -> String {
    let req: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
    let id = req.get("id").cloned().unwrap_or_default();
    let cmd = req.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
    let args = req.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
    match handler(app, cmd, args) {
        Ok(result) => serde_json::json!({ "id": id, "ok": true, "result": result }),
        Err(error) => serde_json::json!({ "id": id, "ok": false, "error": error }),
    }
    .to_string()
}
