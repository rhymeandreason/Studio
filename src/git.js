// Git panel — the repo/dev-tools tab (data-panel="git"). One repo per project,
// so the panel is keyed off the active project's repo card (workspace.js).
// Cards, inline where cheap:
//   - Commit: live git status + commit box + last-commit/undo (ports the
//     standalone Git window's logic, reusing the same git_* commands). A
//     pop-out button opens that floating window when you want it detached.
//   - History: embeds tools/git-history.html?repo=… (vertical commit timeline
//     with bookmarks + temporary "step back in time" checkouts).
//   - Pulse:  embeds tools/git-pulse.html?repo=… (commit dot-graph).
//   - Server: embeds tools/server.html (the dev-server oscilloscope, which
//     already follows the active project) — only when the repo has dev scripts.

import { invoke, toast } from "./kit/app.js";
import { el, mi } from "./dom.js";
import { state } from "./state.js";
import {
  activeRepoInfo,
  setActiveRepo,
  setActiveEditor,
  pickPath,
  EDITOR_OPTIONS,
} from "./workspace.js";

let currentRepo = "";
// The Commit card's poll for outside-Studio changes. Module-level so a panel
// rebuild can't leave a second timer running against a stale card.
let statusTimer = 0;

// Everything the Commit card draws, flattened — if this string is unchanged
// there's nothing to re-render.
function statusSignature(st) {
  return [
    st.branch,
    st.ahead,
    st.hasUpstream,
    st.lastCommit?.hash || "",
    st.files.map((f) => f.status + f.path).join(","),
  ].join("|");
}

// One row in a file list: status glyph + path, click to open in editor. New
// files ("??") get a sticker star; otherwise the status letter (M/A/D/R…).
function buildFileRow(repo, f, editor) {
  const row = el("div", "git-file", { title: "Open in editor" });
  const code = el("span", "git-file__code");
  const isNew = f.status.includes("?");
  code.textContent = isNew ? "⭐" : f.status.trim().replace(/\?/g, "")[0] || "•";
  if (isNew) code.classList.add("is-new");
  const name = el("span", "git-file__name");
  // bidi-isolate so rtl ellipsis keeps the path readable
  name.textContent = "⁦" + f.path + "⁩";
  row.append(code, name);
  row.addEventListener("click", () =>
    invoke("git_open_file", { repo, file: f.path, editor }).catch((e) => toast(String(e))),
  );
  return row;
}

// Build the inline Commit card. Returns the card element and wires its own
// refresh; the panel calls back into git_status/commit/undo/drafts directly.
function buildCommitCard(repo, color, editor, pushUI, onChange, onExternal) {
  const { push, status } = pushUI;
  const card = el("section", "git-card git-card--commit");

  const head = el("div", "git-card__head");
  const title = el("div", "git-card__title");
  const name = repo.split("/").filter(Boolean).pop() || "repo";
  const branch = el("span", "git-branch", { textContent: "…" });
  title.append(el("span", "git-card__name", { textContent: name }), branch);
  const popout = el("button", "git-iconbtn", {
    type: "button",
    title: "Open in a floating window",
    innerHTML: mi("open_in_new"),
  });
  popout.addEventListener("click", () =>
    invoke("open_git_window", { repo, color }),
  );
  head.append(title, popout);

  const files = el("div", "git-files");
  const msg = el("textarea", "git-msg", { placeholder: "Commit message…" });
  const commit = el("button", "git-commit", {
    type: "button",
    textContent: "Commit all changes",
    disabled: true,
  });
  const prev = el("div", "git-prev");

  let changedCount = 0;
  let lastStatus = "";
  const syncEnabled = () => {
    commit.disabled = !msg.value.trim() || changedCount === 0;
  };

  // The button always reads "Push"; the toolbar label carries the state — N
  // commits ahead, an unpublished branch, or up to date (button disabled).
  const syncPush = (st) => {
    if (!st.hasUpstream && st.lastCommit) {
      push.disabled = false;
      push.title = `Push ${st.branch} to origin and set upstream`;
      status.textContent = "branch not published";
    } else if (st.ahead > 0) {
      push.disabled = false;
      push.title = `Push to ${st.branch}'s upstream`;
      status.textContent = `${st.ahead} commit${st.ahead === 1 ? "" : "s"} ahead`;
    } else {
      push.disabled = true;
      push.title = "Nothing to push";
      status.textContent = st.lastCommit ? "up to date" : "";
    }
  };

  async function refresh() {
    let st;
    try {
      st = await invoke("git_status", { repo });
    } catch (e) {
      branch.textContent = "not a git repo";
      files.innerHTML = "";
      files.append(el("div", "git-empty", { textContent: String(e) }));
      return;
    }
    apply(st);
  }

  // Everything that changes when a status arrives. Split from the fetch so the
  // watcher below can reuse the status it already polled.
  function apply(st) {
    lastStatus = statusSignature(st);
    branch.textContent = st.branch || "(detached)";
    changedCount = st.files.length;
    files.innerHTML = "";
    if (st.files.length === 0) {
      files.append(el("div", "git-empty", { textContent: "Working tree clean" }));
    } else {
      for (const f of st.files) files.append(buildFileRow(repo, f, editor));
    }
    syncEnabled();
    syncPush(st);

    prev.innerHTML = "";
    if (!st.lastCommit) return;
    const top = el("div", "git-prev__top");
    const pmsg = el("span", "git-prev__msg", {
      textContent: st.lastCommit.subject,
      title: "Show files in this commit",
    });
    const undo = el("button", "git-undo", {
      type: "button",
      textContent: "Undo",
      title: "Un-commit (soft reset), keeping changes",
    });
    undo.addEventListener("click", (e) => {
      e.stopPropagation();
      invoke("git_undo", { repo })
        .then(() => { toast("Un-committed"); refresh(); onChange?.(); })
        .catch((err) => toast(String(err)));
    });
    top.append(pmsg, undo);

    const meta = el("div", "git-prev__meta");
    const caret = el("span", "git-prev__caret", { textContent: "▸" });
    const hash = el("span", "git-prev__hash", { textContent: st.lastCommit.hash });
    meta.append(caret, hash, el("span", "", { textContent: "· " + st.lastCommit.rel }));

    // Expandable list of the commit's files (lazy-loaded on first open).
    const filesBox = el("div", "git-prev__files", { hidden: true });
    let loaded = false;
    const toggle = async () => {
      filesBox.hidden = !filesBox.hidden;
      caret.textContent = filesBox.hidden ? "▸" : "▾";
      if (filesBox.hidden || loaded) return;
      loaded = true;
      try {
        const cf = await invoke("git_commit_files", { repo, hash: st.lastCommit.hash });
        filesBox.innerHTML = "";
        for (const f of cf) filesBox.append(buildFileRow(repo, f, editor));
      } catch (e) {
        loaded = false;
        toast(String(e));
      }
    };
    top.style.cursor = meta.style.cursor = "pointer";
    top.addEventListener("click", toggle);
    meta.addEventListener("click", toggle);
    prev.append(top, meta, filesBox);
  }

  async function doCommit() {
    const message = msg.value.trim();
    if (!message) return;
    commit.disabled = true;
    try {
      await invoke("git_commit", { repo, message });
      msg.value = "";
      toast("Committed");
      await refresh();
      onChange?.();
    } catch (e) {
      toast(String(e));
      syncEnabled();
    }
  }

  async function doPush() {
    push.disabled = true;
    status.textContent = "pushing…";
    try {
      await invoke("git_push", { repo });
      toast("Pushed");
      await refresh();
    } catch (e) {
      const msg = String(e);
      console.error("git push failed:", msg);
      // HTTPS remotes with no cached credential can't prompt from here.
      if (/could not read Username|Authentication failed|terminal prompts disabled|no credential/i.test(msg)) {
        toast("Push failed — not signed in to GitHub. Run `git push` once in Terminal to save your credentials, or switch the remote to SSH.", 5000);
      } else {
        toast("Push failed: " + msg.split("\n")[0], 4000);
      }
      await refresh(); // restore the status label + re-enable Push
    }
  }
  push.addEventListener("click", doPush);

  let draftTimer;
  msg.addEventListener("input", () => {
    syncEnabled();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      invoke("git_set_draft", { repo, draft: msg.value }).catch(() => {});
    }, 400);
  });
  msg.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      doCommit();
    }
  });
  commit.addEventListener("click", doCommit);

  const commitBox = el("div", "git-commitbox");
  commitBox.append(msg, commit);
  card.append(head, files, commitBox, prev);

  // Restore the saved draft, then load status.
  invoke("git_get_draft", { repo }).then((d) => { if (d) msg.value = d; }).catch(() => {});
  refresh();

  // Watch for changes made outside this card — a branch switch or commit in a
  // terminal, edits from the editor, the History card time travelling. Polls
  // git_status but only re-renders when the signature changes, so the commit
  // box and scroll position aren't disturbed. Idle while another tab is up
  // (switching back to Git re-runs refresh anyway); the panel clears the timer
  // when it rebuilds.
  clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    if (document.hidden || state.activePanel !== "git") return;
    try {
      const st = await invoke("git_status", { repo });
      if (statusSignature(st) !== lastStatus) {
        apply(st);
        onExternal?.();
      }
    } catch { /* repo busy or gone; the next tick retries */ }
  }, 3000);

  card._refresh = refresh;
  return card;
}

// A card that embeds a self-contained tool page in an iframe.
function buildToolCard(label, icon, src, popoutFn) {
  const card = el("section", "git-card git-card--embed");
  const head = el("div", "git-card__head");
  const title = el("div", "git-card__title");
  title.innerHTML = mi(icon) + `<span class="git-card__name">${label}</span>`;
  head.append(title);
  if (popoutFn) {
    const popout = el("button", "git-iconbtn", {
      type: "button",
      title: "Open in a floating window",
      innerHTML: mi("open_in_new"),
    });
    popout.addEventListener("click", popoutFn);
    head.append(popout);
  }
  const frame = el("iframe", "git-embed", { src, loading: "lazy" });
  card.append(head, frame);
  card._frame = frame;
  return card;
}

// The Repo card: the project's single repo path (+ Browse) and the editor it
// opens in. Moved here from the Workspace tab — this panel is the repo's home.
// Persists through workspace.js; changing the path re-keys the panel's cards.
function buildRepoCard(repo, editor) {
  const card = el("section", "git-card git-card--repo");
  const head = el("div", "git-card__head");
  head.innerHTML = mi("folder_open") + '<span class="git-card__name">Repo</span>';
  card.append(head);

  const pathRow = el("div", "git-repo__path");
  const input = el("input", "git-repo__input", {
    type: "text",
    placeholder: "~/code/my-repo",
    value: repo,
  });
  const commit = (val) => {
    const v = (val ?? input.value).trim();
    if (v === currentRepo) return;
    setActiveRepo(v);
    renderGitPanel();
  };
  input.addEventListener("change", () => commit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
  });
  const browse = el("button", "git-repo__browse", {
    type: "button",
    title: "Choose repo folder",
    innerHTML: mi("folder_open") + "Browse",
  });
  browse.addEventListener("click", async () => {
    const picked = await pickPath({ directory: true });
    if (picked) { input.value = picked; commit(picked); }
  });
  pathRow.append(input, browse);
  card.append(pathRow);

  // "Open in" editor — only meaningful once a repo is set.
  if (repo) {
    const editorRow = el("label", "git-repo__editorrow");
    editorRow.innerHTML = '<span class="git-repo__glabel">Open in</span>';
    const sel = el("select", "git-repo__editor", { title: "Editor the repo opens in" });
    for (const o of EDITOR_OPTIONS)
      sel.append(el("option", "", { value: o.value, textContent: o.label }));
    sel.value = editor;
    sel.addEventListener("change", () => setActiveEditor(sel.value));
    editorRow.append(sel);
    card.append(editorRow);
  }
  return card;
}

export async function renderGitPanel() {
  const panel = document.getElementById("git-panel");
  if (!panel) return;
  const { repo, color, editor } = activeRepoInfo();

  // Tint the whole panel with the project's accent (cards read var(--git-accent),
  // falling back to the app accent when the project has no color).
  panel.style.setProperty("--git-accent", color || "var(--accent)");

  // Skip a full rebuild when nothing changed — keeps the commit draft/scroll and
  // avoids reloading the embedded tools on every tab switch.
  if (repo && repo === currentRepo && panel.firstElementChild) {
    panel.querySelector(".git-card--commit")?._refresh?.();
    return;
  }
  currentRepo = repo;
  panel.innerHTML = "";
  // The cards this timer polled for are gone; the new Commit card starts its own.
  clearInterval(statusTimer);

  if (!repo) {
    panel.append(buildRepoCard(repo, editor));
    const empty = el("div", "git-panel__empty");
    empty.innerHTML =
      mi("commit", false) +
      "<p class=\"git-panel__hint\">Add a repo above to see commits, pulse, and the dev server.</p>";
    panel.append(empty);
    return;
  }

  // Full-width toolbar pinned to the top of the panel (CSS: order + span). A
  // status label ("N commits ahead") + the Push button, both driven by the
  // commit card's status fetch.
  const status = el("span", "git-toolbar__status");
  const push = el("button", "git-push", { type: "button", textContent: "Push", disabled: true });
  const toolbar = el("div", "git-toolbar");
  toolbar.append(status, push);
  panel.append(toolbar);

  // Order: Server (top), Commit, Pulse, Repo (last). Server is prepended below
  // once its async details resolve.
  const pulseCard = buildToolCard("Pulse", "bar_chart", "tools/git-pulse.html?repo=" + encodeURIComponent(repo) +
    (color ? "&color=" + encodeURIComponent(color) : ""), () =>
    invoke("open_git_pulse", { repo }),
  );
  const historyCard = buildToolCard("History", "history", "tools/git-history.html?repo=" + encodeURIComponent(repo) +
    (color ? "&color=" + encodeURIComponent(color) : ""), () =>
    invoke("open_git_history", { repo }),
  );
  historyCard.classList.add("git-card--history");

  // Reload the embedded tools after a commit/undo changes the log.
  const reload = (card) => { if (card._frame) card._frame.src = card._frame.src; };
  const onChange = () => { reload(pulseCard); reload(historyCard); };
  // A change made outside Studio only reloads Pulse — History polls for itself,
  // and reloading its iframe would throw away its scroll + expanded row.
  const onExternal = () => reload(pulseCard);
  panel.append(buildCommitCard(repo, color, editor, { push, status }, onChange, onExternal));
  panel.append(historyCard);
  panel.append(pulseCard);
  panel.append(buildRepoCard(repo, editor));

  // Server card only when the repo has dev-open/dev-stop scripts. Titled with
  // the dev host:port (from repo_dev_url) rather than the word "Server", and
  // rendered bare (no card chrome).
  try {
    const { start, stop } = await invoke("repo_scripts", { repo });
    if ((start || stop) && repo === currentRepo) {
      let label = "Server";
      try {
        const url = await invoke("repo_dev_url", { repo });
        if (url) label = url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      } catch {}
      if (repo !== currentRepo) return;
      const server = buildToolCard(label, "dns", "tools/server.html", () =>
        invoke("open_tool", { file: "server.html" }),
      );
      server.classList.add("git-card--bare");
      panel.prepend(server);
    }
  } catch {}
}
