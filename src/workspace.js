// Workspace tab: launch button, the Workspace form (repo/figma/apps/files/
// folders/urls cards), and its autosave. Extracted from main.js. See
// interaction-spec / BACKLOG file-split.

import { el, mi } from "./dom.js";
import { createSelection } from "./selection.js";
import { panelKeymaps } from "./keymap.js";
import { state } from "./state.js";
import { selectTab, installOffClickDeselect } from "./main.js";
import { SPRITES, DEFAULT_SPRITE, spriteStyle } from "./sprites.js";

const { invoke } = window.__TAURI__.core;

// --- Native file/folder pickers --------------------------------------------

async function pickPath(opts = {}) {
  const dialog = window.__TAURI__.dialog;
  if (!dialog || !dialog.open) {
    console.error("Dialog plugin not available on window.__TAURI__.dialog");
    return null;
  }
  const result = await dialog.open({ multiple: false, ...opts });
  return typeof result === "string" ? result : null;
}

function appNameFromPath(path) {
  const base = path.split("/").pop() || path;
  return base.replace(/\.app$/i, "");
}

export function initClaudeButton() {
  const btn = document.getElementById("claude-btn");
  btn.addEventListener("click", (e) => {
    if (!state.activeProject) return;
    // Normal click → standalone Studio Claude app. Option-click → the in-Studio
    // window (loads src/ live, for frontend iteration during `tauri dev`).
    if (e.altKey) {
      invoke("open_claude_window", { projectPath: state.activeProject.path });
    } else {
      invoke("launch_claude_app", { projectPath: state.activeProject.path });
    }
  });
}

export function initFileDirectoryButton() {
  const btn = document.getElementById("file-directory-btn");
  btn.addEventListener("click", () => {
    invoke("open_tool", { file: "file-directory.html", query: null });
  });
}

// --- Workspace modes ---------------------------------------------------
//
// Each mode is a name + a recorded window layout (app/title/x/y/w/h for every
// on-screen window at record time). Record snapshots the desktop; Play moves
// every recorded window back into place and minimizes anything else.

let wsModes = [];

function flashBtn(btn, icon, ms = 1200) {
  const original = btn.innerHTML;
  btn.innerHTML = mi(icon);
  setTimeout(() => {
    btn.innerHTML = original;
  }, ms);
}

function formatSavedAt(iso) {
  if (!iso) return "Not recorded yet";
  const d = new Date(iso);
  if (isNaN(d)) return "Not recorded yet";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Saved today at ${time}`;
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Saved ${date} at ${time}`;
}

async function recordMode(mode, btn, playBtn, savedEl) {
  btn.disabled = true;
  try {
    mode.layout = await invoke("list_windows");
    mode.recordedAt = new Date().toISOString();
    scheduleWorkspaceSave();
    flashBtn(btn, "check");
    playBtn.disabled = !mode.layout.length;
    savedEl.textContent = formatSavedAt(mode.recordedAt);
  } catch (err) {
    flashBtn(btn, "error");
    console.error(err);
  }
  btn.disabled = false;
}

async function playMode(mode, btn) {
  btn.disabled = true;
  try {
    await invoke("apply_window_layout", { layout: mode.layout || [] });
    flashBtn(btn, "check");
  } catch (err) {
    flashBtn(btn, "error");
    console.error(err);
  }
  btn.disabled = false;
}

function renderModes() {
  const wrap = document.getElementById("ws-modes");
  wrap.innerHTML = "";
  wsModes.forEach((mode) => {
    const card = document.createElement("div");
    card.className = "ws-mode";

    const head = document.createElement("div");
    head.className = "ws-mode__head";
    const name = document.createElement("input");
    name.type = "text";
    name.className = "ws-mode__name";
    name.value = mode.name;
    name.spellcheck = false;
    const saved = document.createElement("span");
    saved.className = "ws-mode__saved";
    saved.textContent = formatSavedAt(mode.recordedAt);
    head.append(name, saved);

    const actions = document.createElement("div");
    actions.className = "ws-mode__actions";

    const recordBtn = document.createElement("button");
    recordBtn.type = "button";
    recordBtn.className = "ws-mode__btn ws-mode__btn--record";
    recordBtn.title = `Record current windows into "${mode.name}"`;
    recordBtn.innerHTML = mi("fiber_manual_record");

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "ws-mode__btn ws-mode__btn--play";
    playBtn.title = `Restore "${mode.name}"'s windows`;

    name.addEventListener("input", () => {
      mode.name = name.value;
      recordBtn.title = `Record current windows into "${mode.name}"`;
      playBtn.title = `Restore "${mode.name}"'s windows`;
    });
    name.addEventListener("change", () => {
      mode.name = name.value.trim() || mode.name;
      name.value = mode.name;
      scheduleWorkspaceSave();
    });
    playBtn.disabled = !mode.layout?.length;
    playBtn.innerHTML = mi("play_arrow");

    recordBtn.addEventListener("click", () => recordMode(mode, recordBtn, playBtn, saved));
    playBtn.addEventListener("click", () => playMode(mode, playBtn));

    actions.append(recordBtn, playBtn);
    card.append(head, actions);
    wrap.append(card);
  });
}

export function initModes() {
  renderModes();
}

// --- Workspace form --------------------------------------------------------

function listContainer() {
  return document.getElementById("ws-cards");
}

const LIST_META = {
  repo: {
    icon: "folder_open",
    label: "Repo",
    placeholder: "~/code/my-repo",
    singleton: true,
    browse: "dir",
  },
  figma: {
    icon: "pentagon",
    label: "Figma",
    placeholder: "https://figma.com/file/…",
    singleton: true,
  },
  apps: { icon: "apps", label: "App", placeholder: "Finder", browse: "app" },
  files: {
    icon: "description",
    label: "File",
    placeholder: "~/code/file.ts",
    browse: "file",
  },
  folders: {
    icon: "folder_open",
    label: "Folder",
    placeholder: "~/some/folder",
    browse: "dir",
  },
  urls: { icon: "link", label: "URL", placeholder: "https://…" },
  scripts: {
    icon: "terminal",
    label: "Script",
    placeholder: "~/code/run.sh",
    browse: "file",
  },
};

// Code editors offered for the Repo card's "Open in" picker. Empty value =
// Zed, the Rust-side default when `editor` is blank.
const EDITOR_OPTIONS = [
  { value: "Studio Code Editor", label: "Studio Code Editor" },
  { value: "", label: "Zed" },
  { value: "Atom", label: "Atom" },
  { value: "Visual Studio Code", label: "VS Code" },
  { value: "Sublime Text", label: "Sublime Text" },
  { value: "Xcode", label: "Xcode" },
];

// Workspace item selection (interaction-spec §3). Multi-select over the form's
// item cards; ids are per-render (rows have no persistent id).
let wsRowCounter = 0;
const workspaceSelection = createSelection({
  mode: "multi",
  onChange: () => repaintWorkspaceSelection(),
});

function workspaceCards() {
  return [...(listContainer()?.querySelectorAll(".ws-item") || [])];
}

function repaintWorkspaceSelection() {
  workspaceCards().forEach((c) =>
    c.classList.toggle("is-selected", workspaceSelection.has(c.dataset.wsid)),
  );
}

// Code-editor-native file types open in Studio's Code Editor tool instead of
// their default app.
const CODE_EDITOR_EXTENSIONS = new Set(["html", "css", "md"]);

// Open a workspace item's value. Apps store a name → `open -a`; scripts are
// spawned directly (so a `#!/usr/bin/env bash` file actually runs instead of
// opening in its default app); html/css/md files open in the Code Editor;
// everything else (paths, URLs) goes through `open`.
function openWorkspaceValue(card) {
  const value = card?.querySelector("textarea")?.value.trim();
  if (!value) return;
  const ext = value.split(".").pop()?.toLowerCase();
  if (card.dataset.list === "apps") invoke("open_app", { name: value });
  else if (card.dataset.list === "scripts") invoke("run_script", { path: value });
  else if (card.dataset.list === "files" && CODE_EDITOR_EXTENSIONS.has(ext))
    invoke("open_file_in_code_editor", { file: value });
  else invoke("open_path", { path: value });
}

// Enter: open the single selected item.
function openWorkspaceItem() {
  if (workspaceSelection.size() !== 1) return;
  const id = workspaceSelection.get()[0];
  openWorkspaceValue(workspaceCards().find((c) => c.dataset.wsid === id));
}

function deleteWorkspaceSelection() {
  const ids = new Set(workspaceSelection.get());
  if (!ids.size) return;
  let changed = false;
  workspaceCards().forEach((card) => {
    if (!ids.has(card.dataset.wsid)) return;
    const list = card.dataset.list;
    card.remove();
    if (LIST_META[list]?.singleton) setSingletonBtn(list, false);
    changed = true;
  });
  workspaceSelection.clear();
  if (changed) scheduleWorkspaceSave();
}

function moveWorkspaceSelection(dir) {
  const cards = workspaceCards();
  if (!cards.length) return;
  const ids = cards.map((c) => c.dataset.wsid);
  const cols = Math.max(
    1,
    getComputedStyle(listContainer()).gridTemplateColumns.split(" ").length,
  );
  const sel = workspaceSelection.get();
  let idx = sel.length ? ids.indexOf(sel[sel.length - 1]) : -1;
  if (idx === -1) idx = 0;
  else if (dir === "left") idx -= 1;
  else if (dir === "right") idx += 1;
  else if (dir === "up") idx -= cols;
  else if (dir === "down") idx += cols;
  idx = Math.max(0, Math.min(idx, ids.length - 1));
  workspaceSelection.set(ids[idx]);
  cards[idx].scrollIntoView({ block: "nearest" });
}

panelKeymaps.workspace = {
  Enter: openWorkspaceItem,
  Delete: deleteWorkspaceSelection,
  Backspace: deleteWorkspaceSelection,
  ArrowLeft: () => moveWorkspaceSelection("left"),
  ArrowRight: () => moveWorkspaceSelection("right"),
  ArrowUp: () => moveWorkspaceSelection("up"),
  ArrowDown: () => moveWorkspaceSelection("down"),
  Escape: () => workspaceSelection.clear(),
};

export function addRow(list, value = "", autoBrowse = false) {
  const rows = listContainer();
  const meta = LIST_META[list];

  const card = document.createElement("div");
  card.className = "ws-item";
  card.dataset.list = list;
  card.dataset.wsid = "ws" + wsRowCounter++;
  // Click a non-interactive part of the card to select it (interaction-spec §3).
  card.addEventListener("click", (e) => {
    if (e.target.closest("textarea, button, input, select, a")) return;
    const ids = workspaceCards().map((c) => c.dataset.wsid);
    if (e.shiftKey) workspaceSelection.range(ids, card.dataset.wsid);
    else workspaceSelection.toggle(card.dataset.wsid, e.metaKey || e.ctrlKey);
  });
  card.addEventListener("dblclick", (e) => {
    if (e.target.closest("textarea, button, input, select, a")) return;
    openWorkspaceValue(card);
  });

  // Header: icon + type label + remove button
  const head = document.createElement("div");
  head.className = "ws-item__head";
  head.innerHTML = `${mi(meta.icon)}<span class="ws-item__type">${meta.label}</span>`;

  card.append(head);

  // Value input
  const input = document.createElement("textarea");
  input.className = "ws-item__input";
  input.placeholder = meta.placeholder;
  input.value = value;
  input.rows = 1;
  const resizeInput = () => {
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  };
  input.addEventListener("input", resizeInput);
  // Resize after the card is in the DOM so scrollHeight is correct
  requestAnimationFrame(resizeInput);

  // Folder/file/repo cards show the name prominently above the path.
  if (list === "folders" || list === "files" || list === "repo") {
    const name = document.createElement("div");
    name.className = "ws-item__name";
    const updateName = () => {
      const path = input.value.trim().replace(/\/+$/, "");
      name.textContent = path.split("/").pop() || "";
    };
    input.addEventListener("input", updateName);
    updateName();
    card.append(name);
    input.classList.add("ws-item__input--path");
  }

  // App cards show the app's icon + name prominently above the value.
  if (list === "apps") {
    const row = document.createElement("div");
    row.className = "ws-item__app";
    const icon = document.createElement("img");
    icon.className = "ws-item__app-icon";
    icon.hidden = true;
    const name = document.createElement("div");
    name.className = "ws-item__name";
    row.append(icon, name);
    card.append(row);

    let iconTimer;
    const update = () => {
      const appName = input.value.trim();
      name.textContent = appName;
      icon.hidden = true;
      if (!appName) return;
      invoke("app_icon", { name: appName })
        .then((p) => {
          if (input.value.trim() !== appName) return;
          icon.src = window.__TAURI__.core.convertFileSrc(p);
          icon.hidden = false;
        })
        .catch(() => {});
    };
    input.addEventListener("input", () => {
      name.textContent = input.value.trim();
      icon.hidden = true;
      clearTimeout(iconTimer);
      iconTimer = setTimeout(update, 500);
    });
    update();
    input.classList.add("ws-item__input--path");
  }

  // URL cards show the bare domain (e.g. "etsy.com") in large text above the URL.
  if (list === "urls") {
    const name = document.createElement("div");
    name.className = "ws-item__name";
    const updateName = () => {
      const url = input.value.trim();
      let host = "";
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        host = url;
      }
      name.textContent = host;
    };
    input.addEventListener("input", updateName);
    updateName();
    card.append(name);
    input.classList.add("ws-item__input--path");
  }

  // For the repo card the input lives inside a dedicated path row (below);
  // every other card appends it straight to the body.
  if (list !== "repo") card.append(input);

  // The repo card is the launchpad's anchor: it gets a richer, wider layout
  // with a clear action hierarchy — path (+ Browse) on top, then a footer
  // grouping "Open in editor" and the Git window controls.
  if (list === "repo") {
    card.classList.add("ws-item--repo");

    // Primary: the repo path, with an inline Browse button.
    const pathRow = document.createElement("div");
    pathRow.className = "ws-repo__path";
    const browse = document.createElement("button");
    browse.type = "button";
    browse.className = "ws-repo__browse";
    browse.innerHTML = `${mi("folder_open")}Browse`;
    browse.title = "Choose repo folder";
    browse.addEventListener("click", async () => {
      const picked = await pickPath({ directory: true });
      if (picked) {
        input.value = picked;
        input.dispatchEvent(new Event("input"));
        requestAnimationFrame(resizeInput);
        scheduleWorkspaceSave();
      }
    });
    pathRow.append(input, browse);
    card.append(pathRow);

    // Footer: a primary action row (editor + Open/Pulse), with the color
    // picker demoted to its own quiet row underneath — it's set once and
    // rarely touched, so it shouldn't compete with the buttons for space.
    const footer = document.createElement("div");
    footer.className = "ws-repo__actions";

    const primaryRow = document.createElement("div");
    primaryRow.className = "ws-repo__row ws-repo__row--primary";

    const editorGroup = document.createElement("label");
    editorGroup.className = "ws-repo__group";
    editorGroup.innerHTML = `<span class="ws-repo__glabel">Open in</span>`;
    const editorSel = document.createElement("select");
    editorSel.className = "ws-repo__editor";
    editorSel.title = "Editor the repo opens in";
    EDITOR_OPTIONS.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      editorSel.append(o);
    });
    editorSel.value = wsEditor;
    editorSel.addEventListener("change", () => {
      wsEditor = editorSel.value;
      scheduleWorkspaceSave();
    });
    editorGroup.append(editorSel);

    const gitBtn = document.createElement("button");
    gitBtn.type = "button";
    gitBtn.className = "ws-repo__git";
    gitBtn.innerHTML = `${mi("commit")}Open`;
    gitBtn.title = "Open Git window for this repo";
    gitBtn.addEventListener("click", () => {
      const repo = input.value.trim();
      if (!repo) return;
      invoke("open_git_window", { repo, color: wsColor, editor: wsEditor });
    });
    const pulseBtn = document.createElement("button");
    pulseBtn.type = "button";
    pulseBtn.className = "ws-repo__git ws-repo__git--ghost";
    pulseBtn.innerHTML = `${mi("bar_chart")}Pulse`;
    pulseBtn.title = "Open Git Pulse for this repo";
    pulseBtn.addEventListener("click", () => {
      const repo = input.value.trim();
      if (!repo) return;
      invoke("open_git_pulse", { repo });
    });
    const gitBtns = document.createElement("div");
    gitBtns.className = "ws-repo__gitbtns";
    gitBtns.append(gitBtn, pulseBtn);

    // Start/Stop the dev server now lives in its own tool window (an
    // oscilloscope that follows the active project). The button is shown only
    // if dev-open.sh / dev-stop.sh exist at the repo root (checked via
    // repo_scripts, re-run whenever the path changes).
    const serverBtn = document.createElement("button");
    serverBtn.type = "button";
    serverBtn.className = "ws-repo__git";
    serverBtn.innerHTML = `${mi("dns")}Server`;
    serverBtn.title = "Open the Server window for this repo";
    serverBtn.hidden = true;
    serverBtn.addEventListener("click", () =>
      invoke("open_tool", { file: "server.html" }),
    );
    const scriptBtns = document.createElement("div");
    scriptBtns.className = "ws-repo__gitbtns";
    scriptBtns.append(serverBtn);

    const refreshRepoScripts = async () => {
      const repo = input.value.trim();
      if (!repo) {
        serverBtn.hidden = true;
        return;
      }
      const { start, stop } = await invoke("repo_scripts", { repo });
      serverBtn.hidden = !start && !stop;
    };
    refreshRepoScripts();
    input.addEventListener("change", refreshRepoScripts);
    browse.addEventListener("click", () =>
      requestAnimationFrame(refreshRepoScripts),
    );

    primaryRow.append(editorGroup, gitBtns, scriptBtns);

    // Window colors now come from the project's accent color (set via the
    // Mode switcher), not a per-repo swatch row.
    footer.append(primaryRow);
    card.append(footer);
  }

  // Browse button for apps and files (the repo card has its own, above).
  if (meta.browse && list !== "repo") {
    const browse = document.createElement("button");
    browse.type = "button";
    browse.className = "ws-item__browse";
    browse.innerHTML = `${mi("folder_open")}Browse…`;
    browse.addEventListener("click", async () => {
      const picked =
        meta.browse === "dir"
          ? await pickPath({ directory: true })
          : meta.browse === "app"
            ? await pickPath({
                defaultPath: "/Applications",
                filters: [{ name: "Applications", extensions: ["app"] }],
              })
            : await pickPath({});
      if (picked) {
        input.value = meta.browse === "app" ? appNameFromPath(picked) : picked;
        input.dispatchEvent(new Event("input"));
        scheduleWorkspaceSave();
      }
    });
    card.append(browse);
    if (autoBrowse) browse.click();
  }

  rows.append(card);
  if (meta.singleton) setSingletonBtn(list, true);
}

function setSingletonBtn(list, added) {
  const btn = document.querySelector(`[data-add-list="${list}"]`);
  if (btn) btn.disabled = added;
}

function readList(list) {
  return [
    ...listContainer().querySelectorAll(`.ws-item[data-list="${list}"] textarea`),
  ]
    .map((i) => i.value.trim())
    .filter(Boolean);
}

function setList(list, values) {
  listContainer()
    .querySelectorAll(`.ws-item[data-list="${list}"]`)
    .forEach((c) => c.remove());
  if (LIST_META[list]?.singleton) setSingletonBtn(list, false);
  (values || []).forEach((v) => addRow(list, v));
}

let wsClaude = "terminal";
let wsSprite = DEFAULT_SPRITE;

// Reflect the active project's accent onto the app header (a CSS var on :root;
// styles.css uses it for the .projhead background, falling back to --surface).
function applyHeaderColor() {
  document.documentElement.style.setProperty("--project-color", wsColor || "");
}

export async function loadWorkspace(path) {
  const ws = await invoke("read_workspace", { path });
  wsEditor = ws.editor || "Studio Code Editor";
  wsColor = ws.color || "";
  applyHeaderColor();
  wsClaude = ws.claude && ws.claude.mode ? ws.claude.mode : "terminal";
  wsSprite = ws.sprite || DEFAULT_SPRITE;
  setList("repo", ws.repo ? [ws.repo] : []);
  setList("figma", ws.figma ? [ws.figma] : []);
  setList("apps", ws.apps);
  setList("files", ws.files);
  setList("folders", ws.folders);
  setList("urls", ws.urls);
  setList("scripts", ws.scripts);
  setStatus("");
  wsPinnedTab = ws.pinnedTab || null;
  selectTab(wsPinnedTab || "workspace");
  updatePinButton();
  renderSpriteBadge();
  wsModes = ws.modes && ws.modes.length
    ? ws.modes
    : [
        { id: "code", name: "Code", layout: [] },
        { id: "design", name: "Design", layout: [] },
        { id: "default", name: "Default", layout: [] },
      ];
  renderModes();
}

// Re-read just the project accent color from disk (it can be changed externally
// by the Mode switcher), so a later workspace save doesn't clobber it.
export async function syncProjectColor(path) {
  const ws = await invoke("read_workspace", { path }).catch(() => null);
  if (ws) wsColor = ws.color || "";
  applyHeaderColor();
}

function renderSpriteBadge() {
  const sprite = document.querySelector("#sprite-badge .sprite-badge__sprite");
  const { "--sprite-start": start, "--sprite-end": end, ...rest } = spriteStyle(
    wsSprite,
    "idle",
    24,
  );
  Object.assign(sprite.style, rest);
  sprite.style.setProperty("--sprite-start", start);
  sprite.style.setProperty("--sprite-end", end);
}

const SPRITE_NAMES = Object.keys(SPRITES);

export function initSpriteBadge() {
  document.getElementById("sprite-badge").addEventListener("click", () => {
    const idx = SPRITE_NAMES.indexOf(wsSprite);
    wsSprite = SPRITE_NAMES[(idx + 1) % SPRITE_NAMES.length];
    renderSpriteBadge();
    scheduleWorkspaceSave();
  });
}

function setStatus(text) {
  document.getElementById("ws-status").textContent = text;
}

let wsSaveTimer = null;
let wsEditor = "Studio Code Editor";
let wsColor = "";
let wsPinnedTab = null;

function readWorkspaceForm() {
  return {
    repo: readList("repo")[0] || "",
    editor: wsEditor,
    color: wsColor,
    figma: readList("figma")[0] || "",
    claude: { mode: wsClaude },
    apps: readList("apps"),
    files: readList("files"),
    folders: readList("folders"),
    urls: readList("urls"),
    scripts: readList("scripts"),
    pinnedTab: wsPinnedTab,
    sprite: wsSprite,
    modes: wsModes,
  };
}

export function updatePinButton() {
  const pinBtn = document.getElementById("tab-pin");
  const activeTab = document.querySelector(".tab.is-active")?.dataset.tab;
  pinBtn.classList.toggle("is-active", !!wsPinnedTab && wsPinnedTab === activeTab);
}

export function togglePinnedTab(activeTab) {
  wsPinnedTab = wsPinnedTab === activeTab ? null : activeTab;
}

async function saveWorkspaceNow() {
  if (!state.activeProject) return;
  try {
    await invoke("save_workspace", {
      path: state.activeProject.path,
      workspace: readWorkspaceForm(),
    });
    setStatus("");
  } catch (err) {
    setStatus(`Error: ${err}`);
  }
}

export function scheduleWorkspaceSave() {
  if (!state.activeProject) return;
  clearTimeout(wsSaveTimer);
  wsSaveTimer = setTimeout(saveWorkspaceNow, 400);
}

export function initWorkspaceForm() {
  // Round "+" trigger → dropdown of card types to add (kit .menu pattern).
  const addBtn = document.getElementById("ws-add-btn");
  const addMenu = document.getElementById("ws-add-menu");
  const closeAddMenu = () => (addMenu.hidden = true);
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    addMenu.hidden = !addMenu.hidden;
  });
  document.addEventListener("click", closeAddMenu);

  document
    .querySelectorAll("[data-add-list]")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        closeAddMenu();
        const list = btn.dataset.addList;
        addRow(list, "", !!LIST_META[list]?.browse);
      }),
    );
  // Autosave: any typing or selection change in the form persists (debounced).
  const form = document.getElementById("ws-form");
  form.addEventListener("input", scheduleWorkspaceSave);
  form.addEventListener("change", scheduleWorkspaceSave);
  form.addEventListener("submit", (e) => e.preventDefault());

  installOffClickDeselect({
    panel: "workspace",
    keep: [".ws-item"],
    hasSelection: () => workspaceSelection.size(),
    clear: () => workspaceSelection.clear(),
  });

  // Re-run textarea auto-resize whenever the cards container changes width.
  const cards = document.getElementById("ws-cards");
  new ResizeObserver(() => {
    cards.querySelectorAll(".ws-item__input").forEach((ta) => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    });
  }).observe(cards);
}
