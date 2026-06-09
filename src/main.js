// Studio frontend shell.
// M3: tabbed project view with a working Workspace form, plus the New Project
// flow. The tray (Rust side) owns discovery/activation; commands handle the
// filesystem work.

import { NOTE_THEMES, NOTE_FONTS } from "./themes.js";
import { createSelection } from "./selection.js";
import { installKeyDispatcher } from "./keymap.js";
import { el, mi, genId, clamp } from "./dom.js";
import { glAdjust } from "./gl.js";
import { loadImage, srcW, srcH, makePreview, renderOriented, defaultEdits } from "./imageutil.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Which panel keyboard input routes to (interaction-spec §4). Set by selectTab
// and by entering/leaving the projects overview.
let activePanel = "workspace";
const panelKeymaps = {};
const globalKeymap = {};

// Shared "click-off to deselect" for the in-project panels. Clears the panel's
// selection when the user clicks empty space in that panel or the project
// header — but never the tabs (so selection survives tab switches), nor an
// element matching one of `keep`. Only acts while its panel is active.
function installOffClickDeselect({ panel, keep, hasSelection, clear }) {
  document.addEventListener("click", (e) => {
    if (activePanel !== panel || !hasSelection()) return;
    const inZone =
      e.target.closest(`[data-panel="${panel}"]`) ||
      e.target.closest("#project-header");
    if (!inZone || e.target.closest("#tabs")) return;
    if (keep.some((s) => e.target.closest(s))) return;
    clear();
  });
}

// Any visible `.modal` backdrop (generate / extend / webexport / cutout /
// new-modal). Detected by class so new modals are covered automatically.
function openModal() {
  return [...document.querySelectorAll(".modal")].find((m) => !m.hidden) || null;
}

// A modal swallows all keys (the dispatcher routes to modalKeymap and stops),
// so Escape closes the modal before any panel/editor handler sees it.
function anyModalOpen() {
  return !!openModal();
}

function modalKeymap(e) {
  if (e.key !== "Escape") return; // Enter/etc. handled by the modal's own inputs
  const m = openModal();
  if (!m) return;
  e.preventDefault();
  if (m.id === "new-modal") closeNewModal();
  else if (m.id === "note-modal") closeNoteModal();
  else m.hidden = true;
}

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

let activeProject = null;

// --- Project rendering -----------------------------------------------------

function render(project) {
  activeProject = project;
  const empty = document.getElementById("empty-state");
  const content = document.getElementById("project-content");
  const header = document.getElementById("project-header");
  const overview = document.getElementById("overview");

  // Only close the overview when a project is actively being rendered
  // (i.e. a card was clicked). Navigating back via the back button keeps it open.
  if (project) overview.hidden = true;

  if (project) {
    document.getElementById("project-name").textContent = project.name;
    document.getElementById("project-path").textContent = project.path;
    header.hidden = false;
    empty.hidden = true;
    content.hidden = false;
    loadWorkspace(project.path);
    loadNotes(project.path);
    loadMedia(project.path);
  } else {
    header.hidden = true;
    empty.hidden = false;
    content.hidden = true;
    notesProjectPath = null;
    notesData = { version: 1, notes: [] };
  }
}

// --- All-projects overview -------------------------------------------------

let overviewProjects = []; // last-rendered projects, in display order

const projectsSelection = createSelection({
  mode: "multi",
  onChange: () => repaintProjectsSelection(),
});

function repaintProjectsSelection() {
  document
    .getElementById("overview-grid")
    ?.querySelectorAll(".card")
    .forEach((c) =>
      c.classList.toggle("is-selected", projectsSelection.has(c.dataset.path)),
    );
}

async function confirmDialog(message, title) {
  const d = window.__TAURI__.dialog;
  if (d?.confirm) return d.confirm(message, { title, kind: "warning" });
  return window.confirm(message);
}

function projectNameFor(path) {
  return (
    overviewProjects.find((p) => p.path === path)?.name || path.split("/").pop()
  );
}

async function trashProjects(paths) {
  if (!paths.length) return;
  const msg =
    paths.length === 1
      ? `Move “${projectNameFor(paths[0])}” to Trash?`
      : `Move ${paths.length} projects to Trash?`;
  if (!(await confirmDialog(msg, "Move to Trash"))) return;
  for (const path of paths) await invoke("trash_project", { path });
  projectsSelection.clear();
  showOverview();
}

function openSelectedProject() {
  const sel = projectsSelection.get();
  if (sel.length === 1) invoke("open_project", { path: sel[0] });
}

// Grid arrow navigation: move the (single) selection by one cell.
function moveProjectsSelection(dir) {
  if (!overviewProjects.length) return;
  const paths = overviewProjects.map((p) => p.path);
  const grid = document.getElementById("overview-grid");
  const cols = Math.max(
    1,
    getComputedStyle(grid).gridTemplateColumns.split(" ").length,
  );
  const sel = projectsSelection.get();
  let idx = sel.length ? paths.indexOf(sel[sel.length - 1]) : -1;
  if (idx === -1) idx = 0;
  else if (dir === "left") idx -= 1;
  else if (dir === "right") idx += 1;
  else if (dir === "up") idx -= cols;
  else if (dir === "down") idx += cols;
  idx = Math.max(0, Math.min(idx, paths.length - 1));
  projectsSelection.set(paths[idx]);
  grid
    .querySelector(`.card[data-path="${CSS.escape(paths[idx])}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

panelKeymaps.projects = {
  Enter: openSelectedProject,
  Delete: () => trashProjects(projectsSelection.get()),
  Backspace: () => trashProjects(projectsSelection.get()),
  ArrowLeft: () => moveProjectsSelection("left"),
  ArrowRight: () => moveProjectsSelection("right"),
  ArrowUp: () => moveProjectsSelection("up"),
  ArrowDown: () => moveProjectsSelection("down"),
  Escape: () => projectsSelection.clear(),
};

async function showOverview() {
  activePanel = "projects";
  const projects = await invoke("list_projects");
  const grid = document.getElementById("overview-grid");
  grid.innerHTML = "";

  overviewProjects = projects;

  if (projects.length === 0) {
    const note = document.createElement("p");
    note.className = "placeholder";
    note.textContent = "No projects yet. Use “New Project…” in the menu bar.";
    grid.append(note);
  } else {
    for (const p of projects) {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.path = p.path;
      if (projectsSelection.has(p.path)) card.classList.add("is-selected");

      const name = document.createElement("span");
      name.className = "card__name";
      name.textContent = p.name;
      const path = document.createElement("span");
      path.className = "card__path";
      path.textContent = p.path;

      const trash = document.createElement("button");
      trash.className = "card__trash";
      trash.type = "button";
      trash.title = "Move to Trash";
      trash.innerHTML = mi("delete");
      trash.addEventListener("click", (e) => {
        e.stopPropagation();
        trashProjects([p.path]);
      });

      card.append(name, path, trash);
      // Single-click selects; double-click opens (interaction-spec §3.4).
      card.addEventListener("click", (e) => {
        if (e.shiftKey) {
          projectsSelection.range(
            overviewProjects.map((x) => x.path),
            p.path,
          );
        } else {
          projectsSelection.toggle(p.path, e.metaKey || e.ctrlKey);
        }
      });
      card.addEventListener("dblclick", () =>
        invoke("open_project", { path: p.path }),
      );
      grid.append(card);
    }
  }

  // Clicking empty space in the overview clears selection (wired once).
  const overviewEl = document.getElementById("overview");
  if (!overviewEl.__deselectInit) {
    overviewEl.__deselectInit = true;
    overviewEl.addEventListener("click", (e) => {
      if (!e.target.closest(".card")) projectsSelection.clear();
    });
  }

  // Show only the overview.
  document.getElementById("project-header").hidden = true;
  document.getElementById("empty-state").hidden = true;
  document.getElementById("project-content").hidden = true;
  document.getElementById("overview").hidden = false;
}

// --- Tabs ------------------------------------------------------------------

function selectTab(name) {
  activePanel = name;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("is-active", t.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });

  // The notes bento layout measures card heights; if it ran while the panel
  // was hidden every card collapsed to one row. Re-pack now that it's visible.
  if (name === "notes") {
    requestAnimationFrame(() => requestAnimationFrame(layoutBento));
  }

  // Close the editor column when leaving the media tab.
  if (name !== "media") {
    const appRight = document.getElementById("app-right");
    if (appRight && !appRight.hidden) {
      appRight.hidden = true;
      document.getElementById("media-side").hidden = true;
      invoke("set_window_width", { width: Math.max(window.innerWidth - 320, 900) });
    }
  } else if (activeItem && mediaSelection.has(activeItem.path)) {
    // Returning to media: re-open the editor column for the selection that
    // still owns it (it was only hidden, not torn down).
    const appRight = document.getElementById("app-right");
    if (appRight && appRight.hidden) {
      document.getElementById("media-side").hidden = false;
      appRight.hidden = false;
      invoke("set_window_width", { width: Math.max(window.innerWidth, 1220) });
    }
  }
}

function initTabs() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (e.target.closest("#tab-pin")) {
      const activeTab = document.querySelector(".tab.is-active")?.dataset.tab;
      wsPinnedTab = wsPinnedTab === activeTab ? null : activeTab;
      updatePinButton();
      scheduleWorkspaceSave();
      return;
    }

    if (tab) {
      selectTab(tab.dataset.tab);
      updatePinButton();
    }
  });
}

// --- Workspace launch ------------------------------------------------------

const LAUNCH_LABEL = `${mi("rocket_launch")}Launch workspace`;

function initLaunch() {
  document.getElementById("all-projects-btn").addEventListener("click", showOverview);

  const btn = document.getElementById("launch-btn");
  btn.addEventListener("click", async () => {
    if (!activeProject) return;
    btn.disabled = true;
    btn.innerHTML = `${mi("hourglass_top")}Launching…`;
    try {
      await invoke("launch_workspace", { path: activeProject.path });
      btn.innerHTML = `${mi("check")}Launched`;
    } catch (err) {
      btn.innerHTML = `${mi("error")}Error`;
    }
    setTimeout(() => {
      btn.innerHTML = LAUNCH_LABEL;
      btn.disabled = false;
    }, 1500);
  });
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
  urls: { icon: "link", label: "URL", placeholder: "https://…" },
};

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

// Open a workspace item's value. Apps store a name → `open -a`; everything else
// (paths, URLs) goes through `open`.
function openWorkspaceValue(card) {
  const value = card?.querySelector("textarea")?.value.trim();
  if (!value) return;
  if (card.dataset.list === "apps") invoke("open_app", { name: value });
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

function addRow(list, value = "") {
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

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-remove";
  remove.innerHTML = mi("close");
  remove.addEventListener("click", () => {
    card.remove();
    scheduleWorkspaceSave();
    if (meta.singleton) setSingletonBtn(list, false);
  });
  head.append(remove);
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
  card.append(input);

  // Browse button for repo, apps, and files
  if (meta.browse) {
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
        scheduleWorkspaceSave();
      }
    });
    card.append(browse);
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

async function loadWorkspace(path) {
  const ws = await invoke("read_workspace", { path });
  wsEditor = ws.editor || "";
  wsClaude = ws.claude && ws.claude.mode ? ws.claude.mode : "terminal";
  setList("repo", ws.repo ? [ws.repo] : []);
  setList("figma", ws.figma ? [ws.figma] : []);
  setList("apps", ws.apps);
  setList("files", ws.files);
  setList("urls", ws.urls);
  setStatus("");
  wsPinnedTab = ws.pinnedTab || null;
  selectTab(wsPinnedTab || "workspace");
  updatePinButton();
}

function setStatus(text) {
  document.getElementById("ws-status").textContent = text;
}

let wsSaveTimer = null;
let wsEditor = "";
let wsPinnedTab = null;

function readWorkspaceForm() {
  return {
    repo: readList("repo")[0] || "",
    editor: wsEditor,
    figma: readList("figma")[0] || "",
    claude: { mode: wsClaude },
    apps: readList("apps"),
    files: readList("files"),
    urls: readList("urls"),
    pinnedTab: wsPinnedTab,
  };
}

function updatePinButton() {
  const pinBtn = document.getElementById("tab-pin");
  const activeTab = document.querySelector(".tab.is-active")?.dataset.tab;
  pinBtn.classList.toggle("is-active", !!wsPinnedTab && wsPinnedTab === activeTab);
}

async function saveWorkspaceNow() {
  if (!activeProject) return;
  try {
    await invoke("save_workspace", {
      path: activeProject.path,
      workspace: readWorkspaceForm(),
    });
    setStatus("Saved ✓");
  } catch (err) {
    setStatus(`Error: ${err}`);
  }
}

function scheduleWorkspaceSave() {
  if (!activeProject) return;
  setStatus("Saving…");
  clearTimeout(wsSaveTimer);
  wsSaveTimer = setTimeout(saveWorkspaceNow, 400);
}

function initWorkspaceForm() {
  document
    .querySelectorAll("[data-add-list]")
    .forEach((btn) =>
      btn.addEventListener("click", () => addRow(btn.dataset.addList)),
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

// --- New project modal -----------------------------------------------------

function openNewModal() {
  const modal = document.getElementById("new-modal");
  document.getElementById("new-name").value = "";
  hideNewError();
  modal.hidden = false;
  document.getElementById("new-name").focus();
}

function closeNewModal() {
  document.getElementById("new-modal").hidden = true;
}

// Clicking the backdrop (the .modal element itself, not the card inside)
// closes any modal — mirrors the Escape / cancel-button behaviour.
document.addEventListener("click", (e) => {
  if (!e.target.classList.contains("modal")) return;
  const id = e.target.id;
  if (id === "new-modal") { closeNewModal(); return; }
  if (id === "note-modal") { closeNoteModal(); return; }
  if (id === "generate") { document.getElementById("generate").hidden = true; return; }
  if (id === "extend")   { document.getElementById("extend").hidden   = true; return; }
  if (id === "webexport"){ document.getElementById("webexport").hidden = true; return; }
  if (id === "cutout")   { document.getElementById("cutout").hidden   = true; return; }
});

function showNewError(msg) {
  const el = document.getElementById("new-error");
  el.textContent = msg;
  el.hidden = false;
}

function hideNewError() {
  document.getElementById("new-error").hidden = true;
}

async function createProject() {
  const name = document.getElementById("new-name").value.trim();
  try {
    const project = await invoke("create_project", { name });
    closeNewModal();
    render(project); // Rust also activates + emits, but render now for snappiness.
    selectTab("workspace");
  } catch (err) {
    showNewError(String(err));
  }
}

function initNewModal() {
  document
    .getElementById("new-create")
    .addEventListener("click", createProject);
  document
    .getElementById("new-cancel")
    .addEventListener("click", closeNewModal);
  document.getElementById("new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createProject();
    if (e.key === "Escape") closeNewModal();
  });
}

// --- Media -----------------------------------------------------------------

let mediaProjectPath = null;
let currentMedia = null;
// The single source of truth for selection. A selection of exactly one image
// opens the editor; 0 or 2+ (or a single non-image) shows the batch bar instead.
// Media tile selection (interaction-spec §3). Multi-select; onChange repaints
// tile rings + the batch bar.
const mediaSelection = createSelection({
  mode: "multi",
  onChange: () => updateSelectionUI(),
});
const mediaItemsByPath = new Map(); // path → MediaItem, refreshed by loadMedia

function updateSelbar() {
  const n = mediaSelection.size();
  // Hide the batch bar only when the sole selected item is the one the editor
  // is already showing; otherwise show it (incl. multi-select with editor open).
  const editorOwnsSelection =
    n === 1 && activeItem && mediaSelection.has(activeItem.path);
  document.getElementById("selbar").hidden = n === 0 || editorOwnsSelection;
  document.getElementById("sel-count").textContent = `${n} selected`;
  document.getElementById("sel-paste").disabled = !copiedEdits || n === 0;
}

// Repaint tile selection rings + the batch bar from mediaSelection.
function updateSelectionUI() {
  document
    .querySelectorAll(".mediatile")
    .forEach((t) =>
      t.classList.toggle("is-selected", mediaSelection.has(t.dataset.path)),
    );
  updateSelbar();
}

// Plain click: select only this item. A single deliberate selection drives the
// editor — opening it on an image, or closing it on a non-image.
async function selectOnly(item) {
  if (item.kind !== "image") {
    mediaSelection.set(item.path); // onChange → updateSelectionUI
    await closeInlineEditor();
    return;
  }

  // Claim editor ownership *before* the selection repaint so the batch bar
  // never flashes between the selection update and the (async) editor load.
  const alreadyShown = activeItem && activeItem.path === item.path;
  activeItem = item;
  mediaSelection.set(item.path); // onChange → updateSelectionUI (sees ownership)
  if (alreadyShown) return;

  if (editItem && editItem.path !== item.path) await flushEditSave();
  document.getElementById("side-name").textContent = item.name;
  document.getElementById("media-side").hidden = false;
  document.getElementById("app-right").hidden = false;
  invoke("set_window_width", { width: Math.max(window.innerWidth, 1220) });

  moveEditor(document.getElementById("media-side-editor"));
  await loadEditor(item);
}

// ⌘/Ctrl click: add/remove from the selection. The editor is sticky here — a
// second selection never opens, closes, or switches it.
async function toggleSelect(item) {
  mediaSelection.toggle(item.path, true); // onChange → updateSelectionUI
}

function clearSelection() {
  mediaSelection.clear(); // onChange → updateSelectionUI
  closeInlineEditor();
}

// Delete from the keyboard: in the editor/lightbox, trash the selection or the
// focused image; in the grid, trash the selection.
function mediaDeleteFromKeyboard() {
  const editorActive = !document.getElementById("lightbox").hidden || !!activeItem;
  if (editorActive) {
    const targets = mediaSelection.size()
      ? mediaSelection.get()
      : editItem
        ? [editItem.path]
        : [];
    trashMedia(targets);
  } else if (mediaSelection.size()) {
    trashMedia(mediaSelection.get());
  }
}

// Move the given media (and their edit sidecars) to the Trash, then refresh.
async function trashMedia(paths) {
  if (!paths.length) return;

  // Detach the editor from anything we're deleting so we don't re-save a
  // sidecar that trash_media is about to remove.
  if (editItem && paths.includes(editItem.path)) {
    editDirty = false;
    activeItem = null;
    editItem = null;
    editThumb = editImg = editPreview = editState = null;
    document.getElementById("lightbox").hidden = true;
    moveEditor(document.getElementById("media-side-editor"));
    document.getElementById("media-side").hidden = true;
    document.getElementById("app-right").hidden = true;
    invoke("set_window_width", { width: Math.max(window.innerWidth - 320, 900) });

  }

  try {
    await invoke("trash_media", { paths });
  } catch (err) {
    console.error("Trash failed:", err);
    return;
  }

  for (const p of paths) mediaSelection.delete(p);
  updateSelbar();
  if (mediaProjectPath) loadMedia(mediaProjectPath);
}

// Write the copied adjustments onto every selected image's sidecar.
async function batchPaste() {
  if (!copiedEdits || !mediaSelection.size()) return;
  const fields = {};
  for (const f of ADJ_FIELDS) if (f in copiedEdits) fields[f] = copiedEdits[f];

  const paths = mediaSelection.get();
  for (const path of paths) {
    const existing = await invoke("read_edits", { path });
    await invoke("save_edits", {
      path,
      edits: { version: 1, ...existing, ...fields },
    });
    invalidateThumb(path);
  }

  const n = paths.length;
  document.getElementById("sel-count").textContent =
    `Pasted to ${n} image${n > 1 ? "s" : ""} ✓`;
  document.getElementById("sel-paste").disabled = true;
  setTimeout(() => {
    clearSelection();
    if (mediaProjectPath) loadMedia(mediaProjectPath); // refresh thumbnails
  }, 1400);
}

// Resolve a displayable asset URL for a media item (HEIC gets a cached JPEG).
async function mediaSrc(item) {
  const convert = window.__TAURI__.core.convertFileSrc;
  if (item.is_heic) {
    try {
      const jpg = await invoke("heic_preview", { path: item.path });
      return convert(jpg);
    } catch (err) {
      console.error("HEIC preview failed:", err);
      return "";
    }
  }
  return convert(item.path);
}

// Paste an image from the clipboard into the active project's media/.
async function pasteImageFromClipboard() {
  if (!activeProject) return;
  try {
    await invoke("paste_image", { projectPath: activeProject.path });
    selectTab("media");
    loadMedia(activeProject.path);
  } catch (err) {
    // Usually just "No image in clipboard" — ignore quietly.
    console.debug("paste_image:", err);
  }
}

// Shared offscreen GL canvas for rendering edited thumbnails (one context).
const thumbGLCanvas = document.createElement("canvas");
// Cache of baked thumbnail data URLs by image path; invalidated when its edits
// change so we don't re-render the whole grid on every close / batch paste.
const thumbCache = new Map();

function invalidateThumb(path) {
  thumbCache.delete(path);
}

// Bake a thumbnail (geometry + crop + tonal) from an in-memory source image or
// canvas → data URL. Source must be clean (data-URL/canvas) so toDataURL works.
// Bake a thumbnail from an already-oriented (rotate/flip/straighten) canvas,
// applying crop + tonal. Lets callers reuse the editor's cached oriented canvas.
function bakeThumbFromOriented(oriented, edits) {
  let base = oriented;
  const c = edits.crop;
  if (c && (c.x > 0 || c.y > 0 || c.w < 1 || c.h < 1)) {
    const sx = Math.round(c.x * oriented.width);
    const sy = Math.round(c.y * oriented.height);
    const sw = Math.max(1, Math.round(c.w * oriented.width));
    const sh = Math.max(1, Math.round(c.h * oriented.height));
    const cc = document.createElement("canvas");
    cc.width = sw;
    cc.height = sh;
    cc.getContext("2d").drawImage(oriented, sx, sy, sw, sh, 0, 0, sw, sh);
    base = cc;
  }

  const MAX = 400;
  const scale = Math.min(1, MAX / Math.max(base.width, base.height));
  thumbGLCanvas.width = Math.max(1, Math.round(base.width * scale));
  thumbGLCanvas.height = Math.max(1, Math.round(base.height * scale));
  glAdjust(thumbGLCanvas, base, edits);
  return thumbGLCanvas.toDataURL("image/png");
}

function bakeThumbDataURL(src, edits) {
  return bakeThumbFromOriented(renderOriented(src, edits), edits);
}

// Render an edited image's thumbnail (geometry + crop + tonal baked) as a data URL.
async function renderThumb(item) {
  const [dataUrl, saved] = await Promise.all([
    invoke("read_image_data", { path: item.path }),
    invoke("read_edits", { path: item.path }),
  ]);
  const img = await loadImage(dataUrl);
  return bakeThumbDataURL(img, { ...defaultEdits(), ...saved });
}

// QuickLook thumbnail (any file type) → asset URL, via the OS thumbnail service.
async function qlSrc(item) {
  try {
    const p = await invoke("quicklook_thumb", { path: item.path, size: 400 });
    return window.__TAURI__.core.convertFileSrc(p);
  } catch (err) {
    console.error("QuickLook thumb failed:", err);
    return "";
  }
}

const KIND_ICONS = {
  video: "play_circle",
  audio: "music_note",
  doc: "description",
};

// Any .webp is a web format; also the export naming ("<name>x<longest>.jpg/png"
// or the legacy "@web").
function isWebExport(name) {
  return (
    /\.webp$/i.test(name) ||
    /x\d+\.(?:jpe?g|png)$/i.test(name) ||
    name.includes("@web")
  );
}

function startRename(tile, nameEl, item) {
  if (tile.querySelector(".mediatile__rename")) return; // already renaming
  const input = el("textarea", "mediatile__rename", { rows: 1 });
  input.value = item.name;
  nameEl.replaceWith(input);
  // Auto-height.
  const resizeInput = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
  input.addEventListener("input", resizeInput);
  requestAnimationFrame(() => { resizeInput(); input.focus(); });
  // Select name without extension for convenience.
  const dotIdx = item.name.lastIndexOf(".");
  input.setSelectionRange(0, dotIdx > 0 ? dotIdx : item.name.length);

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === item.name) {
      cancel();
      return;
    }
    try {
      const newPath = await invoke("rename_media", { oldPath: item.path, newName });
      item.name = newName;
      item.path = newPath;
      tile.dataset.path = newPath;
      nameEl.textContent = newName;
    } catch (err) {
      console.error("Rename failed:", err);
    }
    input.replaceWith(nameEl);
  };

  const cancel = () => input.replaceWith(nameEl);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener("blur", commit);
  // Prevent tile click/select while renaming.
  input.addEventListener("click", (e) => e.stopPropagation());
}

// Build a media tile (queues its thumbnail load). `edited` collects edited
// images to bake after the grid is laid out.
function buildMediaTile(item, edited) {
  const isImage = item.kind === "image";
  const tile = el("button", "mediatile", { type: "button", title: item.name });
  tile.dataset.path = item.path;
  tile.dataset.sig = `${item.modified}|${item.edits_mtime}`;
  const thumb = el("div", "mediatile__thumb"); // the card visual + selection ring
  const img = el("img", "mediatile__img", { loading: "lazy", alt: item.name });
  if (item.is_heic) {
    thumb.append(el("span", "mediatile__badge", { textContent: "HEIC" }));
  } else if (isImage && isWebExport(item.name)) {
    thumb.append(
      el("span", "mediatile__badge mediatile__badge--web", {
        textContent: "WEB",
      }),
    );
  }
  if (!isImage)
    thumb.append(
      el("span", "mediatile__kind", {
        innerHTML: mi(KIND_ICONS[item.kind] || "insert_drive_file"),
      }),
    );
  thumb.append(img);

  tile.append(thumb);
  const nameEl = el("span", "mediatile__name", { textContent: item.name });
  nameEl.addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(tile, nameEl, item);
  });
  tile.append(nameEl);

  const metaParts = [];
  if (item.width && item.height) metaParts.push(`${item.width}×${item.height}`);
  if (item.file_size) {
    const kb = item.file_size / 1024;
    metaParts.push(kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`);
  }
  if (metaParts.length)
    tile.append(el("span", "mediatile__meta", { textContent: metaParts.join("  ·  ") }));

  if (mediaSelection.has(item.path)) tile.classList.add("is-selected");

  tile.addEventListener("click", (e) => {
    // Shift-click selects a range; ⌘/Ctrl-click toggles; plain click selects
    // only it (and opens the editor when it's a single image).
    if (e.shiftKey) {
      const order = [...document.querySelectorAll(".mediatile")].map(
        (t) => t.dataset.path,
      );
      mediaSelection.range(order, item.path);
    } else if (e.metaKey || e.ctrlKey) {
      toggleSelect(item);
    } else {
      selectOnly(item);
    }
  });
  tile.addEventListener("dblclick", () => {
    if (isImage) openLightbox(item);
    else invoke("open_path", { path: item.path });
  });

  if (isImage && item.has_edits) {
    if (thumbCache.has(item.path)) img.src = thumbCache.get(item.path);
    else edited.push({ item, img });
  } else {
    qlSrc(item).then((src) => {
      if (src) img.src = src;
    });
  }
  return tile;
}

// Reconcile the grid against the project's media — reuse unchanged tiles so the
// grid doesn't blank-and-rebuild (which caused a flicker on every refresh).
// Resolve an edited image's thumbnail: in-memory cache → on-disk cache →
// bake via the WebGL pipeline (and persist to disk). Returns an asset URL.
async function ensureEditedThumb(item) {
  if (thumbCache.has(item.path)) return thumbCache.get(item.path);
  const convert = window.__TAURI__.core.convertFileSrc;

  try {
    const cached = await invoke("edited_thumb", {
      path: item.path,
      editsMtime: item.edits_mtime,
    });
    if (cached) {
      const url = convert(cached);
      thumbCache.set(item.path, url);
      return url;
    }
  } catch (err) {
    console.error("edited_thumb:", err);
  }

  // Miss — bake it (slow) and persist for next time.
  const dataUrl = await renderThumb(item);
  try {
    const saved = await invoke("save_edited_thumb", {
      path: item.path,
      editsMtime: item.edits_mtime,
      dataBase64: dataUrl.split(",")[1],
    });
    const url = convert(saved);
    thumbCache.set(item.path, url);
    return url;
  } catch (err) {
    console.error("save_edited_thumb:", err);
    thumbCache.set(item.path, dataUrl);
    return dataUrl;
  }
}

async function loadMedia(path) {
  mediaProjectPath = path;
  const grid = document.getElementById("media-grid");
  const items = await invoke("list_media", { path });

  mediaItemsByPath.clear();
  for (const it of items) mediaItemsByPath.set(it.path, it);

  // Prune selection to files that still exist.
  const present = new Set(items.map((i) => i.path));
  for (const p of mediaSelection.get())
    if (!present.has(p)) mediaSelection.delete(p);
  updateSelbar();

  // Drop the inline edit focus if its file is gone.
  if (activeItem && !present.has(activeItem.path)) {
    activeItem = null;
    document.getElementById("media-side").hidden = true;
    document.getElementById("app-right").hidden = true;
    invoke("set_window_width", { width: Math.max(window.innerWidth - 320, 900) });

  }

  if (!items.length) {
    grid.innerHTML = `<p class="placeholder">No media in this project yet.</p>`;
    return;
  }

  const existing = new Map();
  grid
    .querySelectorAll(".mediatile")
    .forEach((t) => existing.set(t.dataset.path, t));

  const edited = [];
  const desired = [];
  for (const item of items) {
    const sig = `${item.modified}|${item.edits_mtime}`;
    const reuse = existing.get(item.path);
    if (reuse && reuse.dataset.sig === sig) {
      existing.delete(item.path);
      reuse.classList.toggle("is-selected", mediaSelection.has(item.path));
      desired.push(reuse);
    } else if (reuse && item.kind === "image") {
      // Same image, edits changed — refresh its thumbnail in place. The old (or
      // optimistic-preview) image stays visible until the new bake is ready, so
      // the tile never blanks.
      existing.delete(item.path);
      reuse.dataset.sig = sig;
      reuse.classList.toggle("is-selected", mediaSelection.has(item.path));
      const img = reuse.querySelector(".mediatile__img");
      if (item.has_edits) {
        if (thumbCache.has(item.path)) img.src = thumbCache.get(item.path);
        else edited.push({ item, img }); // keeps current src until baked
      } else {
        qlSrc(item).then((src) => {
          if (src) img.src = src;
        });
      }
      desired.push(reuse);
    } else {
      if (reuse) {
        existing.delete(item.path);
        reuse.remove(); // signature changed — drop the stale tile (don't leave a duplicate)
      }
      desired.push(buildMediaTile(item, edited));
    }
  }

  const placeholder = grid.querySelector(".placeholder");
  if (placeholder) placeholder.remove();
  for (const [, stale] of existing) stale.remove(); // removed files
  desired.forEach((tile, i) => {
    if (grid.children[i] !== tile)
      grid.insertBefore(tile, grid.children[i] || null);
  });

  for (const { item, img } of edited) {
    try {
      img.src = await ensureEditedThumb(item);
    } catch (err) {
      console.error("Thumbnail render failed:", err);
      qlSrc(item).then((src) => {
        if (src) img.src = src;
      });
    }
  }
}

// The inline-selected image (its edit controls live in the right side column).
// The editor DOM is a single shared node that we reparent between the side
// column and the lightbox overlay, so there's only ever one editor instance.
let activeItem = null;

// Move the (single) editor node into a host container if it isn't there already.
function moveEditor(host) {
  const editor = document.getElementById("editor");
  if (editor.parentElement !== host) host.append(editor);
}

// Flush any pending edit save so the grid thumbnail reflects the latest edits.
// No-op when nothing changed, so the thumbnail isn't needlessly re-baked.
async function flushEditSave() {
  if (!editItem || !editState || !editDirty) return;
  clearTimeout(editSaveTimer);
  try {
    await invoke("save_edits", { path: editItem.path, edits: editState });
  } catch (err) {
    console.error("Edit save failed:", err);
  }
  invalidateThumb(editItem.path);
  editDirty = false;
}

// The best loaded edit source for the current context: full preview in the
// lightbox, thumbnail inline — falling back to whatever is loaded so far.
function previewSrc() {
  if (!document.getElementById("lightbox").hidden)
    return editPreview || editThumb;
  return editThumb || editPreview || editImg;
}
function previewTag() {
  const src = previewSrc();
  return src === editImg ? "full" : src === editPreview ? "large" : "thumb";
}

// Lazily load the ~2048px lightbox preview (and the full-res image it's derived
// from). The full-res image doubles as the export / remove-bg source.
async function ensureFullRes() {
  if (editImg) return;
  const item = editItem;
  const dataUrl = await invoke("read_image_data", { path: item.path });
  const img = await loadImage(dataUrl);
  if (editItem !== item) return; // selection changed while loading
  editImg = img;
  editPreview = makePreview(editImg); // ~2048px copy for the lightbox
}

// Load an image's edit controls + a fast thumbnail-resolution preview. Full
// resolution is deferred (see ensureFullRes) so selecting feels instant.
async function loadEditor(item) {
  currentMedia = item;
  editItem = item;
  editThumb = null;
  editPreview = null;
  editImg = null;
  orientedCache = null; // new image — invalidate geometry cache
  orientedSig = "";
  document.getElementById("lightbox-name").textContent = item.name;

  const ext = (item.ext || "").toLowerCase();
  document.getElementById("lb-replace").hidden = ![
    "png",
    "jpg",
    "jpeg",
  ].includes(ext);

  const saved = await invoke("read_edits", { path: item.path });
  if (editItem !== item) return; // superseded by a newer selection
  editState = { ...defaultEdits(), ...saved };
  editDirty = false;
  syncEditorControls();

  setEditStatus("Loading…");
  // QuickLook thumbnail of the original pixels — clean PNG, fast, OS-cached.
  const thumbPath = await invoke("quicklook_thumb", {
    path: item.path,
    size: THUMB_MAX,
  });
  const thumb = await loadImage(
    await invoke("read_image_data", { path: thumbPath }),
  );
  if (editItem !== item) return;
  editThumb = thumb;
  setEditStatus("");
  renderEditorPreview();
}

// Tear down the inline editor (no selection change). Refreshes the grid
// thumbnail if edits were made.
async function closeInlineEditor() {
  if (!activeItem) return;
  const dirty = editDirty;
  await flushEditSave();
  activeItem = null;
  document.getElementById("lightbox").hidden = true;
  moveEditor(document.getElementById("media-side-editor"));
  document.getElementById("media-side").hidden = true;
    document.getElementById("app-right").hidden = true;
    invoke("set_window_width", { width: Math.max(window.innerWidth - 320, 900) });

  editItem = null;
  editThumb = null;
  editImg = null;
  editPreview = null;
  editState = null;
  updateSelbar(); // editor closed — the batch bar may need to reappear
  if (dirty && mediaProjectPath) loadMedia(mediaProjectPath);
}

// Double-click (or the side "Lightbox" button): open the full-screen editor.
async function openLightbox(item) {
  if (!activeItem || activeItem.path !== item.path) {
    await selectOnly(item); // selects + loads the inline editor
  }
  if (!activeItem) return; // not an image — nothing to show
  moveEditor(document.getElementById("lb-stage"));
  document.getElementById("lightbox").hidden = false;
  renderEditorPreview(); // show the thumbnail immediately…
  const current = editItem;
  setEditStatus("Loading…");
  await ensureFullRes(); // …then upgrade to the ~2048px preview
  if (editItem === current) {
    setEditStatus("");
    renderEditorPreview();
  }
}

async function closeLightbox() {
  await flushEditSave();
  document.getElementById("lightbox").hidden = true;
  // Return the editor to the side column; keep editing inline if still selected.
  moveEditor(document.getElementById("media-side-editor"));
  if (activeItem) {
    renderEditorPreview();
  } else {
    editItem = null;
    editThumb = null;
    editImg = null;
    editPreview = null;
    editState = null;
  }
  if (mediaProjectPath) loadMedia(mediaProjectPath);
}

// Native file drag-and-drop → copy images into the active project's media/.
async function initDragDrop() {
  const { listen } = window.__TAURI__.event;
  const zone = document.getElementById("dropzone");
  const show = () => {
    // Ignore drags that originate from reordering a note card.
    if (draggingNoteId) return;
    if (activeProject) zone.hidden = false;
  };
  await listen("tauri://drag-enter", show);
  await listen("tauri://drag-over", show);
  await listen("tauri://drag-leave", () => (zone.hidden = true));
  await listen("tauri://drag-drop", async (e) => {
    zone.hidden = true;
    if (!activeProject || draggingNoteId) return;
    const paths = (e.payload && e.payload.paths) || [];
    if (!paths.length) return;
    try {
      const imported = await invoke("import_media", {
        projectPath: activeProject.path,
        files: paths,
      });
      if (imported.length) {
        selectTab("media");
        loadMedia(activeProject.path);
      }
    } catch (err) {
      console.error("Import failed:", err);
    }
  });
}

// --- Image editor (non-destructive, sidecar-backed) ------------------------

let editItem = null; // the MediaItem being edited
// Three tiers of the edit source, all of the *original* pixels (edits are
// applied on top via the shader). The editor renders from the smallest one
// that's loaded, upgrading as larger tiers arrive:
//   editThumb   — QuickLook thumbnail; loaded instantly on select (inline editor)
//   editPreview — ~2048px; loaded when the lightbox opens
//   editImg     — full resolution; loaded only for export / remove-background
let editThumb = null;
let editPreview = null;
let editImg = null;
let editState = null; // current adjustments
let editSaveTimer = null;
let editDirty = false; // true once an edit control has changed editState

// Longest side (px) for the inline thumbnail.
const THUMB_MAX = 768;


// The seven always-visible tonal sliders.
const TONAL = [
  { key: "exposure", label: "Exposure" },
  { key: "contrast", label: "Contrast" },
  { key: "saturation", label: "Saturation" },
  { key: "temperature", label: "Temperature" },
  { key: "tint", label: "Tint" },
  { key: "highlights", label: "Highlights" },
  { key: "shadows", label: "Shadows" },
];


// Cache the oriented (geometry-only) canvas; recompute just when geometry changes.
let orientedCache = null;
let orientedSig = "";
// Reused offscreen canvas for full-res export (avoids leaking WebGL contexts).
const exportGLCanvas = document.createElement("canvas");

// Oriented (geometry-only) canvas for `src`. The preview uses the downscaled
// copy; export passes the full-res image. Cache keyed by source + geometry, so
// a preview render is never reused for a full-res export (or vice versa).
function getOriented(src = editPreview, tag = "preview") {
  const sig = [
    tag,
    editState.rotate,
    editState.flipH,
    editState.flipV,
    editState.straighten,
  ].join("|");
  if (!orientedCache || sig !== orientedSig) {
    orientedCache = renderOriented(src, editState);
    orientedSig = sig;
  }
  return orientedCache;
}

function renderEditorPreview() {
  const src = previewSrc();
  if (!src) return;
  const oriented = getOriented(src, previewTag());
  const canvas = document.getElementById("editor-canvas");
  const wrap = document.getElementById("editor-canvas-wrap");
  const scale = Math.min(
    wrap.clientWidth / oriented.width,
    wrap.clientHeight / oriented.height,
    1,
  );
  canvas.width = Math.max(1, Math.round(oriented.width * scale));
  canvas.height = Math.max(1, Math.round(oriented.height * scale));
  glAdjust(canvas, oriented, editState);
  positionCrop();

  // Mirror the live edit onto the image's grid thumbnail (reusing the oriented
  // canvas we just built). Coalesced to one bake per frame.
  scheduleLiveThumb(oriented);
}

let liveThumbRaf = 0;
let liveThumbOriented = null;
function scheduleLiveThumb(oriented) {
  if (!activeItem) return;
  liveThumbOriented = oriented;
  if (liveThumbRaf) return;
  liveThumbRaf = requestAnimationFrame(() => {
    liveThumbRaf = 0;
    if (!activeItem || !editState || !liveThumbOriented) return;
    const tile = document.querySelector(
      `.mediatile[data-path="${CSS.escape(activeItem.path)}"]`,
    );
    if (!tile) return;
    const url = bakeThumbFromOriented(liveThumbOriented, editState);
    thumbCache.set(activeItem.path, url);
    tile.querySelector(".mediatile__img").src = url;
  });
}

// --- Crop overlay ----------------------------------------------------------

function currentCrop() {
  return editState.crop || { x: 0, y: 0, w: 1, h: 1 };
}

function positionCrop() {
  const canvas = document.getElementById("editor-canvas");
  const el = document.getElementById("crop");
  const c = currentCrop();
  el.style.left = `${c.x * canvas.width}px`;
  el.style.top = `${c.y * canvas.height}px`;
  el.style.width = `${c.w * canvas.width}px`;
  el.style.height = `${c.h * canvas.height}px`;
}

let cropDrag = null;
let suppressLightboxClick = false;

function onCropPointerDown(e) {
  const canvas = document.getElementById("editor-canvas");
  const c = currentCrop();
  cropDrag = {
    mode: e.target.dataset.h || "move",
    startX: e.clientX,
    startY: e.clientY,
    cw: canvas.width,
    ch: canvas.height,
    rect: {
      x: c.x * canvas.width,
      y: c.y * canvas.height,
      w: c.w * canvas.width,
      h: c.h * canvas.height,
    },
  };
  e.preventDefault();
  window.addEventListener("pointermove", onCropPointerMove);
  window.addEventListener("pointerup", onCropPointerUp);
}

function onCropPointerMove(e) {
  if (!cropDrag) return;
  const { cw, ch, mode } = cropDrag;
  const dx = e.clientX - cropDrag.startX;
  const dy = e.clientY - cropDrag.startY;
  const R = editState.cropAspect;
  const MIN = 24;
  let { x, y, w, h } = cropDrag.rect;

  if (mode === "move") {
    x = clamp(x + dx, 0, cw - w);
    y = clamp(y + dy, 0, ch - h);
  } else {
    let left = x;
    let top = y;
    let right = x + w;
    let bottom = y + h;
    if (mode.includes("w")) left = clamp(x + dx, 0, right - MIN);
    if (mode.includes("e")) right = clamp(x + w + dx, left + MIN, cw);
    if (mode.includes("n")) top = clamp(y + dy, 0, bottom - MIN);
    if (mode.includes("s")) bottom = clamp(y + h + dy, top + MIN, ch);

    if (R) {
      // Lock ratio: derive height from width, anchored to the dragged corner.
      let nw = right - left;
      let nh = nw / R;
      if (mode.includes("n")) top = bottom - nh;
      else bottom = top + nh;
      if (top < 0) {
        top = 0;
        nh = bottom - top;
        nw = nh * R;
        if (mode.includes("w")) left = right - nw;
        else right = left + nw;
      }
      if (bottom > ch) {
        bottom = ch;
        nh = bottom - top;
        nw = nh * R;
        if (mode.includes("w")) left = right - nw;
        else right = left + nw;
      }
    }
    x = left;
    y = top;
    w = right - left;
    h = bottom - top;
  }

  editState.crop = { x: x / cw, y: y / ch, w: w / cw, h: h / ch };
  positionCrop();
}

function onCropPointerUp() {
  window.removeEventListener("pointermove", onCropPointerMove);
  window.removeEventListener("pointerup", onCropPointerUp);
  cropDrag = null;
  // The synthetic click after a drag can land on the stage and would otherwise
  // trigger backdrop-close. Swallow it.
  suppressLightboxClick = true;
  scheduleEditsSave();
}

function highlightAspect(R) {
  document.querySelectorAll("[data-aspect]").forEach((b) => {
    const v = b.dataset.aspect === "free" ? null : Number(b.dataset.aspect);
    b.classList.toggle("is-active", v === R);
  });
}

function applyAspect(R) {
  editState.cropAspect = R;
  if (R) {
    const canvas = document.getElementById("editor-canvas");
    const cw = canvas.width;
    const ch = canvas.height;
    let w, h;
    if (cw / ch > R) {
      h = ch;
      w = ch * R;
    } else {
      w = cw;
      h = cw / R;
    }
    editState.crop = {
      x: (cw - w) / 2 / cw,
      y: (ch - h) / 2 / ch,
      w: w / cw,
      h: h / ch,
    };
  }
  positionCrop();
  highlightAspect(R);
  scheduleEditsSave();
}

function resetCrop() {
  editState.crop = null;
  editState.cropAspect = null;
  positionCrop();
  highlightAspect(null);
  scheduleEditsSave();
}

// --- Copy / paste adjustments ----------------------------------------------

const ADJ_FIELDS = [
  "rotate",
  "flipH",
  "flipV",
  "straighten",
  "crop",
  "cropAspect",
  "exposure",
  "contrast",
  "saturation",
  "temperature",
  "tint",
  "highlights",
  "shadows",
];

let copiedEdits = null;

function loadCopiedEdits() {
  try {
    copiedEdits = JSON.parse(
      localStorage.getItem("studio_copied_edits") || "null",
    );
  } catch {
    copiedEdits = null;
  }
}

function copyAdjustments() {
  const snap = {};
  for (const k of ADJ_FIELDS) snap[k] = editState[k];
  copiedEdits = JSON.parse(JSON.stringify(snap));
  localStorage.setItem("studio_copied_edits", JSON.stringify(copiedEdits));
  document.getElementById("m-pasteadj").disabled = false;
  setEditStatus("Copied ✓");
}

async function pasteAdjustments() {
  if (!copiedEdits || !editState) return;
  for (const f of ADJ_FIELDS) {
    if (f in copiedEdits) editState[f] = copiedEdits[f];
  }
  orientedCache = null; // geometry may have changed
  orientedSig = "";
  syncEditorControls();
  renderEditorPreview();

  // Optimistic: bake a thumbnail from the already-loaded preview source and show
  // it on the tile right away, so the grid reflects the paste with no blank gap.
  const src = previewSrc();
  const tile = document.querySelector(
    `.mediatile[data-path="${CSS.escape(editItem.path)}"]`,
  );
  if (src && tile) {
    const url = bakeThumbDataURL(src, editState);
    thumbCache.set(editItem.path, url);
    tile.querySelector(".mediatile__img").src = url;
  }

  // Persist; the background re-bake (full-res) swaps in seamlessly via loadMedia.
  editDirty = true;
  await flushEditSave();
  if (mediaProjectPath) loadMedia(mediaProjectPath);
  setEditStatus("Pasted ✓");
}

function setEditStatus(text) {
  document.getElementById("edit-status").textContent = text;
}

function scheduleEditsSave() {
  if (!editItem) return;
  editDirty = true;
  setEditStatus("Saving…");
  clearTimeout(editSaveTimer);
  editSaveTimer = setTimeout(async () => {
    try {
      await invoke("save_edits", { path: editItem.path, edits: editState });
      setEditStatus("Saved ✓");
    } catch (err) {
      setEditStatus(`Error: ${err}`);
    }
  }, 400);
}

function buildTonalSliders() {
  const container = document.getElementById("tonal-sliders");
  container.innerHTML = "";
  for (const { key, label } of TONAL) {
    const row = el("div", "sliderrow");
    const head = el("div", "sliderrow__head");
    head.append(el("span", null, { textContent: label }));
    const val = el("em", "sliderrow__val", { textContent: "0" });
    head.append(val);
    const input = el("input", "slider", {
      type: "range",
      min: "-100",
      max: "100",
      step: "1",
      value: "0",
    });
    input.dataset.key = key;
    input.addEventListener("input", () => {
      editState[key] = Number(input.value);
      val.textContent = input.value;
      renderEditorPreview();
      scheduleEditsSave();
    });
    row.append(head, input);
    container.append(row);
  }
}

function syncEditorControls() {
  document.getElementById("ed-straighten").value = editState.straighten || 0;
  document.getElementById("ed-straighten-val").textContent =
    `${editState.straighten || 0}°`;
  highlightAspect(editState.cropAspect ?? null);
  document.querySelectorAll("#tonal-sliders input[data-key]").forEach((inp) => {
    const v = editState[inp.dataset.key] || 0;
    inp.value = v;
    inp.previousElementSibling.querySelector(".sliderrow__val").textContent = v;
  });
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

async function exportEdited(replace) {
  if (!editItem) return;
  await ensureFullRes();
  const oriented = getOriented(editImg, "full"); // geometry, full resolution
  const ext = (editItem.ext || "png").toLowerCase();
  const jpeg = ext === "jpg" || ext === "jpeg";
  const mime = jpeg ? "image/jpeg" : "image/png";
  const outExt = jpeg ? "jpg" : "png";

  // Apply tonal adjustments at full resolution via the shader.
  exportGLCanvas.width = oriented.width;
  exportGLCanvas.height = oriented.height;
  glAdjust(exportGLCanvas, oriented, editState);

  // Apply crop (fractions of the oriented image).
  let out = exportGLCanvas;
  const c = editState.crop;
  if (c && (c.x > 0 || c.y > 0 || c.w < 1 || c.h < 1)) {
    const sx = Math.round(c.x * exportGLCanvas.width);
    const sy = Math.round(c.y * exportGLCanvas.height);
    const sw = Math.max(1, Math.round(c.w * exportGLCanvas.width));
    const sh = Math.max(1, Math.round(c.h * exportGLCanvas.height));
    const cropped = document.createElement("canvas");
    cropped.width = sw;
    cropped.height = sh;
    cropped
      .getContext("2d")
      .drawImage(exportGLCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    out = cropped;
  }

  try {
    const blob = await new Promise((res) => out.toBlob(res, mime, 0.92));
    const b64 = await blobToBase64(blob);
    const dest = replace
      ? editItem.path
      : editItem.path.replace(/\.[^/.]+$/, "") + "-edited." + outExt;
    await invoke("write_image", { path: dest, dataBase64: b64 });
    invalidateThumb(editItem.path);
    if (replace) {
      // Edits are now baked into the file — reset the sidecar so they aren't
      // re-applied on top of the baked pixels, and reload from the new file.
      editState = defaultEdits();
      editDirty = false;
      orientedCache = null;
      orientedSig = "";
      await invoke("save_edits", { path: editItem.path, edits: editState });
      syncEditorControls();
      editThumb = null;
      editImg = null;
      editPreview = null;
      try {
        editImg = await loadImage(
          await invoke("read_image_data", { path: editItem.path }),
        );
        editPreview = makePreview(editImg);
      } catch (err) {
        console.error("Reload after replace failed:", err);
      }
      renderEditorPreview();
    }
    setEditStatus(replace ? "Replaced ✓" : "Exported ✓");
    if (mediaProjectPath) loadMedia(mediaProjectPath);
  } catch (err) {
    setEditStatus(`Error: ${err}`);
  }
}

// --- Export (single + batch): format / max size / quality ------------------

const webGLCanvas = document.createElement("canvas");
let webExportCtx = null;
const webSettings = { format: "webp", maxDim: 1280, quality: 82 };

// Output filename. At Original size (longSide null) it's a clean `name.ext`;
// resized exports append the size. Avoids overwriting the source file.
function webName(path, fmt, longSide) {
  const ext = fmt === "png" ? "png" : fmt === "jpeg" ? "jpg" : "webp";
  const base = path.replace(/\.[^/.]+$/, "");
  let dest = longSide ? `${base}x${longSide}.${ext}` : `${base}.${ext}`;
  if (dest === path) dest = `${base}-export.${ext}`; // don't clobber the original
  return dest;
}

function cropToCanvas(oriented, crop) {
  if (crop && (crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1)) {
    const sx = Math.round(crop.x * oriented.width);
    const sy = Math.round(crop.y * oriented.height);
    const sw = Math.max(1, Math.round(crop.w * oriented.width));
    const sh = Math.max(1, Math.round(crop.h * oriented.height));
    const cc = document.createElement("canvas");
    cc.width = sw;
    cc.height = sh;
    cc.getContext("2d").drawImage(oriented, sx, sy, sw, sh, 0, 0, sw, sh);
    return cc;
  }
  return oriented;
}

// Bake an image (geometry + crop + tonal) and resize → final canvas.
function bakeCanvas(img, edits, settings) {
  const oriented = renderOriented(img, edits);
  const cropped = cropToCanvas(oriented, edits.crop);

  webGLCanvas.width = cropped.width;
  webGLCanvas.height = cropped.height;
  glAdjust(webGLCanvas, cropped, edits);

  const md = settings.maxDim;
  if (md && Math.max(webGLCanvas.width, webGLCanvas.height) > md) {
    const s = md / Math.max(webGLCanvas.width, webGLCanvas.height);
    const rw = Math.max(1, Math.round(webGLCanvas.width * s));
    const rh = Math.max(1, Math.round(webGLCanvas.height * s));
    const rc = document.createElement("canvas");
    rc.width = rw;
    rc.height = rh;
    const ctx = rc.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(webGLCanvas, 0, 0, rw, rh);
    return rc;
  }
  return webGLCanvas;
}

function canvasToBase64(canvas, mime, q) {
  return new Promise((resolve) =>
    canvas.toBlob(async (b) => resolve(await blobToBase64(b)), mime, q),
  );
}

function base64Size(b64) {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

// Encode a baked canvas to the chosen format → { b64, size }.
// JPG/PNG use the canvas; WebP is encoded in Rust (WKWebView can't do WebP).
async function encodeFinal(canvas, settings) {
  if (settings.format === "webp") {
    const pngB64 = await canvasToBase64(canvas, "image/png");
    const webpB64 = await invoke("encode_webp", {
      pngBase64: pngB64,
      quality: settings.quality,
    });
    return { b64: webpB64, size: base64Size(webpB64) };
  }
  const mime = settings.format === "png" ? "image/png" : "image/jpeg";
  const blob = await new Promise((res) =>
    canvas.toBlob(res, mime, settings.quality / 100),
  );
  return { b64: await blobToBase64(blob), size: blob.size };
}

function highlightFmt() {
  document
    .querySelectorAll("#webexport [data-fmt]")
    .forEach((b) =>
      b.classList.toggle("is-active", b.dataset.fmt === webSettings.format),
    );
  document.getElementById("web-quality-field").style.display =
    webSettings.format === "png" ? "none" : "";
}

function openWebExport(ctx) {
  webExportCtx = ctx;
  highlightFmt();
  document.getElementById("web-maxdim").value = String(webSettings.maxDim);
  document.getElementById("web-quality").value = webSettings.quality;
  document.getElementById("web-quality-val").textContent = webSettings.quality;
  document.getElementById("web-context").textContent =
    ctx.mode === "batch" ? `${ctx.items.length} images` : ctx.items[0].name;
  document.getElementById("webexport").hidden = false;
}

function closeWebExport() {
  document.getElementById("webexport").hidden = true;
  webExportCtx = null;
}

// Close the dialog immediately and run the export in the background.
function doWebExport() {
  if (!webExportCtx) return;
  const ctx = webExportCtx;
  const settings = { ...webSettings };
  closeWebExport();
  runWebExport(ctx, settings);
}

async function runWebExport(ctx, settings) {
  try {
    if (ctx.mode === "single") {
      const it = ctx.items[0];
      const canvas = bakeCanvas(it.img, it.edits, settings);
      const long = settings.maxDim
        ? Math.max(canvas.width, canvas.height)
        : null;
      const { b64 } = await encodeFinal(canvas, settings);
      await invoke("write_image", {
        path: webName(it.path, settings.format, long),
        dataBase64: b64,
      });
    } else {
      for (const it of ctx.items) {
        const img = await loadImage(
          await invoke("read_image_data", { path: it.path }),
        );
        const edits = {
          ...defaultEdits(),
          ...(await invoke("read_edits", { path: it.path })),
        };
        const canvas = bakeCanvas(img, edits, settings);
        const long = settings.maxDim
          ? Math.max(canvas.width, canvas.height)
          : null;
        const { b64 } = await encodeFinal(canvas, settings);
        await invoke("write_image", {
          path: webName(it.path, settings.format, long),
          dataBase64: b64,
        });
      }
    }
    if (mediaProjectPath) loadMedia(mediaProjectPath);
  } catch (err) {
    console.error("Web export failed:", err);
  }
}

// Open the Export dialog for the image currently in the editor.
async function exportCurrent() {
  if (!editItem) return;
  await ensureFullRes(); // single-mode export bakes from the full-res image
  openWebExport({
    mode: "single",
    items: [
      {
        path: editItem.path,
        name: editItem.name,
        edits: editState,
        img: editImg,
      },
    ],
  });
}

function initWebExport() {
  document
    .getElementById("lb-webexport")
    .addEventListener("click", exportCurrent);
  document.getElementById("sel-webexport").addEventListener("click", () => {
    if (!mediaSelection.size()) return;
    openWebExport({
      mode: "batch",
      items: mediaSelection.get().map((p) => ({
        path: p,
        name: p.split("/").pop(),
      })),
    });
  });
  document.querySelectorAll("#webexport [data-fmt]").forEach((b) =>
    b.addEventListener("click", () => {
      webSettings.format = b.dataset.fmt;
      highlightFmt();
    }),
  );
  document.getElementById("web-maxdim").addEventListener("change", (e) => {
    webSettings.maxDim = Number(e.target.value);
  });
  document.getElementById("web-quality").addEventListener("input", (e) => {
    webSettings.quality = Number(e.target.value);
    document.getElementById("web-quality-val").textContent = e.target.value;
  });
  document
    .getElementById("web-cancel")
    .addEventListener("click", closeWebExport);
  document.getElementById("web-export").addEventListener("click", doWebExport);
}

// --- Remove background (local WASM segmentation) ---------------------------

let cutoutB64 = null;
let cutoutSourcePath = null;

async function removeBg() {
  if (!editItem) return;
  await ensureFullRes();
  const btn = document.getElementById("ed-removebg");
  btn.disabled = true;
  setEditStatus("Removing background…");
  try {
    // Bake at full resolution, hand the PNG to the native ISNet command.
    const canvas = bakeCanvas(editImg, editState, {
      maxDim: 0,
      format: "png",
      quality: 100,
    });
    const pngB64 = await canvasToBase64(canvas, "image/png");
    cutoutB64 = await invoke("remove_background", { pngBase64: pngB64 });
    cutoutSourcePath = editItem.path;
    document.getElementById("cutout-img").src =
      `data:image/png;base64,${cutoutB64}`;
    document.getElementById("cutout").hidden = false;
    setEditStatus("");
  } catch (err) {
    console.error("Background removal failed:", err);
    setEditStatus(`BG failed: ${err}`);
  } finally {
    btn.disabled = false;
  }
}

async function saveCutout() {
  if (!cutoutB64 || !cutoutSourcePath) return;
  const dest = cutoutSourcePath.replace(/\.[^/.]+$/, "") + "-cutout.png";
  try {
    await invoke("write_image", { path: dest, dataBase64: cutoutB64 });
    document.getElementById("cutout").hidden = true;
    cutoutB64 = null;
    if (mediaProjectPath) loadMedia(mediaProjectPath);
  } catch (err) {
    console.error("Saving cutout failed:", err);
  }
}

function initRemoveBg() {
  document.getElementById("ed-removebg").addEventListener("click", removeBg);
  document.getElementById("cutout-save").addEventListener("click", saveCutout);
  document.getElementById("cutout-cancel").addEventListener("click", () => {
    document.getElementById("cutout").hidden = true;
    cutoutB64 = null;
  });
}

// --- Extend background (PatchMatch outpaint) -------------------------------

let exBase = null; // standalone canvas of the current edited image, full-res
let exMargins = { l: 0, r: 0, t: 0, b: 0 }; // px added per side, base-image space
let exRatio = null; // locked aspect (w/h) or null = free drag
let exRatioBase = null; // selected base ratio (>=1, landscape) or null = Free
let exOrient = "landscape"; // "landscape" | "portrait"
let exFinal = null; // composited result canvas after Fill (or null)
let exScale = 1; // stage px per image px
let exDrag = null;
let exMethod = null; // "patch" | "simple" | "color" — the last fill used
let exColor = "#cccccc"; // Color Fill colour (defaults to corner average)
let exHasAlpha = false; // whether the current image has transparent pixels

// True if any pixel in the canvas is not fully opaque.
function canvasHasAlpha(cv) {
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

const exTargetW = () => exBase.width + exMargins.l + exMargins.r;
const exTargetH = () => exBase.height + exMargins.t + exMargins.b;

// Average colour of the image's four corners (small sampled blocks) as #rrggbb.
function cornerAverage(cv) {
  const ctx = cv.getContext("2d");
  const s = Math.max(1, Math.round(Math.min(cv.width, cv.height) * 0.03));
  const corners = [
    [0, 0],
    [cv.width - s, 0],
    [0, cv.height - s],
    [cv.width - s, cv.height - s],
  ];
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (const [x, y] of corners) {
    const d = ctx.getImageData(x, y, s, s).data;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      n++;
    }
  }
  const hex = (v) =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// Select a fill method: highlight its button, show its options, and run it.
function selectFillMethod(method, btnId, run) {
  exMethod = method;
  document
    .querySelectorAll(".extend__fillbtn")
    .forEach((b) => b.classList.toggle("is-active", b.id === btnId));
  document.getElementById("opt-simple").hidden = method !== "simple";
  document.getElementById("opt-color").hidden = method !== "color";
  document.getElementById("extend-options").hidden =
    method !== "simple" && method !== "color";
  run();
}

// Re-run the active method when its options (sliders / colour) change.
function rerunActiveMethod() {
  if (exMethod === "simple") extendFillSimple();
  else if (exMethod === "color") extendFillColor();
}

async function openExtend() {
  if (!editItem) return;
  await ensureFullRes();
  // Bake the current edits to a standalone full-res canvas (bakeCanvas returns
  // a shared canvas, so copy it).
  const baked = bakeCanvas(editImg, editState, {
    maxDim: 0,
    format: "png",
    quality: 100,
  });
  exBase = document.createElement("canvas");
  exBase.width = baked.width;
  exBase.height = baked.height;
  exBase.getContext("2d").drawImage(baked, 0, 0);
  exHasAlpha = canvasHasAlpha(exBase);

  exMargins = { l: 0, r: 0, t: 0, b: 0 };
  exRatio = null;
  exRatioBase = null;
  exOrient = "landscape";
  exFinal = null;
  exMethod = null;
  setExtendReady(false);
  document.getElementById("extend-status").textContent = "";
  document
    .querySelectorAll("#extend-ratios .chip")
    .forEach((c) =>
      c.classList.toggle("is-active", c.dataset.ratio === "free"),
    );
  document
    .querySelectorAll("#extend-orient .orient-btn")
    .forEach((b) =>
      b.classList.toggle("is-active", b.dataset.orient === "landscape"),
    );
  // Reset fill-method selection + options.
  document
    .querySelectorAll(".extend__fillbtn")
    .forEach((b) => b.classList.remove("is-active"));
  document.getElementById("extend-options").hidden = true;
  // Seed Color Fill with the image's corner-average colour.
  exColor = cornerAverage(exBase);
  document.getElementById("extend-color").value = exColor;
  document.getElementById("extend-color-sw").style.background = exColor;
  document.getElementById("extend").hidden = false;
  renderExtend();
}

// Apply the selected base ratio under the current orientation (portrait inverts
// it). Free selection (null base) leaves the canvas free-form.
function applyOrientedRatio() {
  if (exRatioBase == null) {
    applyExtendRatio(null);
    return;
  }
  applyExtendRatio(exOrient === "portrait" ? 1 / exRatioBase : exRatioBase);
}

function applyExtendRatio(r) {
  exRatio = r;
  if (r) {
    let tw = exBase.width;
    let th = exBase.height;
    if (tw / th < r) tw = Math.round(th * r);
    else th = Math.round(tw / r);
    const ml = Math.floor((tw - exBase.width) / 2);
    const mt = Math.floor((th - exBase.height) / 2);
    exMargins = {
      l: ml,
      r: tw - exBase.width - ml,
      t: mt,
      b: th - exBase.height - mt,
    };
  }
  exFinal = null;
  setExtendReady(false);
  renderExtend();
}

function renderExtend() {
  const stage = document.getElementById("extend-stage");
  const frame = document.getElementById("extend-frame");
  const canvas = document.getElementById("extend-canvas");
  const tw = exTargetW();
  const th = exTargetH();
  exScale = Math.min(stage.clientWidth / tw, stage.clientHeight / th, 1);
  const dw = Math.max(1, Math.round(tw * exScale));
  const dh = Math.max(1, Math.round(th * exScale));
  frame.style.width = `${dw}px`;
  frame.style.height = `${dh}px`;
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, dw, dh);
  if (exFinal) {
    ctx.drawImage(exFinal, 0, 0, dw, dh);
  } else {
    ctx.drawImage(
      exBase,
      exMargins.l * exScale,
      exMargins.t * exScale,
      exBase.width * exScale,
      exBase.height * exScale,
    );
  }
}

function exPointerDown(e) {
  e.preventDefault();
  exDrag = {
    handle: e.target.dataset.h,
    sx: e.clientX,
    sy: e.clientY,
    m0: { ...exMargins },
    tw0: exTargetW(),
  };
  window.addEventListener("pointermove", exPointerMove);
  window.addEventListener("pointerup", exPointerUp);
}

function exPointerMove(e) {
  if (!exDrag) return;
  const dx = (e.clientX - exDrag.sx) / exScale;
  const dy = (e.clientY - exDrag.sy) / exScale;
  const h = exDrag.handle;

  if (exRatio) {
    // Keep the locked ratio: extend symmetrically around the center, driven by
    // whichever axis the handle moved most.
    const cands = [];
    if (h.includes("e")) cands.push(dx);
    if (h.includes("w")) cands.push(-dx);
    if (h.includes("s")) cands.push(dy);
    if (h.includes("n")) cands.push(-dy);
    const d = cands.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    let tw = Math.max(exBase.width, Math.round(exDrag.tw0 + 2 * d));
    let th = Math.round(tw / exRatio);
    if (th < exBase.height) {
      th = exBase.height;
      tw = Math.round(th * exRatio);
    }
    const ml = Math.floor((tw - exBase.width) / 2);
    const mt = Math.floor((th - exBase.height) / 2);
    exMargins = {
      l: ml,
      r: tw - exBase.width - ml,
      t: mt,
      b: th - exBase.height - mt,
    };
  } else {
    const m = { ...exDrag.m0 };
    if (h.includes("e")) m.r = Math.max(0, Math.round(exDrag.m0.r + dx));
    if (h.includes("w")) m.l = Math.max(0, Math.round(exDrag.m0.l - dx));
    if (h.includes("s")) m.b = Math.max(0, Math.round(exDrag.m0.b + dy));
    if (h.includes("n")) m.t = Math.max(0, Math.round(exDrag.m0.t - dy));
    exMargins = m;
  }
  exFinal = null;
  setExtendReady(false);
  renderExtend();
}

function exPointerUp() {
  exDrag = null;
  window.removeEventListener("pointermove", exPointerMove);
  window.removeEventListener("pointerup", exPointerUp);
}

// A copy of `base` whose alpha ramps to 0 over `feather` px on each *extended*
// side, so it cross-fades into the synthesized fill rather than meeting it at a
// hard edge. Sides with no margin (the image's real edges) stay fully opaque.
function featheredOriginal(base, m, feather) {
  const c = document.createElement("canvas");
  c.width = base.width;
  c.height = base.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(base, 0, 0);
  if (feather <= 0) return c;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      let a = 1;
      if (m.l > 0) a = Math.min(a, x / feather);
      if (m.r > 0) a = Math.min(a, (c.width - 1 - x) / feather);
      if (m.t > 0) a = Math.min(a, y / feather);
      if (m.b > 0) a = Math.min(a, (c.height - 1 - y) / feather);
      if (a < 1)
        d[(y * c.width + x) * 4 + 3] = Math.round(Math.max(0, a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Shared fill flow. `engine(workPngB64, tw, th)` returns the filled PNG (base64)
// for the enlarged canvas; the original is feathered back on top to hide seams.
async function runExtendFill(engine, cap) {
  if (!exBase) return;
  // Color Fill is allowed with no extension (it backs a transparent image);
  // the others need actual margins to synthesize.
  if (
    exMargins.l + exMargins.r + exMargins.t + exMargins.b === 0 &&
    exMethod !== "color"
  ) {
    document.getElementById("extend-status").textContent = "Nothing to extend";
    return;
  }
  const tw = exTargetW();
  const th = exTargetH();
  const status = document.getElementById("extend-status");
  const fillBtns = document.querySelectorAll(".extend__fillbtn");
  status.textContent = "Filling…";
  fillBtns.forEach((b) => (b.disabled = true));
  try {
    // Compose the enlarged canvas at a capped working resolution, leaving the
    // new margins transparent (alpha 0) for the engine to synthesize.
    const ws = Math.min(1, cap / Math.max(tw, th));
    const wW = Math.max(1, Math.round(tw * ws));
    const wH = Math.max(1, Math.round(th * ws));
    const work = document.createElement("canvas");
    work.width = wW;
    work.height = wH;
    const wctx = work.getContext("2d");
    wctx.imageSmoothingQuality = "high";
    wctx.clearRect(0, 0, wW, wH);
    wctx.drawImage(
      exBase,
      Math.round(exMargins.l * ws),
      Math.round(exMargins.t * ws),
      Math.round(exBase.width * ws),
      Math.round(exBase.height * ws),
    );
    const filledB64 = await engine(work);
    const clean = filledB64.includes(",") ? filledB64.split(",")[1] : filledB64;
    const filledImg = await loadImage(`data:image/png;base64,${clean}`);

    // Final full-res: upscaled synthesized fill, with the crisp original
    // feathered on top so it cross-fades into the fill (hides the seam).
    const final = document.createElement("canvas");
    final.width = tw;
    final.height = th;
    const fctx = final.getContext("2d");
    fctx.imageSmoothingQuality = "high";
    fctx.drawImage(filledImg, 0, 0, tw, th);
    // Composite the original on top. Feather its edges into the fill to hide the
    // seam — except for Color Fill on a transparent image, where feathering
    // would fade the cutout's own edges into the colour (a halo).
    if (exMethod === "color" && exHasAlpha) {
      fctx.drawImage(exBase, exMargins.l, exMargins.t);
    } else {
      const feather = Math.min(
        64,
        Math.max(6, Math.round(Math.min(exBase.width, exBase.height) * 0.04)),
      );
      fctx.drawImage(
        featheredOriginal(exBase, exMargins, feather),
        exMargins.l,
        exMargins.t,
      );
    }
    exFinal = final;

    status.textContent = "Filled ✓";
    setExtendReady(true);
    renderExtend();
  } catch (err) {
    console.error("extend fill failed:", err);
    status.textContent = `Fill failed: ${err}`;
  } finally {
    fillBtns.forEach((b) => (b.disabled = false));
  }
}

// "Fill" — content-aware PatchMatch; best for plain backgrounds.
function extendFill() {
  return runExtendFill(
    (work) =>
      invoke("extend_background", {
        pngBase64: work.toDataURL("image/png").split(",")[1],
      }),
    1536,
  );
}

// "Simple Fill" — extend each edge by stretching its border pixels outward,
// then blur the result so the margin reads as a soft continuation. All on the
// canvas (no backend). The crisp original is feathered back on top in runExtendFill.
function extendFillSimple() {
  return runExtendFill(async (work) => {
    const wW = work.width;
    const wH = work.height;
    // Opaque bounding box of the original within the work canvas.
    const d = work.getContext("2d").getImageData(0, 0, wW, wH).data;
    let x0 = wW,
      y0 = wH,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < wH; y++) {
      for (let x = 0; x < wW; x++) {
        if (d[(y * wW + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < x0) return work.toDataURL("image/png").split(",")[1];
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;

    const out = document.createElement("canvas");
    out.width = wW;
    out.height = wH;
    const o = out.getContext("2d");
    o.drawImage(work, 0, 0);
    // Stretch left/right edge columns across the side margins.
    if (x0 > 0) o.drawImage(work, x0, y0, 1, bh, 0, y0, x0, bh);
    if (x1 < wW - 1)
      o.drawImage(work, x1, y0, 1, bh, x1 + 1, y0, wW - 1 - x1, bh);
    // Stretch top/bottom rows across full width (covers corners too).
    if (y0 > 0) o.drawImage(out, 0, y0, wW, 1, 0, 0, wW, y0);
    if (y1 < wH - 1) o.drawImage(out, 0, y1, wW, 1, 0, y1 + 1, wW, wH - 1 - y1);

    // Blur the streaky stretch into a soft wash. Amount = Blur slider (% of the
    // working size).
    const blurPct = Number(document.getElementById("extend-blur").value);
    const blurred = document.createElement("canvas");
    blurred.width = wW;
    blurred.height = wH;
    const b = blurred.getContext("2d");
    b.filter = `blur(${Math.round((Math.min(wW, wH) * blurPct) / 100)}px)`;
    b.drawImage(out, 0, 0);

    // Add fine noise (Noise slider) so the flat blur isn't plasticky / banded.
    const img = b.getImageData(0, 0, wW, wH);
    const px = img.data;
    const amp = Number(document.getElementById("extend-noise").value);
    for (let i = 0; i < px.length; i += 4) {
      const n = (Math.random() - 0.5) * 2 * amp;
      px[i] = Math.max(0, Math.min(255, px[i] + n));
      px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + n));
      px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + n));
    }
    b.putImageData(img, 0, 0);
    return blurred.toDataURL("image/png").split(",")[1];
  }, 1024);
}

// "Color Fill" — fill the margins with a solid colour (exColor).
function extendFillColor() {
  return runExtendFill(async (work) => {
    const c = document.createElement("canvas");
    c.width = work.width;
    c.height = work.height;
    const ctx = c.getContext("2d");
    ctx.fillStyle = exColor;
    ctx.fillRect(0, 0, c.width, c.height);
    return c.toDataURL("image/png").split(",")[1];
  }, 512);
}

// Generative (Stable Diffusion outpaint) fill via the A1111 HTTP API.
function extendFillSD() {
  return runExtendFill(sdEngine, 1024);
}

// Build the init image (margins pre-filled) + mask (margins white) from the
// transparent-margin work canvas, then ask the SD API to outpaint.
async function sdEngine(work) {
  const wW = work.width;
  const wH = work.height;

  // Init: a stretched copy of the original as a plausible base, with the
  // correctly-placed original composited crisply on top.
  const init = document.createElement("canvas");
  init.width = wW;
  init.height = wH;
  const ictx = init.getContext("2d");
  ictx.imageSmoothingQuality = "high";
  ictx.drawImage(exBase, 0, 0, wW, wH); // blurry edge-to-edge backdrop
  ictx.drawImage(work, 0, 0); // original region on top (margins are transparent)

  // Mask: white where the work canvas is transparent (the new margins).
  const wd = work.getContext("2d").getImageData(0, 0, wW, wH).data;
  const mask = document.createElement("canvas");
  mask.width = wW;
  mask.height = wH;
  const mctx = mask.getContext("2d");
  const md = mctx.createImageData(wW, wH);
  for (let i = 0; i < wW * wH; i++) {
    const v = wd[i * 4 + 3] < 128 ? 255 : 0;
    md.data[i * 4] = v;
    md.data[i * 4 + 1] = v;
    md.data[i * 4 + 2] = v;
    md.data[i * 4 + 3] = 255;
  }
  mctx.putImageData(md, 0, 0);

  return invoke("sd_outpaint", {
    initBase64: init.toDataURL("image/png").split(",")[1],
    maskBase64: mask.toDataURL("image/png").split(",")[1],
    prompt: document.getElementById("extend-prompt").value.trim(),
    negativePrompt: "",
    width: wW,
    height: wH,
    steps: 20,
  });
}

let exLastSaved = null; // path of the most recently saved extended image

// Enable Save once a fill is ready; hide the post-save "Edit in Photos" until
// the next save.
function setExtendReady(ready) {
  document.getElementById("extend-save").disabled = !ready;
  if (!ready) document.getElementById("extend-edit-photos").hidden = true;
}

// Write the extended image to <name>-extended.png; returns the path (or null).
async function writeExtended() {
  if (!exFinal || !editItem) return null;
  const dest = editItem.path.replace(/\.[^/.]+$/, "") + "-extended.png";
  try {
    const b64 = exFinal.toDataURL("image/png").split(",")[1];
    await invoke("write_image", { path: dest, dataBase64: b64 });
    return dest;
  } catch (err) {
    console.error("Saving extended image failed:", err);
    document.getElementById("extend-status").textContent = "Save failed";
    return null;
  }
}

// Save, then reveal an "Edit in Photos" button (modal stays open).
async function extendSave() {
  const dest = await writeExtended();
  if (!dest) return;
  exLastSaved = dest;
  if (mediaProjectPath) loadMedia(mediaProjectPath);
  document.getElementById("extend-status").textContent = "Saved ✓";
  document.getElementById("extend-edit-photos").hidden = false;
}

// Open the just-saved extended image in the Photos Edit panel.
async function extendEditInPhotos() {
  if (!exLastSaved) return;
  document.getElementById("extend-status").textContent = "Opening in Photos…";
  try {
    await invoke("open_in_photos", { path: exLastSaved });
    document.getElementById("extend").hidden = true;
  } catch (err) {
    console.error("Open in Photos failed:", err);
    document.getElementById("extend-status").textContent = `Photos: ${err}`;
  }
}

// Import the current image into Photos and open it in Edit (Background group /
// More menu shortcut).
async function editInPhotos() {
  if (!editItem) return;
  setEditStatus("Opening in Photos…");
  try {
    await invoke("open_in_photos", { path: editItem.path });
    setEditStatus("");
  } catch (err) {
    console.error("Open in Photos failed:", err);
    setEditStatus(`Photos: ${err}`);
  }
}

// --- Generate image (Image Playground via Shortcut) ------------------------

// Shortcut names (build these in the Shortcuts app):
//   text  → receives Shortcut Input (the prompt), runs Image Playground, returns image
//   photo → receives Shortcut Input (the image) + reads the prompt from the
//           clipboard, runs Image Playground, returns image
const GEN_SHORTCUT_TEXT = "Studio Generate";
const GEN_SHORTCUT_PHOTO = "Studio Generate From Photo";

function openGenerate() {
  if (!activeProject) return;
  document.getElementById("generate-prompt").value = "";
  document.getElementById("generate-status").textContent = "";
  // Offer "use selected image" only when a single image is selected.
  const seedable = !!(activeItem && activeItem.kind === "image");
  document.getElementById("generate-seed-row").hidden = !seedable;
  document.getElementById("generate-seed").checked = false;
  document.getElementById("generate").hidden = false;
  document.getElementById("generate-prompt").focus();
}

async function runGenerate() {
  if (!activeProject) return;
  const prompt = document.getElementById("generate-prompt").value.trim();
  const seed =
    document.getElementById("generate-seed").checked &&
    activeItem &&
    activeItem.kind === "image";
  if (!prompt && !seed) {
    document.getElementById("generate-status").textContent = "Enter a prompt";
    return;
  }

  const out = `${activeProject.path}/media/generated-${Date.now()}.png`;
  const status = document.getElementById("generate-status");
  const btn = document.getElementById("generate-run");
  status.textContent = "Generating…";
  btn.disabled = true;
  try {
    if (seed) {
      await invoke("run_shortcut", {
        name: GEN_SHORTCUT_PHOTO,
        inputPath: activeItem.path,
        clipboardText: prompt,
        outputPath: out,
      });
    } else {
      await invoke("run_shortcut", {
        name: GEN_SHORTCUT_TEXT,
        inputText: prompt,
        outputPath: out,
      });
    }
    document.getElementById("generate").hidden = true;
    if (mediaProjectPath) loadMedia(mediaProjectPath);
  } catch (err) {
    console.error("Generate failed:", err);
    status.textContent = `Failed: ${err}`;
  } finally {
    btn.disabled = false;
  }
}

function initGenerate() {
  document.getElementById("generate-open").addEventListener("click", openGenerate);
  document.getElementById("generate-run").addEventListener("click", runGenerate);
  document
    .getElementById("generate-cancel")
    .addEventListener(
      "click",
      () => (document.getElementById("generate").hidden = true),
    );
}

function initExtend() {
  document.getElementById("ed-extendbg").addEventListener("click", openExtend);
  document.getElementById("ed-photos").addEventListener("click", editInPhotos);
  document
    .getElementById("extend-fill")
    .addEventListener("click", () =>
      selectFillMethod("patch", "extend-fill", extendFill),
    );
  document
    .getElementById("extend-fill-simple")
    .addEventListener("click", () =>
      selectFillMethod("simple", "extend-fill-simple", extendFillSimple),
    );
  document
    .getElementById("extend-fill-color")
    .addEventListener("click", () =>
      selectFillMethod("color", "extend-fill-color", extendFillColor),
    );
  document
    .getElementById("extend-fill-sd")
    .addEventListener("click", () =>
      selectFillMethod("sd", "extend-fill-sd", extendFillSD),
    );
  // Live re-run when Simple/Color options change.
  document
    .getElementById("extend-blur")
    .addEventListener("change", rerunActiveMethod);
  document
    .getElementById("extend-noise")
    .addEventListener("change", rerunActiveMethod);
  document.getElementById("extend-color").addEventListener("input", (e) => {
    exColor = e.target.value;
    document.getElementById("extend-color-sw").style.background = exColor;
    rerunActiveMethod();
  });
  document.getElementById("extend-save").addEventListener("click", extendSave);
  document
    .getElementById("extend-edit-photos")
    .addEventListener("click", extendEditInPhotos);
  document
    .getElementById("extend-cancel")
    .addEventListener(
      "click",
      () => (document.getElementById("extend").hidden = true),
    );
  document.querySelectorAll("#extend-ratios .chip").forEach((c) =>
    c.addEventListener("click", () => {
      document
        .querySelectorAll("#extend-ratios .chip")
        .forEach((x) => x.classList.remove("is-active"));
      c.classList.add("is-active");
      exRatioBase = c.dataset.ratio === "free" ? null : Number(c.dataset.ratio);
      applyOrientedRatio();
    }),
  );
  document.querySelectorAll("#extend-orient .orient-btn").forEach((b) =>
    b.addEventListener("click", () => {
      document
        .querySelectorAll("#extend-orient .orient-btn")
        .forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      exOrient = b.dataset.orient;
      applyOrientedRatio(); // re-orient the current ratio (no-op for Free/1:1)
    }),
  );
  document
    .querySelectorAll("#extend-frame .exh")
    .forEach((hd) => hd.addEventListener("pointerdown", exPointerDown));
}

function initEditor() {
  buildTonalSliders();
  document
    .getElementById("lb-export")
    .addEventListener("click", () => exportEdited(false));
  document
    .getElementById("lb-replace")
    .addEventListener("click", () => exportEdited(true));

  const apply = () => {
    renderEditorPreview();
    scheduleEditsSave();
  };
  document.getElementById("ed-rotl").addEventListener("click", () => {
    editState.rotate = (editState.rotate - 90 + 360) % 360;
    apply();
  });
  document.getElementById("ed-rotr").addEventListener("click", () => {
    editState.rotate = (editState.rotate + 90) % 360;
    apply();
  });
  document.getElementById("ed-fliph").addEventListener("click", () => {
    editState.flipH = !editState.flipH;
    apply();
  });
  document.getElementById("ed-flipv").addEventListener("click", () => {
    editState.flipV = !editState.flipV;
    apply();
  });
  document.getElementById("ed-straighten").addEventListener("input", (e) => {
    editState.straighten = Number(e.target.value);
    document.getElementById("ed-straighten-val").textContent =
      `${editState.straighten}°`;
    apply();
  });
  document.getElementById("ed-reset").addEventListener("click", () => {
    editState = defaultEdits();
    syncEditorControls();
    apply();
  });

  // Crop interactions.
  document
    .getElementById("crop")
    .addEventListener("pointerdown", onCropPointerDown);
  document
    .querySelectorAll("[data-aspect]")
    .forEach((b) =>
      b.addEventListener("click", () =>
        applyAspect(
          b.dataset.aspect === "free" ? null : Number(b.dataset.aspect),
        ),
      ),
    );
  document.getElementById("ed-cropreset").addEventListener("click", resetCrop);

  // Copy / paste adjustments live in the side "More" menu (wired in initMedia).
  loadCopiedEdits();
  window.addEventListener("resize", () => {
    if (previewSrc()) renderEditorPreview();
  });
}

// Re-pack the notes bento grid when the window (and thus column count) changes.
window.addEventListener("resize", () => {
  if (document.getElementById("notes-list")) scheduleBentoLayout();
});

function initMedia() {
  initEditor();
  initWebExport();
  initRemoveBg();
  initExtend();
  initGenerate();
  document.getElementById("sel-paste").addEventListener("click", batchPaste);
  document
    .getElementById("sel-clear")
    .addEventListener("click", clearSelection);

  // Side column: open the full lightbox for the selected image.
  document.getElementById("side-lightbox").addEventListener("click", () => {
    if (activeItem) openLightbox(activeItem);
  });

  // "More" dropdown in the editor side column.
  const sideMenu = document.getElementById("side-menu");
  const closeSideMenu = () => (sideMenu.hidden = true);
  document.getElementById("side-more").addEventListener("click", (e) => {
    e.stopPropagation();
    if (sideMenu.hidden) {
      // Replace-original only applies to PNG/JPEG, like the lightbox bar.
      document.getElementById("m-replace").hidden =
        document.getElementById("lb-replace").hidden;
      // Paste adjustments is available only once something has been copied.
      document.getElementById("m-pasteadj").disabled = !copiedEdits;
    }
    sideMenu.hidden = !sideMenu.hidden;
  });
  document.addEventListener("click", () => closeSideMenu());
  const menuAction = (id, fn) =>
    document.getElementById(id).addEventListener("click", () => {
      closeSideMenu();
      fn();
    });
  menuAction("m-copyadj", copyAdjustments); // Copy adjustments
  menuAction("m-pasteadj", pasteAdjustments); // Paste adjustments
  menuAction("m-export", () => exportEdited(false)); // Duplicate
  menuAction("m-webexport", exportCurrent); // Export
  menuAction("m-replace", () => exportEdited(true)); // Replace original
  menuAction("m-copy", () => {
    if (editItem) navigator.clipboard.writeText(editItem.path);
  });
  menuAction("m-reveal", () => {
    if (editItem) invoke("reveal_in_finder", { path: editItem.path });
  });
  menuAction("m-photos", editInPhotos); // Edit in Photos

  // Click off a thumbnail (empty grid space, panel padding, header) to clear
  // the selection. The batch bar and the editor side column keep their clicks.
  installOffClickDeselect({
    panel: "media",
    keep: [".mediatile", ".selbar", ".media-side"],
    hasSelection: () => mediaSelection.size(),
    clear: clearSelection,
  });

  // Media keyboard, routed through the shared dispatcher. The lightbox / inline
  // editor are Media sub-modes (not modals), so the handlers branch on mode.
  const lbOpen = () => !document.getElementById("lightbox").hidden;
  const editorActive = () => lbOpen() || !!activeItem;
  const activateSelectedMedia = () => {
    const ids = mediaSelection.get();
    if (ids.length !== 1) return;
    const item = mediaItemsByPath.get(ids[0]);
    if (!item) return;
    if (item.kind === "image") openLightbox(item);
    else invoke("open_path", { path: item.path });
  };
  panelKeymaps.media = {
    Enter: activateSelectedMedia,
    Escape: () => (lbOpen() ? closeLightbox() : clearSelection()),
    "Mod+c": () => {
      if (editorActive()) copyAdjustments();
    },
    "Mod+v": () => {
      if (editorActive()) pasteAdjustments();
      else if (mediaSelection.size()) batchPaste();
      else pasteFromClipboard();
    },
    Delete: mediaDeleteFromKeyboard,
    Backspace: mediaDeleteFromKeyboard,
  };

  document.getElementById("lb-close").addEventListener("click", closeLightbox);
  document.getElementById("lightbox").addEventListener("click", (e) => {
    if (suppressLightboxClick) {
      suppressLightboxClick = false;
      return;
    }
    if (
      e.target.id === "lightbox" ||
      e.target.classList.contains("lightbox__stage")
    ) {
      closeLightbox();
    }
  });
  document.getElementById("lb-copy").addEventListener("click", () => {
    if (currentMedia) navigator.clipboard.writeText(currentMedia.path);
  });
  document.getElementById("lb-reveal").addEventListener("click", () => {
    if (currentMedia) invoke("reveal_in_finder", { path: currentMedia.path });
  });
}

// --- Notes -----------------------------------------------------------------

let notesData = { version: 1, notes: [] };
let selectedCol = null; // { note, ci, thEls, tdEls }
let selectedRow = null; // { note, ri, trEl }
// Card selection (interaction-spec §3). Multi-select; the panel repaints
// is-selected from this on every change.
const notesSelection = createSelection({
  mode: "multi",
  onChange: () => repaintNotesSelection(),
});

function repaintNotesSelection() {
  const listEl = document.getElementById("notes-list");
  listEl
    ?.querySelectorAll(".notecard")
    .forEach((c) =>
      c.classList.toggle("is-selected", notesSelection.has(c.dataset.noteId)),
    );
  updateNotesChrome();
}

// --- Notes keymap actions (registered in panelKeymaps.notes) ---------------

// Delete: a selected table col/row takes priority over card deletion.
function deleteNotesSelection() {
  if (selectedCol) {
    const { note, ci } = selectedCol;
    note.columns.splice(ci, 1);
    note.rows.forEach((r) => r.splice(ci, 1));
    if (note.totals)
      note.totals = note.totals
        .filter((i) => i !== ci)
        .map((i) => (i > ci ? i - 1 : i));
    selectedCol = null;
    renderNotes();
    scheduleNotesSave();
    return;
  }
  if (selectedRow) {
    const { note, ri } = selectedRow;
    note.rows.splice(ri, 1);
    selectedRow = null;
    renderNotes();
    scheduleNotesSave();
    return;
  }
  const ids = new Set(notesSelection.get());
  if (!ids.size) return;
  notesData.notes = notesData.notes.filter((n) => !ids.has(n.id));
  notesSelection.clear();
  renderNotes();
  scheduleNotesSave();
}

// Reorder the selected card by one position — single selection only.
function moveSelectedNote(delta) {
  if (notesSelection.size() !== 1) return;
  const id = notesSelection.get()[0];
  const idx = notesData.notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= notesData.notes.length) return;
  const [note] = notesData.notes.splice(idx, 1);
  notesData.notes.splice(newIdx, 0, note);
  renderNotes();
  scheduleNotesSave();
}

function clearNotesSelection() {
  clearColSelection();
  clearRowSelection();
  notesSelection.clear();
}

// --- Note modal (double-click / Enter "open") ------------------------------

function buildNoteCard(note) {
  if (note.kind === "checklist") return buildChecklist(note);
  if (note.kind === "table") return buildTable(note);
  return buildTextNote(note);
}

// Open a single note enlarged in a modal. Uses the `.modal` class so the shared
// dispatcher closes it on Escape / backdrop click; edits bind to the same note
// object and sync to the grid on close.
function openNoteModal(note) {
  let modal = document.getElementById("note-modal");
  if (!modal) {
    modal = el("div", "modal note-modal", { id: "note-modal" });
    modal.append(el("div", "modal__card note-modal__card"));
    document.body.append(modal);
  }
  const card = modal.querySelector(".modal__card");
  card.innerHTML = "";
  card.append(buildNoteCard(note));
  modal.hidden = false;
  requestAnimationFrame(() =>
    card.querySelectorAll("textarea").forEach((ta) => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    }),
  );
}

function closeNoteModal() {
  const modal = document.getElementById("note-modal");
  if (modal) modal.hidden = true;
  renderNotes(); // reflect edits made in the modal
  scheduleNotesSave();
}

function openSelectedNoteModal() {
  const n = selectedNote();
  if (n) openNoteModal(n);
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".ntable__col-handle")) clearColSelection();
  if (!e.target.closest(".ntable__row-handle")) clearRowSelection();
});

function clearColSelection() {
  if (!selectedCol) return;
  selectedCol.thEls.forEach((el) => el.classList.remove("is-col-selected"));
  selectedCol.tdEls.forEach((el) => el.classList.remove("is-col-selected"));
  if (selectedCol.totalBtn) selectedCol.totalBtn.hidden = true;
  selectedCol = null;
}

function clearRowSelection() {
  if (!selectedRow) return;
  selectedRow.trEl.classList.remove("is-row-selected");
  selectedRow = null;
}
let notesProjectPath = null;
let notesSaveTimer = null;



function setNotesStatus(text) {
  document.getElementById("notes-status").textContent = text;
}

function applyNotesFont() {
  const font = notesData.font || "system-ui";
  const listEl = document.getElementById("notes-list");
  const menu = document.getElementById("notes-font-menu");

  const btn = menu
    ? [...menu.querySelectorAll(".menu__item")].find((b) => b.dataset.font === font)
    : null;
  const size = notesData.fontSize || (btn?.dataset.size ? Number(btn.dataset.size) : 14);

  listEl.style.setProperty("--notes-font", font);
  listEl.style.setProperty("--notes-font-size", size + "px");

  // Mark active item.
  menu?.querySelectorAll(".menu__item").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.font === font);
  });
}

async function loadNotes(path) {
  notesProjectPath = path;
  const data = await invoke("read_notes", { path });
  notesData =
    data && Array.isArray(data.notes) ? data : { version: 1, notes: [] };
  setNotesStatus("");
  applyNotesFont();
  renderNotes();
}

function scheduleNotesSave() {
  if (!notesProjectPath) return;
  setNotesStatus("Saving…");
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(async () => {
    try {
      await invoke("save_notes", { path: notesProjectPath, notes: notesData });
      setNotesStatus("");
    } catch (err) {
      setNotesStatus(`Error: ${err}`);
    }
  }, 400);
}

async function pasteFromClipboard() {
  let text = "";
  try {
    text = await invoke("read_clipboard_text");
  } catch (_) {}

  if (text.includes("\t")) {
    // TSV → table note; first row becomes column headers.
    const rows = text
      .trimEnd()
      .split(/\r?\n/)
      .map((r) => r.split("\t"));
    const columns = rows[0].map((h) => h.trim() || "Column");
    const dataRows = rows
      .slice(1)
      .map((r) => columns.map((_, ci) => (r[ci] ?? "").trim()));
    notesData.notes.unshift({
      id: genId(),
      kind: "table",
      title: "",
      columns,
      rows: dataRows,
      totals: [],
      createdAt: new Date().toISOString(),
    });
    renderNotes();
    scheduleNotesSave();
    selectTab("notes");
  } else if (text.trim()) {
    // Plain text → text note.
    notesData.notes.unshift({
      id: genId(),
      kind: "text",
      title: "",
      body: text.trim(),
      createdAt: new Date().toISOString(),
    });
    renderNotes();
    scheduleNotesSave();
    selectTab("notes");
  } else {
    // No text — try pasting as image (switches to media tab on success).
    pasteImageFromClipboard();
  }
}

function newNote(kind) {
  const note = {
    id: genId(),
    kind,
    title: "",
    createdAt: new Date().toISOString(),
  };
  if (kind === "text") note.body = "";
  if (kind === "checklist") note.items = [];
  if (kind === "table") {
    note.columns = ["Column", "Column"];
    note.rows = [
      ["", ""],
      ["", ""],
    ];
    note.totals = [];
  }
  notesData.notes.unshift(note);
  renderNotes();
  scheduleNotesSave();
}

function setCardVar(elm, prop, val) {
  if (val) elm.style.setProperty(prop, val);
  else elm.style.removeProperty(prop);
}

// Translate a note's theme + font choices into scoped CSS variables on its card.
function applyNoteStyle(card, note) {
  const theme = NOTE_THEMES.find((t) => t.id === note.theme) || NOTE_THEMES[0];
  setCardVar(card, "--note-bg", theme.bg);
  setCardVar(card, "--note-title-color", theme.titleColor);
  setCardVar(card, "--note-body-color", theme.bodyColor);
  setCardVar(card, "--note-title-font", note.titleFont);
  // Overrides the list-level --notes-font for this card only.
  setCardVar(card, "--notes-font", note.bodyFont);
}

function noteHeader(note) {
  const head = el("div", "notecard__head");
  const title = el("input", "notecard__title", {
    value: note.title || "",
    placeholder: "^_^",
  });
  title.addEventListener("input", () => {
    note.title = title.value;
    scheduleNotesSave();
  });

  const del = el("button", "btn-remove", {
    type: "button",
    innerHTML: mi("close"),
  });
  del.addEventListener("click", () => {
    notesData.notes = notesData.notes.filter((n) => n.id !== note.id);
    renderNotes();
    scheduleNotesSave();
  });
  head.append(title, del);
  return head;
}

// Width toggle, shown centered at the bottom of every note card. 1–3 dots =
// how many grid columns the card spans; clicking cycles 1 → 2 → 3 → 1.
function noteFooter(note) {
  const footer = el("div", "notecard__footer");

  if (note.createdAt) {
    const d = new Date(note.createdAt);
    const dateStr = d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    footer.append(el("span", "notecard__date", { textContent: dateStr }));
  }

  const width = el("button", "notecard__width", {
    type: "button",
    title: "Width",
  });
  const renderDots = () => {
    width.innerHTML = '<span class="dot"></span>'.repeat(note.span || 1);
  };
  renderDots();
  width.addEventListener("click", () => {
    note.span = ((note.span || 1) % 3) + 1;
    renderDots();
    const card = width.closest(".notecard");
    if (card) {
      card.style.gridColumn = `span ${note.span}`;
      requestAnimationFrame(() => {
        card.querySelectorAll("textarea").forEach((ta) => {
          ta.style.height = "auto";
          ta.style.height = ta.scrollHeight + "px";
        });
        layoutBento();
      });
    }
    scheduleNotesSave();
  });
  footer.append(width);
  return footer;
}

// Pull http/https URLs out of free text, in order, de-duplicated. Trailing
// punctuation that's usually sentence-grammar rather than part of the link is
// trimmed off.
function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(/\bhttps?:\/\/[^\s<>"']+/gi) || [];
  const seen = new Set();
  const urls = [];
  for (let url of matches) {
    url = url.replace(/[.,;:!?)\]}'"]+$/, "");
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

// A compact label for a link block: host (without leading www.) plus the path,
// truncated so long URLs don't blow out the card width.
function linkLabel(url) {
  try {
    const u = new URL(url);
    let label = u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
    if (u.search) label += u.search;
    return label.length > 48 ? label.slice(0, 47) + "…" : label;
  } catch {
    return url;
  }
}

// Open an external URL in the system default browser. Validates the scheme so
// we never hand arbitrary strings to the OS `open` command.
function openExternalUrl(url) {
  if (!/^https?:\/\//i.test(url)) return;
  invoke("open_path", { path: url });
}

function buildTextNote(note) {
  const card = el("div", "notecard");
  card.append(noteHeader(note));

  if (!Array.isArray(note.links)) note.links = [];

  const textarea = el("textarea", "notecard__textarea", {
    placeholder: "Write something…",
  });
  textarea.value = note.body || "";

  const links = el("div", "notecard__links");
  const renderLinks = () => {
    links.innerHTML = "";
    links.style.display = note.links.length ? "" : "none";
    note.links.forEach((url, idx) => {
      const block = el("div", "notelink", { title: url });
      const open = el("button", "notelink__open", { type: "button" });
      open.innerHTML = mi("link");
      open.append(el("span", "notelink__label", { textContent: linkLabel(url) }));
      open.addEventListener("click", () => openExternalUrl(url));
      const rm = el("button", "btn-remove", {
        type: "button",
        innerHTML: mi("close"),
        title: "Remove link",
      });
      rm.addEventListener("click", () => {
        note.links.splice(idx, 1);
        renderLinks();
        scheduleNotesSave();
      });
      block.append(open, rm);
      links.append(block);
    });
  };

  // Pull any URLs out of the body into note.links (de-duped) and strip their
  // text from the body. Returns true if anything changed.
  const harvestLinks = () => {
    const urls = extractUrls(note.body);
    if (!urls.length) return false;
    let body = note.body;
    for (const url of urls) {
      if (!note.links.includes(url)) note.links.push(url);
      body = body.split(url).join("");
    }
    // Tidy whitespace left behind by removed URLs.
    note.body = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return true;
  };

  const resizeTextarea = () => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  };
  textarea.addEventListener("input", () => {
    note.body = textarea.value;
    resizeTextarea();
    scheduleBentoLayout();
    scheduleNotesSave();
  });
  textarea.addEventListener("blur", () => {
    if (harvestLinks()) {
      textarea.value = note.body;
      resizeTextarea();
      renderLinks();
      scheduleBentoLayout();
      scheduleNotesSave();
    }
  });
  requestAnimationFrame(resizeTextarea);

  card.append(textarea);
  card.append(links);

  // Migrate any links already sitting inline in saved notes.
  if (harvestLinks()) {
    textarea.value = note.body;
    scheduleNotesSave();
  }
  renderLinks();
  return card;
}

function addChecklistItem(note) {
  note.items.push({ text: "", done: false });
  renderNotes();
  scheduleNotesSave();
  // Focus the freshly-added item's input.
  const card = document.querySelector(`.notecard[data-note-id="${note.id}"]`);
  const inputs = card?.querySelectorAll(".checklist__row .field__input");
  if (inputs && inputs.length) inputs[inputs.length - 1].focus();
}

function buildChecklist(note) {
  const card = el("div", "notecard");
  card.append(noteHeader(note));

  // Always keep at least one row so there's an input to type into (Enter adds
  // more). The "Add item" button is intentionally gone.
  if (!note.items.length) note.items.push({ text: "", done: false });

  const list = el("div", "checklist");
  note.items.forEach((item, idx) => {
    const row = el("div", "checklist__row");
    const cb = el("input", null, { type: "checkbox", checked: !!item.done });
    cb.addEventListener("change", () => {
      item.done = cb.checked;
      scheduleNotesSave();
    });
    const txt = el("textarea", "field__input", {
      placeholder: "Item",
      rows: 1,
    });
    txt.value = item.text || "";
    const resizeTxt = () => {
      txt.style.height = "auto";
      txt.style.height = txt.scrollHeight + "px";
    };
    txt.addEventListener("input", () => {
      item.text = txt.value;
      resizeTxt();
      scheduleBentoLayout();
      scheduleNotesSave();
    });
    txt.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        addChecklistItem(note);
      }
    });
    requestAnimationFrame(resizeTxt);
    const rm = el("button", "btn-remove", {
      type: "button",
      innerHTML: mi("close"),
    });
    rm.addEventListener("click", () => {
      note.items.splice(idx, 1);
      renderNotes();
      scheduleNotesSave();
    });
    row.append(cb, txt, rm);
    list.append(row);
  });

  card.append(list);
  return card;
}

function buildTable(note) {
  const card = el("div", "notecard");
  card.append(noteHeader(note));

  const table = el("table", "ntable");
  const thead = el("thead");
  const htr = el("tr");
  let actionsTotalBtn; // assigned after actions are built; closures below capture by reference

  const thEls = [];
  note.columns.forEach((col, ci) => {
    const th = el("th");
    thEls.push(th);

    const handle = el("div", "ntable__col-handle");
    handle.addEventListener("click", (e) => {
      e.stopPropagation();
      clearColSelection();
      clearRowSelection();
      const tdEls = [...tbody.querySelectorAll(`td:nth-child(${ci + 1})`)];
      const hasTotal = (note.totals || []).includes(ci);
      actionsTotalBtn.textContent = hasTotal ? "− Total" : "+ Total";
      actionsTotalBtn.hidden = false;
      actionsTotalBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (!note.totals) note.totals = [];
        if (note.totals.includes(ci)) {
          note.totals = note.totals.filter((i) => i !== ci);
        } else {
          note.totals.push(ci);
        }
        renderNotes();
        scheduleNotesSave();
      };
      selectedCol = { note, ci, thEls: [th], tdEls, totalBtn: actionsTotalBtn };
      th.classList.add("is-col-selected");
      tdEls.forEach((td) => td.classList.add("is-col-selected"));
    });

    const inp = el("input", "ntable__colinput", {
      value: col,
      placeholder: "Column",
    });
    inp.addEventListener("input", () => {
      note.columns[ci] = inp.value;
      scheduleNotesSave();
    });

    th.append(handle, inp);
    htr.append(th);
  });
  thead.append(htr);
  table.append(thead);

  const colInputs = note.columns.map(() => []); // colInputs[ci] = all inputs in that column

  const tbody = el("tbody");
  note.rows.forEach((row, ri) => {
    const tr = el("tr");

    note.columns.forEach((_, ci) => {
      const td = el("td");
      const inp = el("input", "ntable__cell", { value: row[ci] || "" });

      if (ci === 0) {
        td.style.position = "relative";
        const handle = el("div", "ntable__row-handle");
        handle.addEventListener("click", (e) => {
          e.stopPropagation();
          clearRowSelection();
          clearColSelection();
          selectedRow = { note, ri, trEl: tr };
          tr.classList.add("is-row-selected");
        });
        td.append(handle);
      }
      inp.addEventListener("input", () => {
        row[ci] = inp.value;
        scheduleNotesSave();
      });
      colInputs[ci].push(inp);
      td.append(inp);
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(tbody);

  const activeTotals = note.totals || [];
  if (activeTotals.length > 0) {
    const tfoot = el("tfoot");
    const ftr = el("tr");
    note.columns.forEach((colName, ci) => {
      const td = el("td", "ntable__total-cell");
      if (activeTotals.includes(ci)) {
        const computeTotal = () => {
          const sum = colInputs[ci].reduce((acc, inp) => {
            const val = parseFloat(inp.value);
            return acc + (isNaN(val) ? 0 : val);
          }, 0);
          td.textContent = `Total: ${sum % 1 === 0 ? sum : sum.toFixed(2)}`;
        };
        computeTotal();
        colInputs[ci].forEach((inp) =>
          inp.addEventListener("input", computeTotal),
        );
      }
      ftr.append(td);
    });
    tfoot.append(ftr);
    table.append(tfoot);
  }

  const actions = el("div", "ntable__actions");
  const addRow = el("button", "btn-add", {
    type: "button",
    innerHTML: `${mi("add")}Row`,
  });
  addRow.addEventListener("click", () => {
    note.rows.push(note.columns.map(() => ""));
    renderNotes();
    scheduleNotesSave();
  });
  const addCol = el("button", "btn-add", {
    type: "button",
    innerHTML: `${mi("add")}Column`,
  });
  addCol.addEventListener("click", () => {
    note.columns.push("Column");
    note.rows.forEach((r) => r.push(""));
    renderNotes();
    scheduleNotesSave();
  });
  actionsTotalBtn = el("button", "btn-add ntable__total-btn-action", {
    type: "button",
    textContent: "+ Total",
    hidden: true,
  });
  actions.append(addRow, addCol, actionsTotalBtn);

  card.append(table, actions);
  return card;
}

function renderNotes() {
  const listEl = document.getElementById("notes-list");
  listEl.innerHTML = "";

  if (!notesData.notes.length) {
    listEl.append(
      el("p", "placeholder", {
        textContent:
          "No notes yet. Add a text note, checklist, or table above.",
      }),
    );
    return;
  }

  for (const note of notesData.notes) {
    let card;
    if (note.kind === "text") {
      card = buildTextNote(note);
    } else if (note.kind === "checklist") {
      if (!Array.isArray(note.items)) note.items = [];
      card = buildChecklist(note);
    } else if (note.kind === "table") {
      if (!Array.isArray(note.columns)) note.columns = ["Column"];
      if (!Array.isArray(note.rows)) note.rows = [];
      card = buildTable(note);
    } else {
      continue;
    }
    card.append(noteFooter(note));
    card.dataset.noteId = note.id;
    card.style.gridColumn = `span ${note.span || 1}`;
    applyNoteStyle(card, note);
    if (notesSelection.has(note.id)) card.classList.add("is-selected");

    // Drag-to-reorder via pointer events (Tauri's native file-drop swallows
    // HTML5 dragover/drop in the webview). Only starts from a non-interactive
    // part of the card so text editing still works.
    card.addEventListener("pointerdown", (e) =>
      onNotePointerDown(e, note, card),
    );

    card.addEventListener("click", (e) => {
      if (Date.now() - lastNoteDragEnd < 300) return; // ignore click after drag
      if (e.target.closest("select, button, input, textarea, a")) return;
      const rect = card.getBoundingClientRect();
      if (e.clientY - rect.top <= 8) {
        if (e.shiftKey) {
          notesSelection.range(
            notesData.notes.map((n) => n.id),
            note.id,
          );
        } else {
          notesSelection.toggle(note.id, e.metaKey || e.ctrlKey);
        }
      }
    });
    // Double-click a non-editable part of the card opens it in a modal.
    card.addEventListener("dblclick", (e) => {
      if (e.target.closest("select, button, input, textarea, a")) return;
      openNoteModal(note);
    });
    listEl.append(card);
  }

  updateNotesChrome();

  // Bento packing: card heights aren't known until textareas auto-size, so
  // measure on the next frames and translate each card's height into a
  // grid-row span. `grid-auto-flow: dense` then tiles them into the gaps.
  requestAnimationFrame(() => requestAnimationFrame(layoutBento));
}

let draggingNoteId = null;
let dropTargetIndex = null;
let noteDrag = null; // { note, card, startX, startY, active }
let lastNoteDragEnd = 0;

// The single selected note (style controls target exactly one); null if zero
// or many are selected.
function selectedNote() {
  const ids = notesSelection.get();
  return ids.length === 1
    ? notesData.notes.find((n) => n.id === ids[0]) || null
    : null;
}

// Show the per-card style controls in the toolbar when a card is selected and
// sync their values to that card.
function updateNotesChrome() {
  const group = document.getElementById("notes-card-style");
  if (!group) return;
  const note = selectedNote();
  group.hidden = !note;
  if (!note) return;
  const theme = document.getElementById("note-theme-select");
  const titleFont = document.getElementById("note-titlefont-select");
  const bodyFont = document.getElementById("note-bodyfont-select");
  if (theme) theme.value = note.theme || "default";
  if (titleFont) titleFont.value = note.titleFont || "";
  if (bodyFont) bodyFont.value = note.bodyFont || "";
}

function setSelectedNoteStyle(key, value) {
  const note = selectedNote();
  if (!note) return;
  note[key] = value;
  const card = document.querySelector(`.notecard[data-note-id="${note.id}"]`);
  if (card) applyNoteStyle(card, note);
  scheduleNotesSave();
}

function onNotePointerDown(e, note, card) {
  if (e.button !== 0) return;
  if (e.target.closest("textarea, input, select, button, a, [contenteditable]"))
    return;
  noteDrag = { note, card, startX: e.clientX, startY: e.clientY, active: false };
  window.addEventListener("pointermove", onNotePointerMove);
  window.addEventListener("pointerup", onNotePointerUp);
}

function onNotePointerMove(e) {
  if (!noteDrag) return;
  if (!noteDrag.active) {
    // Wait for a small movement threshold so plain clicks still select.
    if (Math.hypot(e.clientX - noteDrag.startX, e.clientY - noteDrag.startY) < 5)
      return;
    noteDrag.active = true;
    draggingNoteId = noteDrag.note.id;
    noteDrag.card.classList.add("is-dragging");
    document.body.classList.add("note-dragging");
    document.body.style.cursor = "grabbing";
    window.getSelection()?.removeAllRanges();
  }
  e.preventDefault();
  const listEl = document.getElementById("notes-list");
  const target = computeDropTarget(listEl, e.clientX, e.clientY);
  dropTargetIndex = target ? target.index : null;
  showDropIndicator(listEl, target);
}

function onNotePointerUp() {
  window.removeEventListener("pointermove", onNotePointerMove);
  window.removeEventListener("pointerup", onNotePointerUp);
  const drag = noteDrag;
  noteDrag = null;
  document.body.style.cursor = "";
  document.body.classList.remove("note-dragging");
  if (!drag || !drag.active) return; // was a click, not a drag
  lastNoteDragEnd = Date.now();
  drag.card.classList.remove("is-dragging");
  draggingNoteId = null;
  hideDropIndicator();
  const to0 = dropTargetIndex;
  dropTargetIndex = null;
  if (to0 == null) return;
  const fromIdx = notesData.notes.findIndex((n) => n.id === drag.note.id);
  if (fromIdx === -1) return;
  let to = to0;
  const [note] = notesData.notes.splice(fromIdx, 1);
  if (fromIdx < to) to -= 1; // account for the removed element
  to = Math.max(0, Math.min(to, notesData.notes.length));
  notesData.notes.splice(to, 0, note);
  renderNotes();
  scheduleNotesSave();
}

// Where would a drop at the current pointer land? Returns the insertion index
// in notesData.notes, plus the card/edge to draw the indicator against.
function computeDropTarget(listEl, x, y) {
  const cards = [...listEl.querySelectorAll(".notecard")];
  if (!cards.length) return { index: 0, card: null, after: false };
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (x < r.left || x > r.right) continue; // not in this card's column band
    if (y < r.top + r.height / 2) return { index: i, card: cards[i], after: false };
    // Bottom half: tentatively after this card; a card lower in the same
    // column may still claim the pointer on a later iteration.
    var colHit = { index: i + 1, card: cards[i], after: true };
  }
  if (typeof colHit !== "undefined") return colHit;
  // Pointer in a gap / outside everything: snap to the nearest card by center.
  let best = null;
  let bestDist = Infinity;
  cards.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      const after = y >= r.top + r.height / 2;
      best = { index: after ? i + 1 : i, card: c, after };
    }
  });
  return best;
}

function showDropIndicator(listEl, target) {
  const bar = ensureDropIndicator(listEl);
  if (!target || !target.card) {
    bar.style.display = "none";
    return;
  }
  const listRect = listEl.getBoundingClientRect();
  const r = target.card.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(listEl).rowGap) || 14;
  const edgeY = target.after ? r.bottom + gap / 2 : r.top - gap / 2;
  bar.style.display = "block";
  bar.style.left = r.left - listRect.left + "px";
  bar.style.width = r.width + "px";
  bar.style.top = edgeY - listRect.top - 1.5 + "px";
}

function ensureDropIndicator(listEl) {
  let bar = listEl.querySelector(".note-drop-indicator");
  if (!bar) {
    bar = el("div", "note-drop-indicator");
    listEl.append(bar);
  }
  return bar;
}

function hideDropIndicator() {
  const bar = document.querySelector(".note-drop-indicator");
  if (bar) bar.style.display = "none";
}

// Translate each card's natural height into a grid-row span so dense auto-flow
// can pack the cards into a bento mosaic.
function layoutBento() {
  const listEl = document.getElementById("notes-list");
  if (!listEl) return;
  const style = getComputedStyle(listEl);
  const row = parseFloat(style.gridAutoRows) || 8;
  const gap = parseFloat(style.rowGap) || 0;
  listEl.querySelectorAll(".notecard").forEach((card) => {
    // Reset so we measure the card's natural (content) height.
    card.style.gridRowEnd = "";
    const h = card.getBoundingClientRect().height;
    const span = Math.max(1, Math.round((h + gap) / (row + gap)));
    card.style.gridRowEnd = `span ${span}`;
  });
}

let bentoLayoutTimer = null;
function scheduleBentoLayout() {
  clearTimeout(bentoLayoutTimer);
  bentoLayoutTimer = setTimeout(layoutBento, 60);
}

function initNotes() {
  document.querySelectorAll("[data-new-note]").forEach((btn) => {
    btn.addEventListener("click", () => newNote(btn.dataset.newNote));
  });

  const fontBtn = document.getElementById("notes-font-btn");
  const fontMenu = document.getElementById("notes-font-menu");

  fontBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fontMenu.hidden = !fontMenu.hidden;
  });

  fontMenu.addEventListener("click", (e) => {
    const item = e.target.closest(".menu__item");
    if (!item) return;
    notesData.font = item.dataset.font;
    notesData.fontSize = item.dataset.size ? Number(item.dataset.size) : 14;
    fontMenu.hidden = true;
    applyNotesFont();
    scheduleNotesSave();
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#notes-font-wrap")) fontMenu.hidden = true;
  });

  // Per-card style controls (toolbar) target the currently selected card.
  const themeSel = document.getElementById("note-theme-select");
  const titleFontSel = document.getElementById("note-titlefont-select");
  const bodyFontSel = document.getElementById("note-bodyfont-select");
  NOTE_THEMES.forEach((t) => themeSel.append(new Option(t.name, t.id)));
  [titleFontSel, bodyFontSel].forEach((sel) =>
    NOTE_FONTS.forEach((f) => sel.append(new Option(f.name, f.value))),
  );
  themeSel.addEventListener("change", () =>
    setSelectedNoteStyle("theme", themeSel.value),
  );
  titleFontSel.addEventListener("change", () =>
    setSelectedNoteStyle("titleFont", titleFontSel.value),
  );
  bodyFontSel.addEventListener("change", () =>
    setSelectedNoteStyle("bodyFont", bodyFontSel.value),
  );

  installOffClickDeselect({
    panel: "notes",
    keep: [".notecard", "#notes-card-style"],
    hasSelection: () => notesSelection.size(),
    clear: () => notesSelection.clear(),
  });

  // Register the Notes keymap and install the shared keyboard dispatcher.
  panelKeymaps.notes = {
    Enter: openSelectedNoteModal,
    Delete: deleteNotesSelection,
    Backspace: deleteNotesSelection,
    ArrowLeft: () => moveSelectedNote(-1),
    ArrowRight: () => moveSelectedNote(1),
    Escape: clearNotesSelection,
  };
  installKeyDispatcher({
    getActivePanel: () => activePanel,
    panelKeymaps,
    globalKeymap,
    anyModalOpen,
    modalKeymap,
  });

  // Notes Mod+v paste is a Phase 2 feature (interaction-spec §7.2) — not yet
  // wired into panelKeymaps.notes.
}

// --- Boot ------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  initLaunch();
  initWorkspaceForm();
  initNotes();
  initMedia();
  initDragDrop();
  initNewModal();

  render(await invoke("get_active_project"));

  document.getElementById("overview-new-btn").addEventListener("click", openNewModal);

  await listen("project-activated", (event) => render(event.payload));
  await listen("new-project-request", openNewModal);
  await listen("show-overview", showOverview);

  // Files changed on disk (Finder, other apps) — refresh the media grid and the
  // overview if visible. Notes/workspace forms are left alone (avoid clobbering
  // in-progress edits).
  await listen("fs-changed", () => {
    if (activeProject && !document.getElementById("project-content").hidden) {
      loadMedia(activeProject.path);
    }
    if (!document.getElementById("overview").hidden) {
      showOverview();
    }
  });
});
