//! Person segmentation for the Camera Bubble tool: a dumb pipe to the
//! long-running `personseg` Swift helper (Vision). The page sends a raw frame,
//! gets a raw mask back; the framing (u32 length prefix both ways) is all Rust
//! knows — pixel formats and compositing live in the helper and the page.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request, Response};

struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

/// Spawned on first use and kept for the life of Studio (it's idle — blocked on
/// stdin — whenever no bubble is segmenting). Respawned if it ever dies.
static HELPER: Mutex<Option<Helper>> = Mutex::new(None);

fn spawn() -> std::io::Result<Helper> {
    let mut child = Command::new(env!("PERSONSEG_BIN"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    Ok(Helper { child, stdin, stdout })
}

fn round_trip(h: &mut Helper, frame: &[u8]) -> std::io::Result<Vec<u8>> {
    h.stdin.write_all(&(frame.len() as u32).to_le_bytes())?;
    h.stdin.write_all(frame)?;
    h.stdin.flush()?;
    let mut len = [0u8; 4];
    h.stdout.read_exact(&mut len)?;
    let mut out = vec![0u8; u32::from_le_bytes(len) as usize];
    h.stdout.read_exact(&mut out)?;
    Ok(out)
}

/// Raw-body command: `invoke("person_mask", uint8Array)` → ArrayBuffer.
/// Payload formats are documented in `swift/personseg.swift`.
#[tauri::command]
pub async fn person_mask(request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(frame) = request.body() else {
        return Err("person_mask expects a raw byte body".into());
    };
    let frame = frame.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = HELPER.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(spawn().map_err(|e| format!("personseg: {e}"))?);
        }
        match round_trip(guard.as_mut().unwrap(), &frame) {
            Ok(mask) => Ok(Response::new(mask)),
            Err(e) => {
                // A dead or desynced helper: drop it so the next call starts fresh.
                if let Some(mut h) = guard.take() {
                    let _ = h.child.kill();
                }
                Err(format!("personseg: {e}"))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
