// Scheduled Tasks window: 3 shared global time slots, each defined by a time +
// days (in the slot header). Tasks are assigned to a slot and inherit its
// timing; each task opens a tool (e.g. Daily Briefing) when it fires — the
// tool does its own work on load. Empty slots are hidden. Backed by a single
// global store (read_schedules / save_schedules); see docs/workspace.md.
// (Legacy `claude -p` prompt tasks with no `tool` still run headlessly via the
// backend, but new tasks created here are tool-openers.)

import { el, mi, genId } from "../dom.js";
import { initDevInspect } from "../devinspect.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

const DEFAULT_SLOTS = [
  { time: "09:00", days: [] },
  { time: "17:00", days: [] },
];

// { slots: [{time, days}…], tasks: [task…] } — the whole global store.
let store = { slots: DEFAULT_SLOTS.map((s) => ({ ...s })), tasks: [] };
// Tools offered in each task's dropdown — [{ name, file }].
let tools = [];
let saveTimer = null;
// The wake-schedule signature currently applied to the system (matches the
// backend's wake-signature.txt). The "Save schedule" button shows only when
// the live signature differs from this. On load we assume they're in sync.
let appliedSignature = "";

async function load() {
  const raw = await invoke("read_schedules");
  const parsed = raw ? JSON.parse(raw) : null;
  const slots = parsed?.slots?.length ? parsed.slots : DEFAULT_SLOTS;
  store = {
    slots: slots.map((s) =>
      typeof s === "string" ? { time: s, days: [] } : { time: s.time || "09:00", days: s.days || [] },
    ),
    tasks: parsed?.tasks || [],
  };
  tools = await invoke("list_tools");
  appliedSignature = wakeSignature();
  render();
}

// Mirror of the backend's `wake_signature`: the time + sorted days of each
// slot that has at least one enabled task. Editing anything that doesn't
// change this (prompt/model/output/project, or a slot nobody uses) leaves it
// untouched — so it's exactly what decides whether the admin prompt is needed.
function wakeSignature() {
  return store.slots
    .map((slot, idx) => {
      const used = store.tasks.some((t) => (t.slot || 0) === idx && t.enabled !== false);
      if (!used) return null;
      const days = [...(slot.days || [])].sort((a, b) => a - b).join(",");
      return `${slot.time}@${days}`;
    })
    .filter((s) => s !== null)
    .sort()
    .join(";");
}

// Light the "Save schedule" button only when the wake schedule truly changed.
function refreshDirty() {
  setDirty(wakeSignature() !== appliedSignature);
}

function render() {
  const list = document.getElementById("schedules-list");
  list.innerHTML = "";
  store.slots.forEach((_, slot) => {
    const tasks = store.tasks.filter((t) => (t.slot || 0) === slot);
    list.append(buildSlotGroup(slot, tasks));
  });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_schedules", { data: JSON.stringify(store) });
  }, 400);
}

// All edits autosave to the global store via scheduleSave(). The "Save
// schedule" button (and the admin-password pmset step behind it) is driven by
// refreshDirty(): it appears only when the wake signature changes, so edits
// that don't affect wake times never surface it.
function setDirty(dirty) {
  const btn = document.getElementById("schedules-save");
  btn.disabled = !dirty;
  btn.classList.toggle("btn-main", dirty);
  btn.innerHTML = dirty ? `${mi("check")}Save schedule` : `${mi("check")}Saved`;
}

async function saveAll() {
  clearTimeout(saveTimer);
  document.getElementById("schedules-save").disabled = true;
  await invoke("save_schedules", { data: JSON.stringify(store) });
  await invoke("update_wake_schedule").catch((err) => console.error("update_wake_schedule:", err));
  appliedSignature = wakeSignature();
  setDirty(false);
}

function buildSlotGroup(slot, tasks) {
  const def = store.slots[slot];
  const group = el("div", "ws-schedule-slot");

  const head = el("div", "ws-schedule-slot__head");
  const time = el("input", "ws-schedule-slot__time", {
    type: "time",
    value: def.time || "09:00",
  });
  time.addEventListener("change", () => {
    def.time = time.value;
    refreshDirty();
    scheduleSave();
  });

  const days = el("div", "ws-schedule__days");
  DAY_LABELS.forEach((label, idx) => {
    const day = el("button", "ws-schedule__day", { type: "button", textContent: label });
    day.title = "Toggle day (none selected = every day)";
    day.classList.toggle("is-active", def.days?.includes(idx));
    day.addEventListener("click", () => {
      def.days = def.days || [];
      const at = def.days.indexOf(idx);
      if (at === -1) def.days.push(idx);
      else def.days.splice(at, 1);
      day.classList.toggle("is-active", def.days.includes(idx));
      refreshDirty();
      scheduleSave();
    });
    days.append(day);
  });

  const add = el("button", "btn-add", { type: "button" });
  add.innerHTML = `${mi("add")}Task`;
  add.addEventListener("click", () => addSchedule(slot));

  head.append(time, days, add);
  group.append(head);

  const list = el("div", "ws-schedule-slot__list");
  tasks.forEach((task) => list.append(buildScheduleRow(task)));
  group.append(list);

  return group;
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

  const controls = el("div", "ws-schedule__row");

  const tool = el("select", "ws-schedule__tool", {
    title: "Tool this task opens when it fires",
  });
  tool.append(el("option", null, { value: "", textContent: "Pick a tool…" }));
  tools.forEach((t) => {
    tool.append(el("option", null, { value: t.file, textContent: t.name }));
  });
  tool.value = task.tool || "";
  tool.addEventListener("change", () => {
    task.tool = tool.value;
    scheduleSave();
  });

  const last = el("span", "ws-schedule__last", {});
  setLastRunText(last, task);

  controls.append(tool, last);
  main.append(controls);

  const toggleInput = el("input", null, {
    type: "checkbox",
    checked: task.enabled !== false,
  });
  toggleInput.addEventListener("change", () => {
    task.enabled = toggleInput.checked;
    refreshDirty();
    scheduleSave();
  });
  const toggleTrack = el("span", "claude-toggle__track");
  toggleTrack.append(el("span", "claude-toggle__thumb"));
  const toggle = el("label", "ws-schedule__toggle claude-toggle", { title: "Enabled" });
  toggle.append(toggleInput, toggleTrack);

  const run = el("button", "ws-schedule__run", { type: "button", title: "Open now" });
  run.innerHTML = mi("play_arrow");
  run.addEventListener("click", async () => {
    if (!task.tool) return;
    run.disabled = true;
    run.innerHTML = mi("hourglass_top");
    try {
      await invoke("open_tool", { file: task.tool, query: null });
    } finally {
      run.disabled = false;
      run.innerHTML = mi("play_arrow");
    }
  });

  const remove = el("button", "btn-remove", { type: "button", title: "Remove" });
  remove.innerHTML = mi("close");
  remove.addEventListener("click", () => {
    store.tasks = store.tasks.filter((t) => t !== task);
    render();
    refreshDirty();
    scheduleSave();
  });

  row.append(toggle, main, run, remove);
  return row;
}

function addSchedule(slot) {
  store.tasks.push({
    id: genId(),
    tool: "",
    slot,
    enabled: true,
    lastRun: null,
  });
  render();
  refreshDirty();
  scheduleSave();
}

window.addEventListener("DOMContentLoaded", async () => {
  initDevInspect();
  document.getElementById("schedules-save").addEventListener("click", saveAll);

  await load();

  listen("schedule-ran", ({ payload }) => {
    const task = store.tasks.find((t) => t.id === payload.taskId);
    if (task) {
      task.lastRunAt = payload.lastRunAt;
      task.lastRunOk = payload.ok;
      render();
    }
  });
});
