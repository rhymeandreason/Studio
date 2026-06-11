// Workspace tab: launch button, the Workspace form (repo/figma/apps/files/
// folders/urls cards), and its autosave. Extracted from main.js. See
// interaction-spec / BACKLOG file-split.

import { el, mi, genId } from "./dom.js";
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

// --- Workspace launch --------------------------------------------------------

const LAUNCH_LABEL = `${mi("rocket_launch")}Launch workspace`;

export function initClaudeButton() {
  const btn = document.getElementById("claude-btn");
  btn.addEventListener("click", () => {
    if (!state.activeProject) return;
    invoke("open_claude_window", { projectPath: state.activeProject.path });
  });
}

export function initLaunch() {
  const btn = document.getElementById("launch-btn");
  btn.addEventListener("click", async () => {
    if (!state.activeProject) return;
    btn.disabled = true;
    btn.innerHTML = `${mi("hourglass_top")}Launching…`;
    try {
      await invoke("launch_workspace", { path: state.activeProject.path });
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
  folders: {
    icon: "folder_open",
    label: "Folder",
    placeholder: "~/some/folder",
    browse: "dir",
  },
  urls: { icon: "link", label: "URL", placeholder: "https://…" },
};

// Code editors offered for the Repo card's "Open in" picker. Empty value =
// Zed, the Rust-side default when `editor` is blank.
const EDITOR_OPTIONS = [
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

export function addRow(list, value = "") {
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
  card.append(input);

  // Repo card: "Open in" editor picker.
  if (list === "repo") {
    const editorSel = document.createElement("select");
    editorSel.className = "ws-item__editor";
    editorSel.title = "Open in";
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
    card.append(editorSel);
  }

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
let wsSprite = DEFAULT_SPRITE;

export async function loadWorkspace(path) {
  const ws = await invoke("read_workspace", { path });
  wsEditor = ws.editor || "";
  wsClaude = ws.claude && ws.claude.mode ? ws.claude.mode : "terminal";
  wsSprite = ws.sprite || DEFAULT_SPRITE;
  setList("repo", ws.repo ? [ws.repo] : []);
  setList("figma", ws.figma ? [ws.figma] : []);
  setList("apps", ws.apps);
  setList("files", ws.files);
  setList("folders", ws.folders);
  setList("urls", ws.urls);
  setStatus("");
  wsPinnedTab = ws.pinnedTab || null;
  selectTab(wsPinnedTab || "workspace");
  updatePinButton();
  renderSpriteBadge();
  wsSchedules = ws.schedules || [];
  renderSchedules();
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
let wsEditor = "";
let wsPinnedTab = null;
let wsSchedules = [];

function readWorkspaceForm() {
  return {
    repo: readList("repo")[0] || "",
    editor: wsEditor,
    figma: readList("figma")[0] || "",
    claude: { mode: wsClaude },
    apps: readList("apps"),
    files: readList("files"),
    folders: readList("folders"),
    urls: readList("urls"),
    pinnedTab: wsPinnedTab,
    sprite: wsSprite,
    schedules: wsSchedules,
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
  setStatus("Saving…");
  clearTimeout(wsSaveTimer);
  wsSaveTimer = setTimeout(saveWorkspaceNow, 400);
}

// --- Scheduled tasks ---------------------------------------------------------
//
// Each entry runs `claude -p <prompt>` headless in the project's repo at a
// given local time, on the selected days (none selected = every day). The
// scheduling loop lives in Rust (`start_scheduler`); this UI just edits the
// `schedules` array persisted in workspace.json.

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

const SCHEDULE_MODELS = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "fable", label: "Fable" },
];

function schedulesContainer() {
  return document.getElementById("ws-schedules");
}

function renderSchedules() {
  const container = schedulesContainer();
  container.innerHTML = "";
  wsSchedules.forEach((task) => container.append(buildScheduleRow(task)));
}

function setLastRunText(span, task) {
  if (!task.lastRunAt) {
    span.textContent = "";
    return;
  }
  const mark = task.lastRunOk === false ? "✗ " : task.lastRunOk === true ? "✓ " : "";
  span.textContent = `${mark}Last ran ${task.lastRunAt}`;
  span.classList.toggle("is-error", task.lastRunOk === false);
}

function buildScheduleRow(task) {
  const row = el("div", "ws-schedule");

  const main = el("div", "ws-schedule__main");

  const prompt = el("textarea", "ws-schedule__prompt", {
    placeholder: "Prompt for claude -p…",
    rows: 1,
    value: task.prompt || "",
  });
  const resizePrompt = () => {
    prompt.style.height = "auto";
    prompt.style.height = prompt.scrollHeight + "px";
  };
  prompt.addEventListener("input", () => {
    task.prompt = prompt.value;
    resizePrompt();
    scheduleWorkspaceSave();
  });
  requestAnimationFrame(resizePrompt);

  const controls = el("div", "ws-schedule__row");

  const time = el("input", "ws-schedule__time", {
    type: "time",
    value: task.time || "09:00",
  });
  time.addEventListener("change", () => {
    task.time = time.value;
    scheduleWorkspaceSave();
  });

  const days = el("div", "ws-schedule__days");
  DAY_LABELS.forEach((label, idx) => {
    const day = el("button", "ws-schedule__day", { type: "button", textContent: label });
    day.title = "Toggle day (none selected = every day)";
    day.classList.toggle("is-active", task.days?.includes(idx));
    day.addEventListener("click", () => {
      task.days = task.days || [];
      const at = task.days.indexOf(idx);
      if (at === -1) task.days.push(idx);
      else task.days.splice(at, 1);
      day.classList.toggle("is-active", task.days.includes(idx));
      scheduleWorkspaceSave();
    });
    days.append(day);
  });

  const model = el("select", "ws-schedule__model");
  SCHEDULE_MODELS.forEach((opt) => {
    model.append(el("option", null, { value: opt.value, textContent: opt.label }));
  });
  model.value = task.model || "haiku";
  model.addEventListener("change", () => {
    task.model = model.value;
    scheduleWorkspaceSave();
  });

  const output = el("input", "ws-schedule__output", {
    type: "text",
    placeholder: "Scheduled Output.md",
    value: task.outputFile || "",
    title: "Markdown file (in the project folder) the result is written to",
  });
  output.addEventListener("change", () => {
    task.outputFile = output.value.trim();
    scheduleWorkspaceSave();
  });

  const last = el("span", "ws-schedule__last", {});
  setLastRunText(last, task);

  controls.append(time, days, model, output, last);
  main.append(prompt, controls);

  const toggle = el("button", "ws-schedule__toggle", {
    type: "button",
    title: "Enabled",
  });
  toggle.innerHTML = mi("history_toggle_off");
  toggle.classList.toggle("is-active", task.enabled !== false);
  toggle.addEventListener("click", () => {
    task.enabled = task.enabled === false;
    toggle.classList.toggle("is-active", task.enabled !== false);
    scheduleWorkspaceSave();
  });

  const run = el("button", "ws-schedule__run", { type: "button", title: "Run now" });
  run.innerHTML = mi("play_arrow");
  run.addEventListener("click", async () => {
    run.disabled = true;
    run.innerHTML = mi("hourglass_top");
    try {
      await invoke("run_schedule_now", {
        projectPath: state.activeProject.path,
        prompt: task.prompt,
        model: task.model || "haiku",
        outputFile: task.outputFile || "",
        taskId: task.id,
      });
    } finally {
      run.disabled = false;
      run.innerHTML = mi("play_arrow");
    }
  });

  const remove = el("button", "btn-remove", { type: "button", title: "Remove" });
  remove.innerHTML = mi("close");
  remove.addEventListener("click", () => {
    wsSchedules = wsSchedules.filter((t) => t !== task);
    renderSchedules();
    scheduleWorkspaceSave();
  });

  row.append(toggle, main, run, remove);
  return row;
}

function addSchedule() {
  wsSchedules.push({
    id: genId(),
    prompt: "",
    time: "09:00",
    days: [],
    enabled: true,
    model: "haiku",
    outputFile: "",
    lastRun: null,
  });
  renderSchedules();
  scheduleWorkspaceSave();
}

export function initSchedules() {
  document.getElementById("ws-schedule-add").addEventListener("click", addSchedule);

  const { listen } = window.__TAURI__.event;
  listen("schedule-ran", ({ payload }) => {
    if (!state.activeProject || payload.projectPath !== state.activeProject.path) return;
    const task = wsSchedules.find((t) => t.id === payload.taskId);
    if (task) {
      task.lastRunAt = payload.lastRunAt;
      task.lastRunOk = payload.ok;
      renderSchedules();
    }
  });
}

// --- Memory usage display (header, top right) -------------------------------

let memTimer = null;

async function refreshMemory() {
  const sysEl = document.getElementById("mem-system");
  if (!sysEl) return;
  try {
    const stats = await invoke("get_memory_stats");
    sysEl.textContent = `Memory: ${stats.system_used_gb.toFixed(1)} / ${stats.system_total_gb.toFixed(0)} GB`;
  } catch (_) {
    sysEl.textContent = "";
  }
}

function startMemoryPolling() {
  refreshMemory();
  clearInterval(memTimer);
  memTimer = setInterval(refreshMemory, 5000);
}

async function openMemoryModal() {
  const modal = document.getElementById("memory-modal");
  const current = document.getElementById("mem-modal-current");
  const list = document.getElementById("mem-modal-list");
  current.textContent = "Loading…";
  list.innerHTML = "";
  modal.hidden = false;

  try {
    const [stats, procs] = await Promise.all([
      invoke("get_memory_stats"),
      invoke("get_top_processes"),
    ]);
    current.innerHTML = "";
    current.append(
      el("div", null, {
        textContent: `Memory: ${stats.system_used_gb.toFixed(1)} / ${stats.system_total_gb.toFixed(0)} GB`,
      }),
      el("div", null, { textContent: `Studio app: ${stats.app_mb.toFixed(0)} MB` }),
      el("div", null, { textContent: `Swap used: ${stats.swap_used_mb.toFixed(0)} MB` }),
    );
    if (stats.dev_server_mb) {
      current.append(
        el("div", null, { textContent: `Dev server: ${stats.dev_server_mb.toFixed(0)} MB` }),
      );
    }
    procs.forEach((p) => {
      const tr = el("tr");
      const label = p.count > 1 ? `${p.name} (${p.count})` : p.name;
      tr.append(
        el("td", null, { textContent: label }),
        el("td", null, { textContent: `${p.mb.toFixed(0)} MB` }),
      );
      list.append(tr);
    });
  } catch (err) {
    current.textContent = `Error: ${err}`;
  }
}

function closeMemoryModal() {
  document.getElementById("memory-modal").hidden = true;
}

function initMemoryModal() {
  document
    .getElementById("projhead-memory")
    .addEventListener("click", openMemoryModal);
  document
    .getElementById("memory-modal-close")
    .addEventListener("click", closeMemoryModal);
}

export function initWorkspaceForm() {
  startMemoryPolling();
  initMemoryModal();
  initSchedules();

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

  // Same for schedule prompts: their height can't be measured while the
  // Workspace tab is hidden (scrollHeight is 0), so recompute once visible.
  const schedules = document.getElementById("ws-schedules");
  new ResizeObserver(() => {
    schedules.querySelectorAll(".ws-schedule__prompt").forEach((ta) => {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    });
  }).observe(schedules);
}
