// Studio frontend shell.
// M3: tabbed project view with a working Workspace form, plus the New Project
// flow. The tray (Rust side) owns discovery/activation; commands handle the
// filesystem work.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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

  overview.hidden = true; // activating a project leaves the overview

  if (project) {
    document.getElementById("project-name").textContent = project.name;
    document.getElementById("project-path").textContent = project.path;
    header.hidden = false;
    empty.hidden = true;
    content.hidden = false;
    loadWorkspace(project.path);
    loadNotes(project.path);
  } else {
    header.hidden = true;
    empty.hidden = false;
    content.hidden = true;
    notesProjectPath = null;
    notesData = { version: 1, notes: [] };
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

// --- Workspace launch ------------------------------------------------------

function initLaunch() {
  const btn = document.getElementById("launch-btn");
  btn.addEventListener("click", async () => {
    if (!activeProject) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Launching…";
    try {
      await invoke("launch_workspace", { path: activeProject.path });
      btn.textContent = "Launched ✓";
    } catch (err) {
      btn.textContent = `Error: ${err}`;
    }
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1500);
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
  row.append(input);

  // Files and apps get a native picker; URLs are typed.
  if (list === "files" || list === "apps") {
    const browse = document.createElement("button");
    browse.type = "button";
    browse.className = "btn-browse";
    browse.textContent = "Browse…";
    browse.addEventListener("click", async () => {
      const picked =
        list === "apps"
          ? await pickPath({
              defaultPath: "/Applications",
              filters: [{ name: "Applications", extensions: ["app"] }],
            })
          : await pickPath({});
      if (picked) {
        input.value = list === "apps" ? appNameFromPath(picked) : picked;
        scheduleWorkspaceSave();
      }
    });
    row.append(browse);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-remove";
  remove.textContent = "✕";
  remove.addEventListener("click", () => {
    row.remove();
    scheduleWorkspaceSave();
  });
  row.append(remove);
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
  document.getElementById("ws-editor").value = ws.editor || "";
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

let wsSaveTimer = null;

function readWorkspaceForm() {
  return {
    repo: document.getElementById("ws-repo").value.trim(),
    editor: document.getElementById("ws-editor").value.trim(),
    figma: document.getElementById("ws-figma").value.trim(),
    claude: { mode: document.getElementById("ws-claude").value },
    apps: readList("apps"),
    files: readList("files"),
    urls: readList("urls"),
  };
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
    .querySelectorAll(".listfield [data-add]")
    .forEach((btn) =>
      btn.addEventListener("click", () =>
        addRow(btn.closest(".listfield").dataset.list)
      )
    );
  document.getElementById("ws-repo-browse").addEventListener("click", async () => {
    const picked = await pickPath({ directory: true });
    if (picked) {
      document.getElementById("ws-repo").value = picked;
      scheduleWorkspaceSave();
    }
  });
  document.getElementById("ws-editor-browse").addEventListener("click", async () => {
    const picked = await pickPath({
      defaultPath: "/Applications",
      filters: [{ name: "Applications", extensions: ["app"] }],
    });
    if (picked) {
      document.getElementById("ws-editor").value = appNameFromPath(picked);
      scheduleWorkspaceSave();
    }
  });

  // Autosave: any typing or selection change in the form persists (debounced).
  const form = document.getElementById("ws-form");
  form.addEventListener("input", scheduleWorkspaceSave);
  form.addEventListener("change", scheduleWorkspaceSave);
  form.addEventListener("submit", (e) => e.preventDefault());
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

// --- Notes -----------------------------------------------------------------

let notesData = { version: 1, notes: [] };
let notesProjectPath = null;
let notesSaveTimer = null;

function el(tag, className, props = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.assign(node, props);
  return node;
}

function genId() {
  return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function setNotesStatus(text) {
  document.getElementById("notes-status").textContent = text;
}

async function loadNotes(path) {
  notesProjectPath = path;
  const data = await invoke("read_notes", { path });
  notesData = data && Array.isArray(data.notes) ? data : { version: 1, notes: [] };
  setNotesStatus("");
  renderNotes();
}

function scheduleNotesSave() {
  if (!notesProjectPath) return;
  setNotesStatus("Saving…");
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(async () => {
    try {
      await invoke("save_notes", { path: notesProjectPath, notes: notesData });
      setNotesStatus("Saved ✓");
    } catch (err) {
      setNotesStatus(`Error: ${err}`);
    }
  }, 400);
}

function newNote(kind) {
  const note = { id: genId(), kind, title: "" };
  if (kind === "text") note.body = "";
  if (kind === "checklist") note.items = [];
  if (kind === "table") {
    note.columns = ["Column"];
    note.rows = [];
  }
  notesData.notes.push(note);
  renderNotes();
  scheduleNotesSave();
}

function noteHeader(note) {
  const head = el("div", "notecard__head");
  const title = el("input", "notecard__title", {
    value: note.title || "",
    placeholder: "Untitled",
  });
  title.addEventListener("input", () => {
    note.title = title.value;
    scheduleNotesSave();
  });

  // Per-note width: how many grid columns the card spans (1–3).
  const width = el("select", "notecard__width", { title: "Width" });
  [1, 2, 3].forEach((n) =>
    width.append(el("option", null, { value: String(n), textContent: `${n}×` }))
  );
  width.value = String(note.span || 1);
  width.addEventListener("change", () => {
    note.span = Number(width.value);
    const card = width.closest(".notecard");
    if (card) card.style.gridColumn = `span ${note.span}`;
    scheduleNotesSave();
  });

  const del = el("button", "btn-remove", { type: "button", textContent: "✕" });
  del.addEventListener("click", () => {
    notesData.notes = notesData.notes.filter((n) => n.id !== note.id);
    renderNotes();
    scheduleNotesSave();
  });
  head.append(title, width, del);
  return head;
}

function buildTextNote(note) {
  const card = el("div", "notecard");
  card.append(noteHeader(note));
  const view = el("div", "notecard__md");
  const textarea = el("textarea", "notecard__textarea", { value: note.body || "" });
  textarea.hidden = true;

  const renderView = () => {
    view.innerHTML = note.body
      ? marked.parse(note.body)
      : '<span class="notecard__empty">Empty — click to edit</span>';
  };
  renderView();

  view.addEventListener("click", () => {
    view.hidden = true;
    textarea.hidden = false;
    textarea.focus();
  });
  textarea.addEventListener("input", () => {
    note.body = textarea.value;
    scheduleNotesSave();
  });
  textarea.addEventListener("blur", () => {
    note.body = textarea.value;
    renderView();
    textarea.hidden = true;
    view.hidden = false;
    scheduleNotesSave();
  });

  card.append(view, textarea);
  return card;
}

function buildChecklist(note) {
  const card = el("div", "notecard");
  card.append(noteHeader(note));

  const count = el("div", "notecard__count");
  const updateCount = () => {
    const done = note.items.filter((i) => i.done).length;
    count.textContent = `${done} of ${note.items.length} done`;
  };

  const list = el("div", "checklist");
  note.items.forEach((item, idx) => {
    const row = el("div", "checklist__row");
    const cb = el("input", null, { type: "checkbox", checked: !!item.done });
    cb.addEventListener("change", () => {
      item.done = cb.checked;
      updateCount();
      scheduleNotesSave();
    });
    const txt = el("input", "field__input", {
      value: item.text || "",
      placeholder: "Item",
    });
    txt.addEventListener("input", () => {
      item.text = txt.value;
      scheduleNotesSave();
    });
    const rm = el("button", "btn-remove", { type: "button", textContent: "✕" });
    rm.addEventListener("click", () => {
      note.items.splice(idx, 1);
      renderNotes();
      scheduleNotesSave();
    });
    row.append(cb, txt, rm);
    list.append(row);
  });

  const add = el("button", "btn-add", { type: "button", textContent: "+ Add item" });
  add.addEventListener("click", () => {
    note.items.push({ text: "", done: false });
    renderNotes();
    scheduleNotesSave();
  });

  updateCount();
  card.append(count, list, add);
  return card;
}

function buildTable(note) {
  const card = el("div", "notecard");
  card.append(noteHeader(note));

  const table = el("table", "ntable");
  const thead = el("thead");
  const htr = el("tr");
  note.columns.forEach((col, ci) => {
    const th = el("th");
    const inp = el("input", "ntable__colinput", { value: col, placeholder: "Column" });
    inp.addEventListener("input", () => {
      note.columns[ci] = inp.value;
      scheduleNotesSave();
    });
    const rm = el("button", "ntable__x", {
      type: "button",
      textContent: "✕",
      title: "Remove column",
    });
    rm.addEventListener("click", () => {
      note.columns.splice(ci, 1);
      note.rows.forEach((r) => r.splice(ci, 1));
      renderNotes();
      scheduleNotesSave();
    });
    th.append(inp, rm);
    htr.append(th);
  });
  htr.append(el("th", "ntable__spacer"));
  thead.append(htr);
  table.append(thead);

  const tbody = el("tbody");
  note.rows.forEach((row, ri) => {
    const tr = el("tr");
    note.columns.forEach((_, ci) => {
      const td = el("td");
      const inp = el("input", "ntable__cell", { value: row[ci] || "" });
      inp.addEventListener("input", () => {
        row[ci] = inp.value;
        scheduleNotesSave();
      });
      td.append(inp);
      tr.append(td);
    });
    const tdx = el("td");
    const rm = el("button", "ntable__x", {
      type: "button",
      textContent: "✕",
      title: "Remove row",
    });
    rm.addEventListener("click", () => {
      note.rows.splice(ri, 1);
      renderNotes();
      scheduleNotesSave();
    });
    tdx.append(rm);
    tr.append(tdx);
    tbody.append(tr);
  });
  table.append(tbody);

  const actions = el("div", "ntable__actions");
  const addRow = el("button", "btn-add", { type: "button", textContent: "+ Row" });
  addRow.addEventListener("click", () => {
    note.rows.push(note.columns.map(() => ""));
    renderNotes();
    scheduleNotesSave();
  });
  const addCol = el("button", "btn-add", { type: "button", textContent: "+ Column" });
  addCol.addEventListener("click", () => {
    note.columns.push("Column");
    note.rows.forEach((r) => r.push(""));
    renderNotes();
    scheduleNotesSave();
  });
  actions.append(addRow, addCol);

  card.append(table, actions);
  return card;
}

function renderNotes() {
  const listEl = document.getElementById("notes-list");
  listEl.innerHTML = "";

  if (!notesData.notes.length) {
    listEl.append(
      el("p", "placeholder", {
        textContent: "No notes yet. Add a text note, checklist, or table above.",
      })
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
    card.style.gridColumn = `span ${note.span || 1}`;
    listEl.append(card);
  }
}

function initNotes() {
  document.querySelectorAll("[data-new-note]").forEach((btn) => {
    btn.addEventListener("click", () => newNote(btn.dataset.newNote));
  });
}

// --- Boot ------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  initLaunch();
  initWorkspaceForm();
  initNotes();
  initNewModal();

  render(await invoke("get_active_project"));
  selectTab("workspace");

  await listen("project-activated", (event) => render(event.payload));
  await listen("new-project-request", openNewModal);
  await listen("show-overview", showOverview);
});
