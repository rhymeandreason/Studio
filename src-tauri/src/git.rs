//! Pure git-CLI commands: functions that shell out to `git` and return data or
//! act on a repo, with no coupling to Studio's window/state plumbing. The Git
//! *window* lifecycle (git-windows.json store, build/open windows, geometry,
//! drafts, project accent colors) stays in `lib.rs` — those are woven into Tauri
//! window management. The one seam here is `git_commit`, which calls back into
//! `crate::set_git_draft` to clear the saved draft on a successful commit.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::AppHandle;

/// One changed file in `git status`: the two-char XY code and its path.
#[derive(Serialize)]
pub struct GitFile {
    status: String,
    path: String,
}

#[derive(Serialize)]
pub struct GitCommit {
    hash: String,
    subject: String,
    rel: String,
}

#[derive(Serialize)]
pub struct GitStatus {
    branch: String,
    files: Vec<GitFile>,
    #[serde(rename = "lastCommit")]
    last_commit: Option<GitCommit>,
    /// Commits ahead of the upstream (from `## branch...origin/branch [ahead N]`).
    /// 0 when in sync; also 0 when there's no upstream (nothing to compare).
    ahead: u32,
    /// Whether the branch has an upstream at all — no upstream means the first
    /// push needs `-u origin <branch>`.
    #[serde(rename = "hasUpstream")]
    has_upstream: bool,
}

/// Read branch, changed files, and the last commit for a repo.
#[tauri::command]
pub fn git_status(repo: String) -> Result<GitStatus, String> {
    let out = Command::new("git")
        .args(["-C", &repo, "status", "--porcelain=v1", "-b"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut branch = String::new();
    let mut ahead: u32 = 0;
    let mut has_upstream = false;
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
            // "...origin/main" present ⇒ the branch is tracking an upstream.
            has_upstream = rest.contains("...");
            // Parse the ahead count out of the "[ahead N, behind M]" suffix.
            if let Some(seg) = rest.split_once("[ahead ").map(|(_, s)| s) {
                let n: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
                ahead = n.parse().unwrap_or(0);
            }
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
        ahead,
        has_upstream,
    })
}

/// List the files changed in a single commit (status + path), for expanding the
/// previous-commit row in the Git window.
#[tauri::command]
pub fn git_commit_files(repo: String, hash: String) -> Result<Vec<GitFile>, String> {
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

/// Unified `git diff` for a single file against HEAD, deriving the repo from the
/// file's own directory (the file may live outside any Studio project). Returns
/// the raw diff text; errors (not a repo, etc.) are surfaced so the editor can
/// fall back to showing no diff. Used by the Code Editor tool.
#[tauri::command]
pub fn git_diff_file(path: String) -> Result<String, String> {
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
pub fn git_diff_file_committed(path: String) -> Result<String, String> {
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
pub fn git_commit(app: AppHandle, repo: String, message: String) -> Result<(), String> {
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
    // Committed — clear the saved draft (owned by the Git-window store in lib.rs).
    crate::set_git_draft(&app, &repo, String::new());
    Ok(())
}

/// Un-commit the last commit, keeping its changes staged (soft reset).
#[tauri::command]
pub fn git_undo(repo: String) -> Result<(), String> {
    let out = Command::new("git")
        .args(["-C", &repo, "reset", "--soft", "HEAD~1"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Push the current branch to its remote. If the branch has no upstream yet,
/// set one on the first push (`push -u origin <branch>`).
///
/// Auth: we can't show an interactive prompt from a GUI subprocess, so the
/// terminal prompt is disabled (a missing credential fails fast instead of
/// hanging) and the macOS keychain helper is forced on — that's where a GitHub
/// token from a prior CLI push (or GitHub Desktop) lives, so HTTPS remotes push
/// silently. SSH remotes use the agent/key and ignore this. When neither is set
/// up, the raw git error is returned for the frontend to explain.
#[tauri::command]
pub fn git_push(repo: String) -> Result<(), String> {
    // Current branch name (empty on a detached HEAD → error out clearly).
    let head = Command::new("git")
        .args(["-C", &repo, "symbolic-ref", "--short", "HEAD"])
        .output()
        .map_err(|e| e.to_string())?;
    if !head.status.success() {
        return Err("Not on a branch (detached HEAD)".to_string());
    }
    let branch = String::from_utf8_lossy(&head.stdout).trim().to_string();

    // Does the branch already track an upstream?
    let has_upstream = Command::new("git")
        .args([
            "-C", &repo,
            "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let mut args = vec![
        "-C", &repo,
        "-c", "credential.helper=osxkeychain",
        "push",
    ];
    if !has_upstream {
        args.extend_from_slice(&["-u", "origin", &branch]);
    }
    let out = Command::new("git")
        .args(&args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Last 7 days of commits across all branches, one US-separated record per
/// line, for the Git Pulse tool.
#[tauri::command]
pub fn git_log_week(repo: String) -> Result<String, String> {
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
