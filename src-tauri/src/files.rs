//! Generic filesystem mutations for the File Directory tool — the Finder-like
//! half of `list_dir`. Everything here is deliberately dumb and path-based:
//! no project awareness, no sidecars, no undo state (the frontend keeps the
//! undo stack, since a move is exactly reversible by moving back).
//!
//! Destructive operations go to the system Trash, never `remove_*`.

use std::path::{Path, PathBuf};

/// A collision-free destination for `name` inside `dir` (`name-1.ext`, …).
fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let dest = dir.join(name);
    if !dest.exists() {
        return dest;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    let mut n = 1;
    loop {
        let cand = if ext.is_empty() {
            dir.join(format!("{stem}-{n}"))
        } else {
            dir.join(format!("{stem}-{n}.{ext}"))
        };
        if !cand.exists() {
            return cand;
        }
        n += 1;
    }
}

/// Recursive copy, used only as the cross-volume fallback for a folder move
/// (`fs::rename` fails with EXDEV between volumes).
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Rename, falling back to copy+trash across volumes. Handles files and dirs.
///
/// Errors name the file and the step that failed — a bare "No such file or
/// directory (os error 2)" from somewhere in here is impossible to place.
fn relocate(src: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    let name = src.file_name().unwrap_or_default().to_string_lossy();
    // The rename can fail for a mundane reason (EXDEV across volumes), so the
    // fallback runs regardless — but if the source is simply gone, say so
    // rather than letting the copy report it as an anonymous ENOENT.
    if !src.exists() {
        return Err(format!("\"{name}\" no longer exists at {}", src.display()));
    }
    copy_tree(src, dest).map_err(|e| format!("Couldn't copy \"{name}\": {e}"))?;
    trash::delete(src).map_err(|e| format!("Copied \"{name}\" but couldn't remove the original: {e}"))
}

/// Rejects moving a folder into itself or one of its own descendants — the
/// one way a drag-to-move can silently eat a tree.
fn is_inside(dir: &Path, candidate: &Path) -> bool {
    let (Ok(dir), Ok(candidate)) = (dir.canonicalize(), candidate.canonicalize()) else {
        return false;
    };
    candidate.starts_with(&dir)
}

/// One completed move, so the frontend can offer undo (`from` is where the
/// item now lives, `to` is where it came from — replay it through `fs_move`).
#[derive(serde::Serialize)]
pub struct Moved {
    pub from: String,
    pub to: String,
}

/// Move `paths` into `dest_dir`, renaming around collisions. Items already
/// living in `dest_dir` are skipped, so a stray drop onto the parent folder is
/// a no-op rather than a rename to `name-1`.
#[tauri::command]
pub fn fs_move(paths: Vec<String>, dest_dir: String) -> Result<Vec<Moved>, String> {
    let dir = PathBuf::from(&dest_dir);
    if !dir.is_dir() {
        return Err("Destination isn't a folder.".into());
    }
    let mut moved = Vec::new();
    for p in &paths {
        let src = PathBuf::from(p);
        let Some(name) = src.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if src.parent() == Some(dir.as_path()) {
            continue;
        }
        if src.is_dir() && is_inside(&src, &dir) {
            return Err(format!("Can't move \"{name}\" into itself."));
        }
        let dest = unique_in(&dir, name);
        relocate(&src, &dest)?;
        moved.push(Moved {
            from: dest.to_string_lossy().to_string(),
            to: p.clone(),
        });
    }
    Ok(moved)
}

/// Rename in place. Returns the new path.
#[tauri::command]
pub fn fs_rename(path: String, new_name: String) -> Result<String, String> {
    let name = new_name.trim();
    if name.is_empty() || name.contains('/') {
        return Err("Invalid name.".into());
    }
    let old = PathBuf::from(&path);
    let dir = old.parent().ok_or("No parent folder.")?;
    let new = dir.join(name);
    if new == old {
        return Ok(path);
    }
    if new.exists() {
        return Err(format!("\"{name}\" already exists here."));
    }
    std::fs::rename(&old, &new).map_err(|e| e.to_string())?;
    Ok(new.to_string_lossy().to_string())
}

/// Move to the system Trash (recoverable — Finder's own undo works on it).
#[tauri::command]
pub fn fs_trash(paths: Vec<String>) -> Result<(), String> {
    for p in &paths {
        if Path::new(p).exists() {
            trash::delete(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Copy alongside the original as `name-1.ext`. Returns the new path.
#[tauri::command]
pub fn fs_duplicate(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let dir = src.parent().ok_or("No parent folder.")?;
    let name = src.file_name().and_then(|n| n.to_str()).ok_or("Bad name.")?;
    let dest = unique_in(dir, name);
    copy_tree(&src, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}

/// Create a new folder in `dir`, uniquified. Returns the new path.
#[tauri::command]
pub fn fs_new_folder(dir: String, name: String) -> Result<String, String> {
    let base = PathBuf::from(&dir);
    if !base.is_dir() {
        return Err("Not a folder.".into());
    }
    let name = name.trim();
    let dest = unique_in(&base, if name.is_empty() { "untitled folder" } else { name });
    std::fs::create_dir(&dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("studio-files-test-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Dropping a file onto the folder it already lives in must be a no-op —
    /// never a rename to `name-1`.
    #[test]
    fn move_into_own_folder_is_a_noop() {
        let d = tmpdir("same");
        let f = d.join("a.md");
        std::fs::write(&f, "x").unwrap();

        for dest in [
            d.to_string_lossy().to_string(),
            format!("{}/", d.to_string_lossy()),  // trailing slash
            format!("{}/.", d.to_string_lossy()), // dot component
        ] {
            let moved = fs_move(vec![f.to_string_lossy().to_string()], dest.clone()).unwrap();
            assert!(moved.is_empty(), "dest {dest:?} should have been skipped");
            assert!(f.exists(), "dest {dest:?} renamed the original away");
            assert!(
                !d.join("a-1.md").exists(),
                "dest {dest:?} produced a -1 duplicate"
            );
        }
    }
}
