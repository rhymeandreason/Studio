//! Pure git-CLI commands: functions that shell out to `git` and return data or
//! act on a repo, with no coupling to Studio's window/state plumbing. The Git
//! *window* lifecycle (git-windows.json store, build/open windows, geometry,
//! drafts, project accent colors) stays in `lib.rs` — those are woven into Tauri
//! window management. The one seam here is `git_commit`, which calls back into
//! `crate::set_git_draft` to clear the saved draft on a successful commit.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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

// ---------------------------------------------------------------------------
// History browser (src/tools/git-history.html + the Git panel's History card)
//
// Three pieces: reading the commit list / per-commit diffs, "time travel"
// (a detached checkout of an older commit, with auto-stash and a way back),
// and bookmarks. The last two need a little persistence — a `git-bookmarks.json`
// in the app config dir, keyed by repo path — but no window plumbing, so it
// lives here with the rest of the git domain rather than in lib.rs.
// ---------------------------------------------------------------------------

/// Run `git -C <repo> <args>`, returning stdout or the trimmed stderr.
fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let mut all = vec!["-C", repo];
    all.extend_from_slice(args);
    let out = Command::new("git")
        .args(&all)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// One row in the history list.
#[derive(Serialize)]
pub struct HistCommit {
    hash: String,
    short: String,
    subject: String,
    author: String,
    /// Relative age ("3 days ago").
    rel: String,
    /// Absolute date, for the expanded detail.
    date: String,
    /// ISO day (`YYYY-MM-DD`), so the frontend can group by day.
    day: String,
    /// Ref decorations ("HEAD -> main, origin/main, tag: v1"), may be empty.
    refs: String,
}

/// A page of commit history. `rev` is what to log (a branch name, or empty for
/// `HEAD`) — while time travelling, HEAD is detached in the past, so the tool
/// passes the original branch to keep showing the full timeline.
#[tauri::command]
pub fn git_history(
    repo: String,
    rev: Option<String>,
    skip: u32,
    limit: u32,
) -> Result<Vec<HistCommit>, String> {
    let rev = rev.unwrap_or_default();
    let rev = if rev.trim().is_empty() { "HEAD" } else { rev.trim() };
    let skip = format!("--skip={}", skip);
    let limit = format!("-n{}", limit);
    let text = git(
        &repo,
        &[
            "log",
            rev,
            &skip,
            &limit,
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cr%x1f%cd%x1f%cs%x1f%D",
            "--date=format:%b %-d, %Y at %H:%M",
        ],
    )?;
    let mut out = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let p: Vec<&str> = line.split('\u{1f}').collect();
        if p.len() < 8 || p[0].is_empty() {
            continue;
        }
        out.push(HistCommit {
            hash: p[0].to_string(),
            short: p[1].to_string(),
            subject: p[2].to_string(),
            author: p[3].to_string(),
            rel: p[4].to_string(),
            date: p[5].to_string(),
            day: p[6].to_string(),
            refs: p[7].to_string(),
        });
    }
    Ok(out)
}

/// Unified diff of one file as changed by one commit, for the expanded row.
#[tauri::command]
pub fn git_commit_file_diff(repo: String, hash: String, path: String) -> Result<String, String> {
    git(
        &repo,
        &["show", "--no-color", "--format=", &hash, "--", &path],
    )
}

// --- bookmarks + time-travel store ----------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Bookmark {
    hash: String,
    short: String,
    subject: String,
}

/// Where a time-travelling repo came from, so it can get back: the branch that
/// was checked out, and whether we stashed dirty work to leave it.
#[derive(Serialize, Deserialize, Clone)]
pub struct Travel {
    branch: String,
    stashed: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct RepoHist {
    #[serde(default)]
    bookmarks: Vec<Bookmark>,
    #[serde(default)]
    travel: Option<Travel>,
}

#[derive(Serialize, Deserialize, Default)]
struct HistStore {
    #[serde(default)]
    repos: HashMap<String, RepoHist>,
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("git-bookmarks.json"))
}

fn read_store(app: &AppHandle) -> HistStore {
    store_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_store(app: &AppHandle, store: &HistStore) {
    if let Some(path) = store_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(store) {
            let _ = std::fs::write(path, text);
        }
    }
}

/// Bookmarked commits for a repo (most recently added last).
#[tauri::command]
pub fn git_bookmarks(app: AppHandle, repo: String) -> Vec<Bookmark> {
    read_store(&app)
        .repos
        .remove(&repo)
        .map(|r| r.bookmarks)
        .unwrap_or_default()
}

/// Star / unstar a commit. Returns the repo's new bookmark list.
#[tauri::command]
pub fn git_toggle_bookmark(
    app: AppHandle,
    repo: String,
    hash: String,
    short: String,
    subject: String,
) -> Vec<Bookmark> {
    let mut store = read_store(&app);
    let entry = store.repos.entry(repo).or_default();
    if let Some(i) = entry.bookmarks.iter().position(|b| b.hash == hash) {
        entry.bookmarks.remove(i);
    } else {
        entry.bookmarks.push(Bookmark { hash, short, subject });
    }
    let list = entry.bookmarks.clone();
    write_store(&app, &store);
    list
}

// --- time travel -----------------------------------------------------------

/// Where HEAD is, plus the time-travel state the banner needs.
#[derive(Serialize)]
pub struct HeadState {
    /// Current branch, or empty when HEAD is detached.
    branch: String,
    hash: String,
    short: String,
    detached: bool,
    /// While time travelling: the branch to return to (empty otherwise).
    #[serde(rename = "travelBranch")]
    travel_branch: String,
    /// Whether returning will also restore stashed work.
    stashed: bool,
    /// True when the working tree has changes (staged or not, incl. untracked).
    dirty: bool,
}

#[tauri::command]
pub fn git_head_state(app: AppHandle, repo: String) -> Result<HeadState, String> {
    let hash = git(&repo, &["rev-parse", "HEAD"])?.trim().to_string();
    let short = hash.chars().take(7).collect();
    let branch = git(&repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let dirty = !git(&repo, &["status", "--porcelain"])?.trim().is_empty();
    let travel = read_store(&app).repos.remove(&repo).and_then(|r| r.travel);
    // A stale entry (the user returned by hand in a terminal) shouldn't show a
    // banner — only trust it while HEAD really is detached.
    let travelling = branch.is_empty();
    Ok(HeadState {
        detached: branch.is_empty(),
        branch,
        hash,
        short,
        travel_branch: if travelling {
            travel.as_ref().map(|t| t.branch.clone()).unwrap_or_default()
        } else {
            String::new()
        },
        stashed: travelling && travel.map(|t| t.stashed).unwrap_or(false),
        dirty,
    })
}

/// Refuse to move HEAD mid-operation — a rebase/merge/cherry-pick in flight
/// would be wrecked by a checkout.
fn assert_no_op_in_progress(repo: &str) -> Result<(), String> {
    let git_dir = git(repo, &["rev-parse", "--absolute-git-dir"])?
        .trim()
        .to_string();
    let dir = PathBuf::from(git_dir);
    for (marker, name) in [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("BISECT_LOG", "bisect"),
    ] {
        if dir.join(marker).exists() {
            return Err(format!("A {} is in progress — finish it first", name));
        }
    }
    Ok(())
}

/// Temporarily check out an older commit (detached HEAD), stashing any dirty
/// work first so the checkout can't fail or lose changes. Remembers the branch
/// (and whether it stashed) so `git_time_return` can put everything back.
#[tauri::command]
pub fn git_time_travel(app: AppHandle, repo: String, hash: String) -> Result<(), String> {
    assert_no_op_in_progress(&repo)?;

    let mut store = read_store(&app);
    let existing = store.repos.get(&repo).and_then(|r| r.travel.clone());
    let branch = git(&repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    // Already time travelling? Keep the original branch/stash — hopping between
    // old commits shouldn't lose the way home.
    let (home, already_stashed) = match (&branch, existing) {
        (b, _) if !b.is_empty() => (b.clone(), false),
        (_, Some(t)) => (t.branch, t.stashed),
        (_, None) => return Err("Detached HEAD with no branch to return to".to_string()),
    };

    let dirty = !git(&repo, &["status", "--porcelain"])?.trim().is_empty();
    if dirty {
        git(
            &repo,
            &["stash", "push", "-u", "-m", "studio: time travel"],
        )?;
    }
    if let Err(e) = git(&repo, &["checkout", "--detach", &hash]) {
        // Checkout failed — undo the stash so the tree is as we found it.
        if dirty {
            let _ = git(&repo, &["stash", "pop"]);
        }
        return Err(e);
    }

    store.repos.entry(repo).or_default().travel = Some(Travel {
        branch: home,
        stashed: already_stashed || dirty,
    });
    write_store(&app, &store);
    Ok(())
}

/// Come back to the present: check the remembered branch out again and pop the
/// stash we took on the way out.
#[tauri::command]
pub fn git_time_return(app: AppHandle, repo: String) -> Result<(), String> {
    assert_no_op_in_progress(&repo)?;
    let mut store = read_store(&app);
    let travel = store
        .repos
        .get(&repo)
        .and_then(|r| r.travel.clone())
        .ok_or("No time-travel state for this repo")?;

    git(&repo, &["checkout", &travel.branch])?;
    if travel.stashed {
        // Pop only our own stash entry, in case something else stashed since.
        let list = git(&repo, &["stash", "list"]).unwrap_or_default();
        if let Some(line) = list.lines().find(|l| l.contains("studio: time travel")) {
            if let Some(reference) = line.split(':').next() {
                git(&repo, &["stash", "pop", reference])?;
            }
        }
    }
    store.repos.entry(repo).or_default().travel = None;
    write_store(&app, &store);
    Ok(())
}
