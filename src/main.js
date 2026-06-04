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

// Material Symbols icon markup.
function mi(name, sm = true) {
  return `<span class="mi${sm ? " mi-sm" : ""}">${name}</span>`;
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

const LAUNCH_LABEL = `${mi("rocket_launch")}Launch workspace`;

function initLaunch() {
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
    browse.innerHTML = `${mi(list === "apps" ? "apps" : "description")}Browse…`;
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
  remove.innerHTML = mi("close");
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

// --- Media -----------------------------------------------------------------

let mediaProjectPath = null;
let currentMedia = null;

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

async function loadMedia(path) {
  mediaProjectPath = path;
  const grid = document.getElementById("media-grid");
  grid.innerHTML = "";
  const items = await invoke("list_media", { path });

  if (!items.length) {
    grid.innerHTML = `<p class="placeholder">No images in this project yet.</p>`;
    return;
  }

  for (const item of items) {
    const tile = el("button", "mediatile", { type: "button", title: item.name });
    const img = el("img", "mediatile__img", { loading: "lazy", alt: item.name });
    if (item.is_heic) tile.append(el("span", "mediatile__badge", { textContent: "HEIC" }));
    tile.append(img);
    tile.addEventListener("click", () => openLightbox(item));
    grid.append(tile);
    mediaSrc(item).then((src) => {
      if (src) img.src = src;
    });
  }
}

// Opening a media item drops straight into the editor (canvas + controls).
async function openLightbox(item) {
  currentMedia = item;
  editItem = item;
  document.getElementById("lightbox-name").textContent = item.name;
  document.getElementById("lb-convert").hidden = !item.is_heic;

  const ext = (item.ext || "").toLowerCase();
  document.getElementById("lb-replace").hidden = !["png", "jpg", "jpeg"].includes(ext);

  document.getElementById("lightbox").hidden = false;
  setEditStatus("Loading…");

  const dataUrl = await invoke("read_image_data", { path: item.path });
  editImg = new Image();
  await new Promise((resolve, reject) => {
    editImg.onload = resolve;
    editImg.onerror = reject;
    editImg.src = dataUrl;
  });

  const saved = await invoke("read_edits", { path: item.path });
  editState = { ...defaultEdits(), ...saved };
  setEditStatus("");
  syncEditorControls();
  renderEditorPreview();
}

function closeLightbox() {
  document.getElementById("lightbox").hidden = true;
  currentMedia = null;
  editItem = null;
  editImg = null;
  editState = null;
}

// Native file drag-and-drop → copy images into the active project's media/.
async function initDragDrop() {
  const { listen } = window.__TAURI__.event;
  const zone = document.getElementById("dropzone");
  const show = () => {
    if (activeProject) zone.hidden = false;
  };
  await listen("tauri://drag-enter", show);
  await listen("tauri://drag-over", show);
  await listen("tauri://drag-leave", () => (zone.hidden = true));
  await listen("tauri://drag-drop", async (e) => {
    zone.hidden = true;
    if (!activeProject) return;
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
let editImg = null; // full-res HTMLImageElement
let editState = null; // current adjustments
let editSaveTimer = null;

function defaultEdits() {
  return {
    version: 1,
    rotate: 0,
    flipH: false,
    flipV: false,
    straighten: 0,
    crop: null, // { x, y, w, h } as fractions of the oriented image; null = full
    cropAspect: null, // width/height ratio for locked resizing; null = free
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Minimum uniform scale so rotating a w×h frame by `deg` leaves no empty corners.
function coverScale(w, h, deg) {
  const r = (Math.abs(deg) * Math.PI) / 180;
  if (!r) return 1;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return Math.max((w * cos + h * sin) / w, (w * sin + h * cos) / h);
}

// Render the oriented (rotate + flip + straighten) image to a full-res canvas.
function renderOriented(img, edits) {
  const rot = (((edits.rotate || 0) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const ow = swap ? img.naturalHeight : img.naturalWidth;
  const oh = swap ? img.naturalWidth : img.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = ow;
  canvas.height = oh;
  const ctx = canvas.getContext("2d");

  // Straighten: rotate around center, scaled to cover the frame.
  const sdeg = edits.straighten || 0;
  if (sdeg) {
    const s = coverScale(ow, oh, sdeg);
    ctx.translate(ow / 2, oh / 2);
    ctx.rotate((sdeg * Math.PI) / 180);
    ctx.scale(s, s);
    ctx.translate(-ow / 2, -oh / 2);
  }
  // Orientation: 90° rotation + flips, image drawn centered.
  ctx.translate(ow / 2, oh / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(edits.flipH ? -1 : 1, edits.flipV ? -1 : 1);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

  return canvas;
}

function renderEditorPreview() {
  if (!editImg) return;
  const oriented = renderOriented(editImg, editState);
  const canvas = document.getElementById("editor-canvas");
  const wrap = document.getElementById("editor-canvas-wrap");
  const scale = Math.min(
    wrap.clientWidth / oriented.width,
    wrap.clientHeight / oriented.height,
    1
  );
  canvas.width = Math.max(1, Math.round(oriented.width * scale));
  canvas.height = Math.max(1, Math.round(oriented.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(oriented, 0, 0, canvas.width, canvas.height);
  positionCrop();
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

function setEditStatus(text) {
  document.getElementById("edit-status").textContent = text;
}

function scheduleEditsSave() {
  if (!editItem) return;
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

function syncEditorControls() {
  document.getElementById("ed-straighten").value = editState.straighten || 0;
  document.getElementById("ed-straighten-val").textContent = `${editState.straighten || 0}°`;
  highlightAspect(editState.cropAspect ?? null);
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

async function exportEdited(replace) {
  if (!editImg) return;
  const oriented = renderOriented(editImg, editState); // full resolution
  const ext = (editItem.ext || "png").toLowerCase();
  const jpeg = ext === "jpg" || ext === "jpeg";
  const mime = jpeg ? "image/jpeg" : "image/png";
  const outExt = jpeg ? "jpg" : "png";

  // Apply crop (fractions of the oriented image).
  let out = oriented;
  const c = editState.crop;
  if (c && (c.x > 0 || c.y > 0 || c.w < 1 || c.h < 1)) {
    const sx = Math.round(c.x * oriented.width);
    const sy = Math.round(c.y * oriented.height);
    const sw = Math.max(1, Math.round(c.w * oriented.width));
    const sh = Math.max(1, Math.round(c.h * oriented.height));
    const cropped = document.createElement("canvas");
    cropped.width = sw;
    cropped.height = sh;
    cropped.getContext("2d").drawImage(oriented, sx, sy, sw, sh, 0, 0, sw, sh);
    out = cropped;
  }

  try {
    const blob = await new Promise((res) => out.toBlob(res, mime, 0.92));
    const b64 = await blobToBase64(blob);
    const dest = replace
      ? editItem.path
      : editItem.path.replace(/\.[^/.]+$/, "") + "-edited." + outExt;
    await invoke("write_image", { path: dest, dataBase64: b64 });
    setEditStatus(replace ? "Replaced ✓" : "Exported ✓");
    if (mediaProjectPath) loadMedia(mediaProjectPath);
  } catch (err) {
    setEditStatus(`Error: ${err}`);
  }
}

function initEditor() {
  document.getElementById("lb-export").addEventListener("click", () => exportEdited(false));
  document.getElementById("lb-replace").addEventListener("click", () => exportEdited(true));

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
    document.getElementById("ed-straighten-val").textContent = `${editState.straighten}°`;
    apply();
  });
  document.getElementById("ed-reset").addEventListener("click", () => {
    editState = defaultEdits();
    syncEditorControls();
    apply();
  });

  // Crop interactions.
  document.getElementById("crop").addEventListener("pointerdown", onCropPointerDown);
  document.querySelectorAll("[data-aspect]").forEach((b) =>
    b.addEventListener("click", () =>
      applyAspect(b.dataset.aspect === "free" ? null : Number(b.dataset.aspect))
    )
  );
  document.getElementById("ed-cropreset").addEventListener("click", resetCrop);
  window.addEventListener("resize", () => {
    if (editImg) renderEditorPreview();
  });
}

function initMedia() {
  initEditor();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("lightbox").hidden) {
      closeLightbox();
    }
  });
  document.getElementById("lb-close").addEventListener("click", closeLightbox);
  document.getElementById("lightbox").addEventListener("click", (e) => {
    if (suppressLightboxClick) {
      suppressLightboxClick = false;
      return;
    }
    if (e.target.id === "lightbox" || e.target.classList.contains("lightbox__stage")) {
      closeLightbox();
    }
  });
  document.getElementById("lb-copy").addEventListener("click", () => {
    if (currentMedia) navigator.clipboard.writeText(currentMedia.path);
  });
  document.getElementById("lb-reveal").addEventListener("click", () => {
    if (currentMedia) invoke("reveal_in_finder", { path: currentMedia.path });
  });
  document.getElementById("lb-convert").addEventListener("click", async () => {
    if (!currentMedia) return;
    try {
      await invoke("convert_heic", { path: currentMedia.path, format: "jpg" });
      closeLightbox();
      if (mediaProjectPath) loadMedia(mediaProjectPath);
    } catch (err) {
      console.error("Convert failed:", err);
    }
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

  const del = el("button", "btn-remove", { type: "button", innerHTML: mi("close") });
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
  const width = el("button", "notecard__width", { type: "button", title: "Width" });
  const renderDots = () => {
    width.innerHTML = '<span class="dot"></span>'.repeat(note.span || 1);
  };
  renderDots();
  width.addEventListener("click", () => {
    note.span = ((note.span || 1) % 3) + 1;
    renderDots();
    const card = width.closest(".notecard");
    if (card) card.style.gridColumn = `span ${note.span}`;
    scheduleNotesSave();
  });
  footer.append(width);
  return footer;
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
    const txt = el("input", "field__input", {
      value: item.text || "",
      placeholder: "Item",
    });
    txt.addEventListener("input", () => {
      item.text = txt.value;
      scheduleNotesSave();
    });
    txt.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addChecklistItem(note);
      }
    });
    const rm = el("button", "btn-remove", { type: "button", innerHTML: mi("close") });
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
  note.columns.forEach((col, ci) => {
    const th = el("th");
    const inp = el("input", "ntable__colinput", { value: col, placeholder: "Column" });
    inp.addEventListener("input", () => {
      note.columns[ci] = inp.value;
      scheduleNotesSave();
    });
    const rm = el("button", "ntable__x", {
      type: "button",
      innerHTML: mi("close"),
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
      innerHTML: mi("close"),
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
  const addRow = el("button", "btn-add", { type: "button", innerHTML: `${mi("add")}Row` });
  addRow.addEventListener("click", () => {
    note.rows.push(note.columns.map(() => ""));
    renderNotes();
    scheduleNotesSave();
  });
  const addCol = el("button", "btn-add", { type: "button", innerHTML: `${mi("add")}Column` });
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
    card.append(noteFooter(note));
    card.dataset.noteId = note.id;
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
  initMedia();
  initDragDrop();
  initNewModal();

  render(await invoke("get_active_project"));
  selectTab("workspace");

  await listen("project-activated", (event) => render(event.payload));
  await listen("new-project-request", openNewModal);
  await listen("show-overview", showOverview);
});
