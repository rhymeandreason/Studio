// Studio frontend shell.
// M3: tabbed project view with a working Workspace form, plus the New Project
// flow. The tray (Rust side) owns discovery/activation; commands handle the
// filesystem work.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let activeProject = null;

// --- Project rendering -----------------------------------------------------

function render(project) {
  activeProject = project;
  const empty = document.getElementById("empty-state");
  const content = document.getElementById("project-content");
  const header = document.getElementById("project-header");
  const overview = document.getElementById("overview");

  overview.hidden = true; // activating a project leaves the overview

  if (project) {
    document.getElementById("project-name").textContent = project.name;
    document.getElementById("project-path").textContent = project.path;
    header.hidden = false;
    empty.hidden = true;
    content.hidden = false;
    loadWorkspace(project.path);
  } else {
    header.hidden = true;
    empty.hidden = false;
    content.hidden = true;
  }
}

// --- All-projects overview -------------------------------------------------

async function showOverview() {
  const projects = await invoke("list_projects");
  const grid = document.getElementById("overview-grid");
  grid.innerHTML = "";

  if (projects.length === 0) {
    const note = document.createElement("p");
    note.className = "placeholder";
    note.textContent = "No projects yet. Use “New Project…” in the menu bar.";
    grid.append(note);
  } else {
    for (const p of projects) {
      const card = document.createElement("button");
      card.className = "card";
      if (activeProject && activeProject.path === p.path) {
        card.classList.add("is-active");
      }
      const name = document.createElement("span");
      name.className = "card__name";
      name.textContent = p.name;
      const path = document.createElement("span");
      path.className = "card__path";
      path.textContent = p.path;
      card.append(name, path);
      card.addEventListener("click", () => invoke("open_project", { path: p.path }));
      grid.append(card);
    }
  }

  // Show only the overview.
  document.getElementById("project-header").hidden = true;
  document.getElementById("empty-state").hidden = true;
  document.getElementById("project-content").hidden = true;
  document.getElementById("overview").hidden = false;
}

// --- Tabs ------------------------------------------------------------------

function selectTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("is-active", t.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
}

function initTabs() {
  document.getElementById("tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) selectTab(tab.dataset.tab);
  });
}

// --- Workspace form --------------------------------------------------------

function listContainer(list) {
  return document.querySelector(`.listfield[data-list="${list}"] [data-rows]`);
}

function addRow(list, value = "") {
  const rows = listContainer(list);
  const row = document.createElement("div");
  row.className = "listfield__row";
  const input = document.createElement("input");
  input.className = "field__input";
  input.value = value;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-remove";
  remove.textContent = "✕";
  remove.addEventListener("click", () => row.remove());
  row.append(input, remove);
  rows.append(row);
}

function readList(list) {
  return [...listContainer(list).querySelectorAll("input")]
    .map((i) => i.value.trim())
    .filter(Boolean);
}

function setList(list, values) {
  listContainer(list).innerHTML = "";
  (values || []).forEach((v) => addRow(list, v));
}

async function loadWorkspace(path) {
  const ws = await invoke("read_workspace", { path });
  document.getElementById("ws-repo").value = ws.repo || "";
  document.getElementById("ws-figma").value = ws.figma || "";
  document.getElementById("ws-claude").value =
    ws.claude && ws.claude.mode ? ws.claude.mode : "terminal";
  setList("apps", ws.apps);
  setList("files", ws.files);
  setList("urls", ws.urls);
  setStatus("");
}

function setStatus(text) {
  document.getElementById("ws-status").textContent = text;
}

async function saveWorkspace(e) {
  e.preventDefault();
  if (!activeProject) return;
  const workspace = {
    repo: document.getElementById("ws-repo").value.trim(),
    figma: document.getElementById("ws-figma").value.trim(),
    claude: { mode: document.getElementById("ws-claude").value },
    apps: readList("apps"),
    files: readList("files"),
    urls: readList("urls"),
  };
  try {
    await invoke("save_workspace", { path: activeProject.path, workspace });
    setStatus("Saved ✓");
  } catch (err) {
    setStatus(`Error: ${err}`);
  }
}

function initWorkspaceForm() {
  document
    .querySelectorAll(".listfield [data-add]")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        addRow(btn.closest(".listfield").dataset.list)
      )
    );
  document.getElementById("ws-form").addEventListener("submit", saveWorkspace);
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
  document.getElementById("new-create").addEventListener("click", createProject);
  document.getElementById("new-cancel").addEventListener("click", closeNewModal);
  document.getElementById("new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") createProject();
    if (e.key === "Escape") closeNewModal();
  });
}

// --- Boot ------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  initWorkspaceForm();
  initNewModal();

  render(await invoke("get_active_project"));
  selectTab("workspace");

  await listen("project-activated", (event) => render(event.payload));
  await listen("new-project-request", openNewModal);
  await listen("show-overview", showOverview);
});
