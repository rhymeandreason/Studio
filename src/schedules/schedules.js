// Scheduled Tasks window: lists every project's recurring `claude -p` tasks,
// grouped into each project's 3 time slots. Mirrors the editor that used to
// live in the Workspace tab (see docs/workspace.md), but spans all projects
// under ~/Projects so it's reachable from anywhere.

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

// One entry per project: { project: {name, path, ...}, ws: Workspace, saveTimer }
let entries = [];

async function load() {
  const projects = await invoke("list_projects");
  entries = await Promise.all(
    projects.map(async (project) => ({
      project,
      ws: await invoke("read_workspace", { path: project.path }),
      saveTimer: null,
    })),
  );
  render();
}

function render() {
  const list = document.getElementById("schedules-list");
  list.innerHTML = "";
  entries.forEach((entry) => list.append(buildProjectSection(entry)));
}

function scheduleSave(entry) {
  clearTimeout(entry.saveTimer);
  entry.saveTimer = setTimeout(async () => {
    await invoke("save_workspace", { path: entry.project.path, workspace: entry.ws });
  }, 400);
}

function setDirty(dirty) {
  const btn = document.getElementById("schedules-save");
  btn.disabled = !dirty;
  btn.classList.toggle("btn-save", dirty);
  btn.innerHTML = dirty ? `${mi("check")}Save schedule` : `${mi("check")}Saved`;
}

async function saveAll() {
  const btn = document.getElementById("schedules-save");
  btn.disabled = true;
  for (const entry of entries) {
    clearTimeout(entry.saveTimer);
    await invoke("save_workspace", { path: entry.project.path, workspace: entry.ws });
  }
  await invoke("update_wake_schedule").catch((err) => console.error("update_wake_schedule:", err));
  setDirty(false);
}

function buildProjectSection(entry) {
  const { ws } = entry;
  ws.schedules = ws.schedules || [];
  ws.scheduleSlots = ws.scheduleSlots && ws.scheduleSlots.length === 3
    ? ws.scheduleSlots
    : ["09:00", "13:00", "17:00"];

  const section = el("div", "schedules-project");
  section.append(el("div", "schedules-project__head", { textContent: entry.project.name }));

  const slots = el("div", "schedules-project__slots");
  ws.scheduleSlots.forEach((_, slot) => slots.append(buildSlotGroup(entry, slot)));
  section.append(slots);

  return section;
}

function buildSlotGroup(entry, slot) {
  const { ws } = entry;
  const group = el("div", "ws-schedule-slot");

  const head = el("div", "ws-schedule-slot__head");
  const time = el("input", "ws-schedule-slot__time", {
    type: "time",
    value: ws.scheduleSlots[slot] || "09:00",
  });
  time.addEventListener("change", () => {
    const oldTime = ws.scheduleSlots[slot];
    ws.scheduleSlots[slot] = time.value;
    ws.schedules.forEach((task) => {
      if ((task.slot || 0) === slot && (task.time || oldTime) === oldTime) {
        task.time = time.value;
      }
    });
    setDirty(true);
    scheduleSave(entry);
  });

  const add = el("button", "btn-add", { type: "button" });
  add.innerHTML = `${mi("add")}Task`;
  add.addEventListener("click", () => addSchedule(entry, slot));

  head.append(time, add);
  group.append(head);

  const list = el("div", "ws-schedule-slot__list");
  ws.schedules
    .filter((task) => (task.slot || 0) === slot)
    .forEach((task) => list.append(buildScheduleRow(entry, task)));
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

function buildScheduleRow(entry, task) {
  const { ws } = entry;
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
    scheduleSave(entry);
  });
  requestAnimationFrame(resizePrompt);

  const controls = el("div", "ws-schedule__row");

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
      scheduleSave(entry);
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
    scheduleSave(entry);
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
    scheduleSave(entry);
  });

  const last = el("span", "ws-schedule__last", {});
  setLastRunText(last, task);

  controls.append(days, model, output, last);
  main.append(prompt, controls);

  const toggleInput = el("input", null, {
    type: "checkbox",
    checked: task.enabled !== false,
  });
  toggleInput.addEventListener("change", () => {
    task.enabled = toggleInput.checked;
    setDirty(true);
    scheduleSave(entry);
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
        projectPath: entry.project.path,
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
    ws.schedules = ws.schedules.filter((t) => t !== task);
    render();
    setDirty(true);
    scheduleSave(entry);
  });

  row.append(toggle, main, run, remove);
  return row;
}

function addSchedule(entry, slot) {
  entry.ws.schedules.push({
    id: genId(),
    prompt: "",
    time: entry.ws.scheduleSlots[slot] || "09:00",
    slot,
    days: [],
    enabled: true,
    model: "haiku",
    outputFile: "",
    lastRun: null,
  });
  render();
  setDirty(true);
  scheduleSave(entry);
}

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("schedules-save").addEventListener("click", saveAll);

  await load();

  listen("schedule-ran", ({ payload }) => {
    const entry = entries.find((e) => e.project.path === payload.projectPath);
    const task = entry?.ws.schedules.find((t) => t.id === payload.taskId);
    if (task) {
      task.lastRunAt = payload.lastRunAt;
      task.lastRunOk = payload.ok;
      render();
    }
  });
});
