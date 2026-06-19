// Studio frontend shell.
// M3: tabbed project view with a working Workspace form, plus the New Project
// flow. The tray (Rust side) owns discovery/activation; commands handle the
// filesystem work.

import { NOTE_THEMES, NOTE_FONTS } from "./themes.js";
import { createSelection } from "./selection.js";
import { installKeyDispatcher, panelKeymaps } from "./keymap.js";
import { el, mi, genId } from "./dom.js";
import { loadImage } from "./imageutil.js";
import { spriteStyle } from "./sprites.js";
import { state } from "./state.js";
import { initDevInspect } from "./devinspect.js";
import {
  loadMedia,
  initMedia,
  initDragDrop,
  mediaSelection,
  pasteImageFromClipboard,
} from "./media.js";
import {
  initLaunch,
  initClaudeButton,
  initFileDirectoryButton,
  initSpriteBadge,
  initWorkspaceForm,
  loadWorkspace,
  scheduleWorkspaceSave,
  addRow,
  updatePinButton,
  togglePinnedTab,
} from "./workspace.js";
import { renderArtifacts, artifactsSelection, deleteArtifactsSelection, clearArtifactsSelection } from "./artifacts.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Which panel keyboard input routes to (interaction-spec §4). Set by selectTab
// and by entering/leaving the projects overview.
state.activePanel = "workspace";

// Shared "click-off to deselect" for the in-project panels. Clears the panel's
// selection when the user clicks empty space in that panel or the project
// header — but never the tabs (so selection survives tab switches), nor an
// element matching one of `keep`. Only acts while its panel is active.
export function installOffClickDeselect({ panel, keep, hasSelection, clear }) {
  document.addEventListener("click", (e) => {
    if (state.activePanel !== panel || !hasSelection()) return;
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

state.activeProject = null;

// --- Project rendering -----------------------------------------------------

export function render(project) {
  state.activeProject = project;
  const empty = document.getElementById("empty-state");
  const content = document.getElementById("project-content");
  const header = document.getElementById("project-header");
  const overview = document.getElementById("overview");

  // Only close the overview when a project is actively being rendered
  // (i.e. a card was clicked). Navigating back via the back button keeps it open.
  if (project) overview.hidden = true;

  if (project) {
    document.getElementById("project-name").textContent = project.name;
    header.hidden = false;
    empty.hidden = true;
    content.hidden = false;
    loadWorkspace(project.path);
    loadNotes(project.path);
    loadMedia(project.path);
    renderArtifacts();
  } else {
    // No active project → show the all-projects overview, never a dead-end
    // "No project active" screen.
    state.notesProjectPath = null;
    state.notesData = { version: 1, notes: [] };
    showOverview();
  }
}

// --- All-projects overview -------------------------------------------------

let overviewProjects = []; // last-rendered projects, in display order
let iconVersion = Date.now(); // cache-bust project icon <img> URLs after a change

const projectsSelection = createSelection({
  mode: "multi",
  onChange: () => repaintProjectsSelection(),
});

// Global manual project order (paths). Empty = sort by name.
let projectOrder = [];

async function loadProjectOrder() {
  try {
    const raw = await invoke("read_project_order");
    projectOrder = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(projectOrder)) projectOrder = [];
  } catch (_) {
    projectOrder = [];
  }
}

// Ordered first by the manual order, then any new projects by name.
function applyProjectOrder(projects) {
  if (!projectOrder.length) return projects;
  const idx = new Map(projectOrder.map((p, i) => [p, i]));
  const rank = (p) => (idx.has(p) ? idx.get(p) : Infinity);
  return [...projects].sort(
    (a, b) =>
      rank(a.path) - rank(b.path) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

function saveProjectOrder() {
  invoke("save_project_order", { data: JSON.stringify(projectOrder) });
}

// --- Project card drag-reorder (pointer-based) -----------------------------

let projectDrag = null; // { p, card, pointerId, startX, startY, active }
let lastProjectDragEnd = 0;
let projectDropIndex = null;

function onProjectCardPointerDown(e, p, card) {
  if (e.button !== 0) return;
  if (e.target.closest("button, input, textarea, a")) return; // trash btn etc.
  try {
    card.setPointerCapture(e.pointerId);
  } catch (_) {}
  projectDrag = {
    p,
    card,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
  };
  window.addEventListener("pointermove", onProjectPointerMove);
  window.addEventListener("pointerup", onProjectPointerUp);
  window.addEventListener("pointercancel", onProjectPointerUp);
}

function onProjectPointerMove(e) {
  if (!projectDrag) return;
  if (!projectDrag.active) {
    if (
      Math.hypot(e.clientX - projectDrag.startX, e.clientY - projectDrag.startY) <
      5
    )
      return;
    projectDrag.active = true;
    projectDrag.card.classList.add("is-dragging");
    document.body.classList.add("note-dragging");
  }
  e.preventDefault();
  const grid = document.getElementById("overview-grid");
  const target = computeCardDrop(grid, e.clientX, e.clientY);
  projectDropIndex = target ? target.index : null;
  showProjectDropIndicator(grid, target);
}

function onProjectPointerUp() {
  window.removeEventListener("pointermove", onProjectPointerMove);
  window.removeEventListener("pointerup", onProjectPointerUp);
  window.removeEventListener("pointercancel", onProjectPointerUp);
  const drag = projectDrag;
  projectDrag = null;
  document.body.classList.remove("note-dragging");
  hideProjectDropIndicator();
  if (drag) {
    try {
      drag.card.releasePointerCapture(drag.pointerId);
    } catch (_) {}
  }
  if (!drag || !drag.active) return;
  lastProjectDragEnd = Date.now();
  drag.card.classList.remove("is-dragging");
  const to = projectDropIndex;
  projectDropIndex = null;
  if (to == null) return;

  const grid = document.getElementById("overview-grid");
  const order = [...grid.querySelectorAll(".project-card")].map((c) => c.dataset.path);
  const from = order.indexOf(drag.p.path);
  if (from === -1) return;
  order.splice(from, 1);
  let dest = from < to ? to - 1 : to;
  dest = Math.max(0, Math.min(dest, order.length));
  order.splice(dest, 0, drag.p.path);

  projectOrder = order;
  saveProjectOrder();
  showOverview();
}

// Vertical drop indicator between cards in a uniform grid (shared by Projects).
function computeCardDrop(grid, x, y) {
  const cards = [...grid.querySelectorAll(".project-card")];
  if (!cards.length) return { index: 0, card: null, after: false };
  let rowHit;
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (y < r.top || y > r.bottom) continue;
    if (x < r.left + r.width / 2)
      return { index: i, card: cards[i], after: false };
    rowHit = { index: i + 1, card: cards[i], after: true };
  }
  if (rowHit) return rowHit;
  let best = null;
  let bestDist = Infinity;
  cards.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      const after = x >= r.left + r.width / 2;
      best = { index: after ? i + 1 : i, card: c, after };
    }
  });
  return best;
}

function showProjectDropIndicator(grid, target) {
  let bar = grid.querySelector(".card-drop-indicator");
  if (!bar) {
    bar = el("div", "card-drop-indicator");
    grid.append(bar);
  }
  if (!target || !target.card) {
    bar.style.display = "none";
    return;
  }
  const gr = grid.getBoundingClientRect();
  const r = target.card.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
  const edgeX = target.after ? r.right + gap / 2 : r.left - gap / 2;
  bar.style.display = "block";
  bar.style.left = edgeX - gr.left - 1.5 + "px";
  bar.style.top = r.top - gr.top + "px";
  bar.style.height = r.height + "px";
}

function hideProjectDropIndicator() {
  document.querySelector(".card-drop-indicator")?.remove();
}

// Mod+v: set the selected project's icon from the clipboard image.
async function setSelectedProjectIcon() {
  const sel = projectsSelection.get();
  if (sel.length !== 1) return;
  try {
    await invoke("set_project_icon", { projectPath: sel[0] });
    iconVersion = Date.now();
    showOverview();
  } catch (_) {
    // No image in clipboard.
  }
}

function repaintProjectsSelection() {
  document
    .getElementById("overview-grid")
    ?.querySelectorAll(".project-card")
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
    .querySelector(`.project-card[data-path="${CSS.escape(paths[idx])}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

panelKeymaps.projects = {
  Enter: openSelectedProject,
  "Mod+v": setSelectedProjectIcon,
  Delete: () => trashProjects(projectsSelection.get()),
  Backspace: () => trashProjects(projectsSelection.get()),
  ArrowLeft: () => moveProjectsSelection("left"),
  ArrowRight: () => moveProjectsSelection("right"),
  ArrowUp: () => moveProjectsSelection("up"),
  ArrowDown: () => moveProjectsSelection("down"),
  Escape: () => projectsSelection.clear(),
};

async function showOverview() {
  state.activePanel = "projects";
  invoke("clear_active_project");
  await loadProjectOrder();
  const projects = applyProjectOrder(await invoke("list_projects"));
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
      card.className = "project-card card";
      card.dataset.path = p.path;
      if (projectsSelection.has(p.path)) card.classList.add("is-selected");

      // Icon: the project's .studio-icon.png if present, else a letter avatar.
      // The img failing to load IS the existence check (no Rust call needed).
      const icon = document.createElement("img");
      icon.className = "card__icon";
      icon.src =
        window.__TAURI__.core.convertFileSrc(`${p.path}/.studio-icon.png`) +
        `?v=${iconVersion}`;
      icon.addEventListener("error", () => {
        const letter = document.createElement("div");
        letter.className = "card__icon card__icon--letter";
        letter.textContent = (p.name[0] || "?").toUpperCase();
        icon.replaceWith(letter);
      });
      card.append(icon);

      if (p.sprite) {
        const sprite = document.createElement("span");
        sprite.className = "card__sprite";
        const { "--sprite-start": start, "--sprite-end": end, ...rest } = spriteStyle(
          p.sprite,
          "idle",
          28,
        );
        Object.assign(sprite.style, rest);
        sprite.style.setProperty("--sprite-start", start);
        sprite.style.setProperty("--sprite-end", end);
        card.append(sprite);
      }

      const name = document.createElement("span");
      name.className = "card__name";
      name.textContent = p.name;
      card.append(name);

      if (p.modified) {
        const modified = document.createElement("span");
        modified.className = "card__modified";
        modified.textContent = relativeDate(p.modified * 1000);
        card.append(modified);
      }
      card.addEventListener("pointerdown", (e) =>
        onProjectCardPointerDown(e, p, card),
      );
      // Single-click selects; double-click opens (interaction-spec §3.4).
      card.addEventListener("click", (e) => {
        if (Date.now() - lastProjectDragEnd < 300) return; // ignore click after drag
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
      if (!e.target.closest(".project-card")) projectsSelection.clear();
    });
  }

  // Show only the overview.
  document.getElementById("project-header").hidden = true;
  document.getElementById("empty-state").hidden = true;
  document.getElementById("project-content").hidden = true;
  document.getElementById("overview").hidden = false;

  // Hide the editor side panel if it was open.
  const appRight = document.getElementById("app-right");
  if (appRight && !appRight.hidden) {
    appRight.hidden = true;
    document.getElementById("media-side").hidden = true;
    invoke("set_window_width", { width: Math.max(window.innerWidth - 320, 900) });
  }
}

// --- Tabs ------------------------------------------------------------------

export function selectTab(name) {
  state.activePanel = name;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("is-active", t.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });

  // The notes bento layout measures card heights; if it ran while the panel
  // was hidden every card collapsed to one row. Re-pack now that it's visible.
  // Also re-size textareas: their scrollHeight is 0 while hidden, so the
  // initial resize in buildTextNote leaves them at height 0px.
  if (name === "notes") {
    requestAnimationFrame(() => {
      document.querySelectorAll("#notes-list textarea").forEach((ta) => {
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
      });
      requestAnimationFrame(layoutBento);
    });
  }

  // Re-list artifacts when the tab opens (picks up ones Claude wrote). Claude
  // learns the artifact formats from the `studio-artifacts` skill, not a
  // per-project CLAUDE.md block.
  if (name === "artifacts") renderArtifacts();
  else clearArtifactsSelection();

  // Close the editor column when leaving the media tab.
  if (name !== "media") {
    const appRight = document.getElementById("app-right");
    if (appRight && !appRight.hidden) {
      appRight.hidden = true;
      document.getElementById("media-side").hidden = true;
      invoke("set_window_width", { width: Math.max(window.innerWidth - 320, 900) });
    }
  } else if (state.activeItem && mediaSelection.has(state.activeItem.path) && state.editorSidebarEnabled) {
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
      togglePinnedTab(activeTab);
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

function initAllProjectsButton() {
  document.getElementById("all-projects-btn").addEventListener("click", showOverview);
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

// --- Notes -----------------------------------------------------------------

state.notesData = { version: 1, notes: [] };
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
  // Delete note-owned image assets (under notes/); shared media/ files are left.
  for (const n of state.notesData.notes) {
    if (!ids.has(n.id) || !state.notesProjectPath) continue;
    if (n.kind === "image" && n.src)
      invoke("delete_note_asset", { projectPath: state.notesProjectPath, src: n.src });
    if (n.kind === "text" && n.image)
      invoke("delete_note_asset", { projectPath: state.notesProjectPath, src: n.image });
  }
  state.notesData.notes = state.notesData.notes.filter((n) => !ids.has(n.id));
  notesSelection.clear();
  renderNotes();
  scheduleNotesSave();
}

// Reorder the selected card by one position — single selection only.
function moveSelectedNote(delta) {
  if (notesSelection.size() !== 1) return;
  const id = notesSelection.get()[0];
  const idx = state.notesData.notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= state.notesData.notes.length) return;
  const [note] = state.notesData.notes.splice(idx, 1);
  state.notesData.notes.splice(newIdx, 0, note);
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
  if (note.kind === "image") return buildImageNote(note);
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

// --- Note copy / paste (interaction-spec §7) -------------------------------

function stripNoteForCopy(n) {
  const { id, createdAt, ...rest } = n;
  // Image notes carry an absolute source path so cross-project paste can copy
  // the file (the project-relative `src` is meaningless elsewhere).
  if (n.kind === "image" && state.notesProjectPath && n.src) {
    rest.srcAbs = `${state.notesProjectPath}/${n.src}`;
  }
  return rest;
}

// Resolve a copied image note's absolute source into this project: reuse the
// relative path if it's already ours, else copy the file into notes/.
async function materializeNoteImage(srcAbs) {
  if (!state.notesProjectPath) return "";
  const prefix = state.notesProjectPath + "/";
  if (srcAbs.startsWith(prefix)) return srcAbs.slice(prefix.length);
  try {
    return await invoke("copy_note_asset", {
      srcAbs,
      projectPath: state.notesProjectPath,
    });
  } catch (_) {
    return "";
  }
}

// Degraded plain-text form (external apps). Title (if any) leads as a heading.
function noteToPlainText(n) {
  let body;
  if (n.kind === "checklist")
    body = (n.items || [])
      .map((i) => `- [${i.done ? "x" : " "}] ${i.text || ""}`)
      .join("\n");
  else if (n.kind === "table")
    body = [n.columns || [], ...(n.rows || [])]
      .map((r) => r.join("\t"))
      .join("\n");
  else if (n.kind === "image") body = n.caption || "";
  else body = n.body || "";

  // Tables stay pure TSV (a title line would misalign spreadsheet paste); text
  // and checklists get the title as a leading heading.
  const title = (n.title || "").trim();
  return title && n.kind !== "table" ? `${title}\n${body}` : body;
}

// Mod+c: degraded text → system clipboard (for external apps); the rich
// Studio-native payload → an app-cache sidecar keyed by that text (§7.3). WebKit
// strips custom HTML on clipboard write, so the sidecar — not an HTML flavor —
// carries type + styling, and works across windows/projects.
function copyNotes() {
  const ids = new Set(notesSelection.get());
  const notes = state.notesData.notes.filter((n) => ids.has(n.id));
  if (!notes.length) return;
  const text = notes.map(noteToPlainText).join("\n\n");
  navigator.clipboard.writeText(text).catch((e) => console.error(e));
  invoke("set_note_clipboard", {
    data: JSON.stringify({ text, notes: notes.map(stripNoteForCopy) }),
  });
}

// Mod+v: use the rich sidecar if it still matches the live clipboard text
// (meaning the Studio copy is the most recent), else parse the system text.
// Reconstruct Studio-native notes from the sidecar if it still matches the live
// clipboard `text`. Returns true if it pasted. Shared by the Notes and Media
// paste paths so a copied note pastes the same from either tab.
async function tryPasteStudioNotes(text) {
  try {
    const stash = await invoke("get_note_clipboard");
    if (!stash) return false;
    const { text: stashText, notes } = JSON.parse(stash);
    if (!Array.isArray(notes) || stashText !== text) return false;
    const created = [];
    for (const n of notes) {
      const note = { ...n, id: genId(), createdAt: new Date().toISOString() };
      if (note.kind === "image" && note.srcAbs) {
        note.src = await materializeNoteImage(note.srcAbs);
      }
      delete note.srcAbs;
      created.push(note);
    }
    state.notesData.notes.unshift(...created);
    renderNotes();
    scheduleNotesSave();
    return true;
  } catch (_) {
    return false;
  }
}

async function pasteIntoNotes() {
  let text = "";
  try {
    text = await invoke("read_clipboard_text");
  } catch (_) {}

  if (await tryPasteStudioNotes(text)) return;

  const now = () => new Date().toISOString();

  if (text.includes("\t")) {
    const rows = text
      .trimEnd()
      .split(/\r?\n/)
      .map((r) => r.split("\t"));
    const columns = rows[0].map((h) => h.trim() || "Column");
    const dataRows = rows
      .slice(1)
      .map((r) => columns.map((_, ci) => (r[ci] ?? "").trim()));
    state.notesData.notes.unshift({
      id: genId(),
      kind: "table",
      title: "",
      columns,
      rows: dataRows,
      totals: [],
      createdAt: now(),
    });
  } else if (/\r?\n/.test(text.trim())) {
    // Multiple lines → checklist (interaction-spec §7.2).
    const items = text
      .trim()
      .split(/\r?\n/)
      .map((line) => ({ text: line.trim(), done: false }));
    state.notesData.notes.unshift({
      id: genId(),
      kind: "checklist",
      title: "",
      items,
      createdAt: now(),
    });
  } else if (text.trim()) {
    state.notesData.notes.unshift({
      id: genId(),
      kind: "text",
      title: "",
      body: text.trim(),
      createdAt: now(),
    });
  } else {
    // No text — clipboard image → image note (§9).
    if (!state.notesProjectPath) return;
    try {
      const src = await invoke("paste_note_image", {
        projectPath: state.notesProjectPath,
      });
      const { w, h } = await imageDims(`${state.notesProjectPath}/${src}`);
      state.notesData.notes.unshift({
        id: genId(),
        kind: "image",
        title: "",
        src,
        w,
        h,
        caption: "",
        createdAt: now(),
      });
      renderNotes();
      scheduleNotesSave();
    } catch (_) {
      // No image in clipboard — nothing to paste.
    }
    return;
  }
  renderNotes();
  scheduleNotesSave();
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
state.notesProjectPath = null;
let notesSaveTimer = null;



function setNotesStatus(text) {
  document.getElementById("notes-status").textContent = text;
}

function applyNotesFont() {
  const font = state.notesData.font || "system-ui";
  const listEl = document.getElementById("notes-list");
  const menu = document.getElementById("notes-font-menu");

  const btn = menu
    ? [...menu.querySelectorAll(".menu__item")].find((b) => b.dataset.font === font)
    : null;
  const size = state.notesData.fontSize || (btn?.dataset.size ? Number(btn.dataset.size) : 14);

  listEl.style.setProperty("--notes-font", font);
  listEl.style.setProperty("--notes-font-size", size + "px");

  // Mark active item.
  menu?.querySelectorAll(".menu__item").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.font === font);
  });
}

async function loadNotes(path) {
  state.notesProjectPath = path;
  const data = await invoke("read_notes", { path });
  state.notesData =
    data && Array.isArray(data.notes) ? data : { version: 1, notes: [] };
  setNotesStatus("");
  applyNotesFont();
  renderNotes();
}

export function scheduleNotesSave() {
  if (!state.notesProjectPath) return;
  setNotesStatus("Saving…");
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(async () => {
    try {
      await invoke("save_notes", { path: state.notesProjectPath, notes: state.notesData });
      setNotesStatus("");
    } catch (err) {
      setNotesStatus(`Error: ${err}`);
    }
  }, 400);
}

export async function pasteFromClipboard() {
  let text = "";
  try {
    text = await invoke("read_clipboard_text");
  } catch (_) {}

  // A copied Studio note reconstructs fully (and jumps to Notes), even from the
  // Media tab.
  if (await tryPasteStudioNotes(text)) {
    selectTab("notes");
    return;
  }

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
    state.notesData.notes.unshift({
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
    state.notesData.notes.unshift({
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
  state.notesData.notes.unshift(note);
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
  // Themed cards set their own title/body colors, so placeholders need a
  // dimmed version of that color rather than the default --text-soft.
  setCardVar(card, "--note-placeholder-opacity", theme.titleColor || theme.bodyColor ? "0.45" : "");
  setCardVar(card, "--note-meta-opacity", theme.titleColor || theme.bodyColor ? "0.7" : "");
  setCardVar(card, "--note-title-font", note.titleFont);
  // Overrides the list-level --notes-font for this card only.
  setCardVar(card, "--notes-font", note.bodyFont);
}

function noteHeader(note) {
  const head = el("div", "notecard__head");
  const title = el("textarea", "notecard__title", {
    placeholder: "^_^",
    rows: 1,
  });
  title.value = note.title || "";
  const resizeTitle = () => {
    title.style.height = "auto";
    title.style.height = title.scrollHeight + "px";
  };
  title.addEventListener("input", () => {
    note.title = title.value;
    resizeTitle();
    scheduleBentoLayout();
    scheduleNotesSave();
  });
  // Plain Enter inserts a newline (textarea default); nothing to special-case.
  requestAnimationFrame(resizeTitle);

  head.append(title);
  return head;
}

// "Yesterday" / "3 days ago" / "1 week ago" for recent dates; falls back to
// a plain date once it's more than a week old.
function relativeDate(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "1 week ago";
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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

// Resolve an image note's project-relative `src` to a displayable asset URL.
function noteImageUrl(src) {
  if (!state.notesProjectPath || !src) return "";
  return window.__TAURI__.core.convertFileSrc(`${state.notesProjectPath}/${src}`);
}

// Natural pixel size of an image at an absolute path (for bento sizing).
async function imageDims(absPath) {
  try {
    const img = await loadImage(window.__TAURI__.core.convertFileSrc(absPath));
    return { w: img.naturalWidth, h: img.naturalHeight };
  } catch {
    return { w: 0, h: 0 };
  }
}

function buildImageNote(note) {
  const card = el("div", "notecard");
  card.append(noteHeader(note));

  const img = el("img", "notecard__image", { alt: note.caption || "" });
  if (note.src) img.src = noteImageUrl(note.src);
  // Reserve height from known dimensions so bento sizing is right before load.
  if (note.w && note.h) img.style.aspectRatio = `${note.w} / ${note.h}`;
  img.addEventListener("load", () => scheduleBentoLayout());
  card.append(img);

  const cap = el("textarea", "notecard__caption", {
    placeholder: "Caption…",
    rows: 1,
  });
  cap.value = note.caption || "";
  const resizeCap = () => {
    cap.style.height = "auto";
    cap.style.height = cap.scrollHeight + "px";
  };
  cap.addEventListener("input", () => {
    note.caption = cap.value;
    resizeCap();
    scheduleBentoLayout();
    scheduleNotesSave();
  });
  requestAnimationFrame(resizeCap);
  card.append(cap);

  if (!Array.isArray(note.links)) note.links = [];
  const links = buildNoteLinks(note, cap, {
    getText: () => note.caption,
    setText: (v) => {
      note.caption = v;
      cap.value = v;
      resizeCap();
    },
  });
  card.append(links);
  return card;
}

// Builds the link-pill list for a note, harvesting any URLs out of its text
// field (via opts.getText/setText) into note.links (de-duped). Shared by
// text notes (body) and image notes (caption).
function buildNoteLinks(note, field, { getText, setText }) {
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

  // Pull any URLs out of the text into note.links (de-duped) and strip their
  // text. Returns true if anything changed.
  const harvestLinks = () => {
    const urls = extractUrls(getText());
    if (!urls.length) return false;
    let text = getText();
    for (const url of urls) {
      if (!note.links.includes(url)) note.links.push(url);
      text = text.split(url).join("");
    }
    // Tidy whitespace left behind by removed URLs.
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    setText(text);
    return true;
  };

  field.addEventListener("blur", () => {
    if (harvestLinks()) {
      renderLinks();
      scheduleBentoLayout();
      scheduleNotesSave();
    }
  });

  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    // Only harvest when the URL is on its own completed line, so we don't
    // interrupt mid-paste/mid-typing.
    requestAnimationFrame(() => {
      if (harvestLinks()) {
        renderLinks();
        scheduleBentoLayout();
        scheduleNotesSave();
      }
    });
  });

  // Migrate any links already sitting inline in saved notes.
  if (harvestLinks()) scheduleNotesSave();
  renderLinks();
  return links;
}

function buildTextNote(note) {
  const card = el("div", "notecard");
  card.append(noteHeader(note));

  if (!Array.isArray(note.links)) note.links = [];

  // Attached image (above text).
  const renderAttachedImage = () => {
    const existing = card.querySelector(".notecard__attached-image-wrap");
    if (existing) existing.remove();
    if (!note.image) return;
    const wrap = el("div", "notecard__attached-image-wrap");
    const img = el("img", "notecard__image", { alt: "" });
    img.src = noteImageUrl(note.image);
    if (note.imageW && note.imageH)
      img.style.aspectRatio = `${note.imageW} / ${note.imageH}`;
    img.addEventListener("load", () => scheduleBentoLayout());
    const removeBtn = el("button", "notecard__image-remove", { title: "Remove image" });
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.notesProjectPath && note.image)
        invoke("delete_note_asset", { projectPath: state.notesProjectPath, src: note.image });
      note.image = null;
      note.imageW = null;
      note.imageH = null;
      renderAttachedImage();
      scheduleBentoLayout();
      scheduleNotesSave();
    });
    wrap.append(img, removeBtn);
    const textarea = card.querySelector(".notecard__textarea");
    card.insertBefore(wrap, textarea);
  };

  const textarea = el("textarea", "notecard__textarea", {
    placeholder: "Write something…",
  });
  textarea.value = note.body || "";

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

  // Paste inside textarea: attach image to this note instead of creating a new one.
  textarea.addEventListener("paste", async (e) => {
    if (!state.notesProjectPath) return;
    try {
      const src = await invoke("paste_note_image", { projectPath: state.notesProjectPath });
      const { w, h } = await imageDims(`${state.notesProjectPath}/${src}`);
      // Remove previous image asset if there was one.
      if (note.image)
        invoke("delete_note_asset", { projectPath: state.notesProjectPath, src: note.image });
      note.image = src;
      note.imageW = w;
      note.imageH = h;
      renderAttachedImage();
      scheduleBentoLayout();
      scheduleNotesSave();
    } catch (_) {
      // No image in clipboard — let default text paste proceed.
    }
  });

  requestAnimationFrame(resizeTextarea);

  card.append(textarea);
  renderAttachedImage();
  const links = buildNoteLinks(note, textarea, {
    getText: () => note.body,
    setText: (v) => {
      note.body = v;
      textarea.value = v;
      resizeTextarea();
    },
  });
  card.append(links);
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

export function renderNotes() {
  const listEl = document.getElementById("notes-list");
  listEl.innerHTML = "";

  if (!state.notesData.notes.length) {
    listEl.append(
      el("p", "placeholder", {
        textContent:
          "No notes yet. Add a text note, checklist, or table above.",
      }),
    );
    return;
  }

  const isDaysView = (state.notesData.viewMode || "bento") === "days";
  listEl.classList.toggle("notes-list--days", isDaysView);
  updateNotesViewToggle();

  let lastDateKey = null;
  for (const note of state.notesData.notes) {
    if (isDaysView) {
      const d = note.createdAt ? new Date(note.createdAt) : null;
      const dateKey = d ? d.toDateString() : "Undated";
      if (dateKey !== lastDateKey) {
        lastDateKey = dateKey;
        listEl.append(
          el("div", "notes-day-header", {
            textContent: d
              ? d.toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })
              : "Undated",
          }),
        );
      }
    }
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
    } else if (note.kind === "image") {
      card = buildImageNote(note);
      card.classList.add("notecard--image");
    } else {
      continue;
    }
    card.append(noteFooter(note));
    card.dataset.noteId = note.id;
    card.style.gridColumn = isDaysView ? "" : `span ${note.span || 1}`;
    card.style.gridRowEnd = "";
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
            state.notesData.notes.map((n) => n.id),
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

  if (isDaysView) return;

  // Bento packing: card heights aren't known until textareas auto-size, so
  // measure on the next frames and translate each card's height into a
  // grid-row span. `grid-auto-flow: dense` then tiles them into the gaps.
  requestAnimationFrame(() => requestAnimationFrame(layoutBento));
}

function updateNotesViewToggle() {
  const view = state.notesData.viewMode || "bento";
  document.querySelectorAll("#notes-view-toggle .seg-toggle__btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === view);
  });
}

state.draggingNoteId = null;
let dropTargetIndex = null;
let noteDrag = null; // { note, card, startX, startY, active }
let lastNoteDragEnd = 0;

// The single selected note (style controls target exactly one); null if zero
// or many are selected.
function selectedNote() {
  const ids = notesSelection.get();
  return ids.length === 1
    ? state.notesData.notes.find((n) => n.id === ids[0]) || null
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
  noteThemeDrop?.setValue(note.theme || "default");
  noteTitleFontDrop?.setValue(note.titleFont || "");
  noteBodyFontDrop?.setValue(note.bodyFont || "");
}

let noteThemeDrop = null;
let noteTitleFontDrop = null;
let noteBodyFontDrop = null;

// A small custom dropdown for the per-card style controls (theme/font
// pickers): a trigger button showing the current choice, and a menu of
// options — each rendered with a colour swatch (themes) or in its own font
// (fonts) so you can preview the choice before picking it.
function createStyleDropdown(container, items, onSelect) {
  const hasSwatches = items.some((i) => "swatch" in i);
  const btn = el("button", "notedrop__btn", { type: "button" });
  const swatch = hasSwatches ? el("span", "notedrop__swatch") : null;
  const label = el("span", "notedrop__label");
  if (swatch) btn.append(swatch);
  btn.append(label, el("span", "mi mi-sm notedrop__chev", { textContent: "expand_more" }));

  const menu = el("div", "menu notedrop__menu", { hidden: true });
  items.forEach((item) => {
    const opt = el("button", "menu__item notedrop__item", {
      type: "button",
      textContent: item.label,
    });
    if (item.font) opt.style.fontFamily = item.font;
    if (item.swatch) {
      opt.prepend(el("span", "notedrop__swatch", { style: `background:${item.swatch}` }));
    } else if ("swatch" in item) {
      opt.prepend(el("span", "notedrop__swatch notedrop__swatch--none"));
    }
    opt.dataset.value = item.value;
    opt.addEventListener("click", () => {
      menu.hidden = true;
      setValue(item.value);
      onSelect(item.value);
    });
    menu.append(opt);
  });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) menu.hidden = true;
  });

  function setValue(value) {
    const item = items.find((i) => i.value === value) || items[0];
    label.textContent = item.label;
    if (swatch) {
      swatch.style.background = item.swatch || "";
      swatch.classList.toggle("notedrop__swatch--none", !item.swatch);
    }
    label.style.fontFamily = item.font || "";
    menu.querySelectorAll(".notedrop__item").forEach((opt) => {
      opt.classList.toggle("is-active", opt.dataset.value === item.value);
    });
  }

  container.append(btn, menu);
  setValue(items[0].value);
  return { setValue };
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
    state.draggingNoteId = noteDrag.note.id;
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
  state.draggingNoteId = null;
  hideDropIndicator();
  const to0 = dropTargetIndex;
  dropTargetIndex = null;
  if (to0 == null) return;
  const fromIdx = state.notesData.notes.findIndex((n) => n.id === drag.note.id);
  if (fromIdx === -1) return;
  let to = to0;
  const [note] = state.notesData.notes.splice(fromIdx, 1);
  if (fromIdx < to) to -= 1; // account for the removed element
  to = Math.max(0, Math.min(to, state.notesData.notes.length));
  state.notesData.notes.splice(to, 0, note);
  renderNotes();
  scheduleNotesSave();
}

// Where would a drop at the current pointer land? Returns the insertion index
// in state.notesData.notes, plus the card/edge to draw the indicator against.
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
  if (!listEl || listEl.classList.contains("notes-list--days")) return;

  const style = getComputedStyle(listEl);
  // Clamp card spans to the actual column count so wide cards don't overflow.
  const cols = style.gridTemplateColumns.split(" ").length;
  const row = parseFloat(style.gridAutoRows) || 8;
  const gap = parseFloat(style.rowGap) || 0;
  listEl.querySelectorAll(".notecard").forEach((card) => {
    const noteId = card.dataset.noteId;
    const note = noteId ? state.notesData.notes.find((n) => n.id === noteId) : null;
    card.style.gridColumn = `span ${Math.min(note?.span || 1, cols)}`;

    // Reset so we measure the card's natural (content) height.
    card.style.gridRowEnd = "";
    const h = card.getBoundingClientRect().height;
    const span = Math.max(1, Math.round((h + gap) / (row + gap)));
    card.style.gridRowEnd = `span ${span}`;
  });
}

let bentoLayoutTimer = null;
export function scheduleBentoLayout() {
  clearTimeout(bentoLayoutTimer);
  bentoLayoutTimer = setTimeout(layoutBento, 60);
}

function initNotes() {
  document.querySelectorAll("[data-new-note]").forEach((btn) => {
    btn.addEventListener("click", () => newNote(btn.dataset.newNote));
  });

  const viewToggle = document.getElementById("notes-view-toggle");
  updateNotesViewToggle();
  viewToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-toggle__btn");
    if (!btn) return;
    const view = btn.dataset.view;
    if (view === (state.notesData.viewMode || "bento")) return;
    state.notesData.viewMode = view;
    updateNotesViewToggle();
    renderNotes();
    scheduleNotesSave();
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
    state.notesData.font = item.dataset.font;
    state.notesData.fontSize = item.dataset.size ? Number(item.dataset.size) : 14;
    fontMenu.hidden = true;
    applyNotesFont();
    scheduleNotesSave();
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#notes-font-wrap")) fontMenu.hidden = true;
  });

  // Per-card style controls (toolbar) target the currently selected card.
  noteThemeDrop = createStyleDropdown(
    document.getElementById("note-theme-drop"),
    NOTE_THEMES.map((t) => ({ value: t.id, label: t.name, swatch: t.bg })),
    (value) => setSelectedNoteStyle("theme", value),
  );
  noteTitleFontDrop = createStyleDropdown(
    document.getElementById("note-titlefont-drop"),
    NOTE_FONTS.map((f) => ({ value: f.value, label: f.name, font: f.value })),
    (value) => setSelectedNoteStyle("titleFont", value),
  );
  noteBodyFontDrop = createStyleDropdown(
    document.getElementById("note-bodyfont-drop"),
    NOTE_FONTS.map((f) => ({ value: f.value, label: f.name, font: f.value })),
    (value) => setSelectedNoteStyle("bodyFont", value),
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
    "Mod+c": copyNotes,
    "Mod+v": pasteIntoNotes,
    Escape: clearNotesSelection,
  };
  panelKeymaps.artifacts = {
    Delete: deleteArtifactsSelection,
    Backspace: deleteArtifactsSelection,
    Escape: clearArtifactsSelection,
  };
  installKeyDispatcher({
    getActivePanel: () => state.activePanel,
    anyModalOpen,
    modalKeymap,
  });

  // Notes Mod+v paste is a Phase 2 feature (interaction-spec §7.2) — not yet
  // wired into panelKeymaps.notes.
}

// --- Boot ------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  initDevInspect();
  initTabs();
  initAllProjectsButton();
  initLaunch();
  initClaudeButton();
  initFileDirectoryButton();
  initSpriteBadge();
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
    if (state.activeProject && !document.getElementById("project-content").hidden) {
      loadMedia(state.activeProject.path);
      // Live-refresh the Artifacts panel when it's the one in view (picks up
      // files Claude writes into artifacts/). The ~/Projects watcher is
      // recursive, so changes under artifacts/ already arrive here.
      if (state.activePanel === "artifacts") renderArtifacts();
    }
    if (!document.getElementById("overview").hidden) {
      showOverview();
    }
  });
});
