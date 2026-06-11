// Scheduled Tasks window: 3 shared global time slots, each holding any number
// of recurring `claude -p` tasks. Each task picks which project folder it runs
// in via a dropdown (default "Global" = the ~/Projects root). Backed by a
// single global store (read_schedules / save_schedules); see docs/workspace.md.

import { el, mi, genId } from "../dom.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

const SCHEDULE_MODELS = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "fable", label: "Fable" },
];

const DEFAULT_SLOTS = ["09:00", "13:00", "17:00"];

// { slots: ["HH:MM" ×3], tasks: [task…] } — the whole global schedules store.
let store = { slots: [...DEFAULT_SLOTS], tasks: [] };
// Projects offered in each task's dropdown ("" = Global / ~/Projects root).
let projects = [];
let saveTimer = null;

async function load() {
  const raw = await invoke("read_schedules");
  const parsed = raw ? JSON.parse(raw) : null;
  store = {
    slots: parsed?.slots?.length === 3 ? parsed.slots : [...DEFAULT_SLOTS],
    tasks: parsed?.tasks || [],
  };
  projects = await invoke("list_projects");
  render();
}

function render() {
  const list = document.getElementById("schedules-list");
  list.innerHTML = "";
  store.slots.forEach((_, slot) => list.append(buildSlotGroup(slot)));
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_schedules", { data: JSON.stringify(store) });
  }, 400);
}

function setDirty(dirty) {
  const btn = document.getElementById("schedules-save");
  btn.disabled = !dirty;
  btn.classList.toggle("btn-save", dirty);
  btn.innerHTML = dirty ? `${mi("check")}Save schedule` : `${mi("check")}Saved`;
}

async function saveAll() {
  clearTimeout(saveTimer);
  document.getElementById("schedules-save").disabled = true;
  await invoke("save_schedules", { data: JSON.stringify(store) });
  await invoke("update_wake_schedule").catch((err) => console.error("update_wake_schedule:", err));
  setDirty(false);
}

function buildSlotGroup(slot) {
  const group = el("div", "ws-schedule-slot");

  const head = el("div", "ws-schedule-slot__head");
  const time = el("input", "ws-schedule-slot__time", {
    type: "time",
    value: store.slots[slot] || "09:00",
  });
  time.addEventListener("change", () => {
    const oldTime = store.slots[slot];
    store.slots[slot] = time.value;
    store.tasks.forEach((task) => {
      if ((task.slot || 0) === slot && (task.time || oldTime) === oldTime) {
        task.time = time.value;
      }
    });
    setDirty(true);
    scheduleSave();
  });

  const add = el("button", "btn-add", { type: "button" });
  add.innerHTML = `${mi("add")}Task`;
  add.addEventListener("click", () => addSchedule(slot));

  head.append(time, add);
  group.append(head);

  const list = el("div", "ws-schedule-slot__list");
  store.tasks
    .filter((task) => (task.slot || 0) === slot)
    .forEach((task) => list.append(buildScheduleRow(task)));
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
    setDirty(true);
    scheduleSave();
  });
  requestAnimationFrame(resizePrompt);

  const controls = el("div", "ws-schedule__row");

  const project = el("select", "ws-schedule__project", {
    title: "Project folder this task runs in",
  });
  project.append(el("option", null, { value: "", textContent: "Global" }));
  projects.forEach((p) => {
    project.append(el("option", null, { value: p.path, textContent: p.name }));
  });
  project.value = task.projectPath || "";
  project.addEventListener("change", () => {
    task.projectPath = project.value;
    setDirty(true);
    scheduleSave();
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
      setDirty(true);
      scheduleSave();
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
    setDirty(true);
    scheduleSave();
  });

  const output = el("input", "ws-schedule__output", {
    type: "text",
    placeholder: "Scheduled Output.md",
    value: task.outputFile || "",
    title: "Markdown file (in the project folder) the result is written to",
  });
  output.addEventListener("change", () => {
    task.outputFile = output.value.trim();
    setDirty(true);
    scheduleSave();
  });

  const last = el("span", "ws-schedule__last", {});
  setLastRunText(last, task);

  controls.append(project, days, model, output, last);
  main.append(prompt, controls);

  const toggleInput = el("input", null, {
    type: "checkbox",
    checked: task.enabled !== false,
  });
  toggleInput.addEventListener("change", () => {
    task.enabled = toggleInput.checked;
    setDirty(true);
    scheduleSave();
  });
  const toggleTrack = el("span", "claude-toggle__track");
  toggleTrack.append(el("span", "claude-toggle__thumb"));
  const toggle = el("label", "ws-schedule__toggle claude-toggle", { title: "Enabled" });
  toggle.append(toggleInput, toggleTrack);

  const run = el("button", "ws-schedule__run", { type: "button", title: "Run now" });
  run.innerHTML = mi("play_arrow");
  run.addEventListener("click", async () => {
    run.disabled = true;
    run.innerHTML = mi("hourglass_top");
    try {
      await invoke("run_schedule_now", {
        projectPath: task.projectPath || "",
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
    store.tasks = store.tasks.filter((t) => t !== task);
    render();
    setDirty(true);
    scheduleSave();
  });

  row.append(toggle, main, run, remove);
  return row;
}

function addSchedule(slot) {
  store.tasks.push({
    id: genId(),
    prompt: "",
    time: store.slots[slot] || "09:00",
    slot,
    days: [],
    enabled: true,
    model: "haiku",
    outputFile: "",
    projectPath: "",
    lastRun: null,
  });
  render();
  setDirty(true);
  scheduleSave();
}

window.addEventListener("DOMContentLoaded", async () => {
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
