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
      card.addEventListener("click", () =>
        invoke("open_project", { path: p.path }),
      );
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

function addRow(list, value = "") {
  const rows = listContainer();
  const meta = LIST_META[list];

  const card = document.createElement("div");
  card.className = "ws-item";
  card.dataset.list = list;

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
    ...listContainer().querySelectorAll(`.ws-item[data-list="${list}"] input`),
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
}

function setStatus(text) {
  document.getElementById("ws-status").textContent = text;
}

let wsSaveTimer = null;
let wsEditor = "";

function readWorkspaceForm() {
  return {
    repo: readList("repo")[0] || "",
    editor: wsEditor,
    figma: readList("figma")[0] || "",
    claude: { mode: wsClaude },
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
    .querySelectorAll("[data-add-list]")
    .forEach((btn) =>
      btn.addEventListener("click", () => addRow(btn.dataset.addList)),
    );
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
const mediaSelection = new Set();

function updateSelbar() {
  const n = mediaSelection.size;
  document.getElementById("selbar").hidden = n === 0;
  document.getElementById("sel-count").textContent = `${n} selected`;
  document.getElementById("sel-paste").disabled = !copiedEdits || n === 0;
}

function toggleSelect(path, tile) {
  if (mediaSelection.has(path)) {
    mediaSelection.delete(path);
    tile.classList.remove("is-selected");
  } else {
    mediaSelection.add(path);
    tile.classList.add("is-selected");
  }
  updateSelbar();
}

function clearSelection() {
  mediaSelection.clear();
  document
    .querySelectorAll(".mediatile.is-selected")
    .forEach((t) => t.classList.remove("is-selected"));
  updateSelbar();
}

// Write the copied adjustments onto every selected image's sidecar.
async function batchPaste() {
  if (!copiedEdits || !mediaSelection.size) return;
  const fields = {};
  for (const f of ADJ_FIELDS) if (f in copiedEdits) fields[f] = copiedEdits[f];

  const paths = [...mediaSelection];
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

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Render an edited image's thumbnail (geometry + crop + tonal baked) as a data URL.
async function renderThumb(item) {
  const [dataUrl, saved] = await Promise.all([
    invoke("read_image_data", { path: item.path }),
    invoke("read_edits", { path: item.path }),
  ]);
  const img = await loadImage(dataUrl);
  const edits = { ...defaultEdits(), ...saved };

  const oriented = renderOriented(img, edits);
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

// Build a media tile (queues its thumbnail load). `edited` collects edited
// images to bake after the grid is laid out.
function buildMediaTile(item, edited) {
  const isImage = item.kind === "image";
  const tile = el("button", "mediatile", { type: "button", title: item.name });
  tile.dataset.path = item.path;
  tile.dataset.sig = `${item.modified}|${item.edits_mtime}`;
  const img = el("img", "mediatile__img", { loading: "lazy", alt: item.name });
  if (item.is_heic) {
    tile.append(el("span", "mediatile__badge", { textContent: "HEIC" }));
  } else if (isImage && isWebExport(item.name)) {
    tile.append(
      el("span", "mediatile__badge mediatile__badge--web", {
        textContent: "WEB",
      }),
    );
  }
  if (!isImage)
    tile.append(
      el("span", "mediatile__kind", {
        innerHTML: mi(KIND_ICONS[item.kind] || "insert_drive_file"),
      }),
    );
  tile.append(img);

  if (isImage) {
    const check = el("span", "mediatile__check", { title: "Select" });
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSelect(item.path, tile);
    });
    tile.append(check);
  }
  if (mediaSelection.has(item.path)) tile.classList.add("is-selected");

  tile.addEventListener("click", () => {
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

  // Prune selection to files that still exist.
  const present = new Set(items.map((i) => i.path));
  for (const p of [...mediaSelection])
    if (!present.has(p)) mediaSelection.delete(p);
  updateSelbar();

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

// Opening a media item drops straight into the editor (canvas + controls).
async function openLightbox(item) {
  currentMedia = item;
  editItem = item;
  document.getElementById("lightbox-name").textContent = item.name;

  const ext = (item.ext || "").toLowerCase();
  document.getElementById("lb-replace").hidden = ![
    "png",
    "jpg",
    "jpeg",
  ].includes(ext);

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
  orientedCache = null; // new image — invalidate geometry cache
  orientedSig = "";
  setEditStatus("");
  syncEditorControls();
  renderEditorPreview();
}

async function closeLightbox() {
  // Flush any pending edit save so the grid thumbnail reflects it.
  if (editItem && editState) {
    clearTimeout(editSaveTimer);
    try {
      await invoke("save_edits", { path: editItem.path, edits: editState });
    } catch (err) {
      console.error("Edit save on close failed:", err);
    }
    invalidateThumb(editItem.path); // this image's thumbnail may have changed
  }
  document.getElementById("lightbox").hidden = true;
  currentMedia = null;
  editItem = null;
  editImg = null;
  editState = null;
  if (mediaProjectPath) loadMedia(mediaProjectPath);
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
    // Tonal adjustments, each -100..100 (0 = no change).
    exposure: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    highlights: 0,
    shadows: 0,
  };
}

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

// Cache the oriented (geometry-only) canvas; recompute just when geometry changes.
let orientedCache = null;
let orientedSig = "";
// Reused offscreen canvas for full-res export (avoids leaking WebGL contexts).
const exportGLCanvas = document.createElement("canvas");

function getOriented() {
  const sig = [
    editState.rotate,
    editState.flipH,
    editState.flipV,
    editState.straighten,
  ].join("|");
  if (!orientedCache || sig !== orientedSig) {
    orientedCache = renderOriented(editImg, editState);
    orientedSig = sig;
  }
  return orientedCache;
}

// --- WebGL tonal-adjustment pipeline ---------------------------------------

const TONAL_FRAG = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform float u_exposure, u_contrast, u_saturation, u_temp, u_tint,
                u_highlights, u_shadows;
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  void main() {
    vec4 t = texture2D(u_tex, v_uv);
    vec3 c = t.rgb;
    c *= u_exposure;                       // exposure (factor)
    c.r += u_temp * 0.1; c.b -= u_temp * 0.1; // temperature
    c.g += u_tint * 0.1;                   // tint
    c = (c - 0.5) * u_contrast + 0.5;      // contrast
    float l1 = dot(clamp(c, 0.0, 1.0), LUMA);
    c += u_shadows * (1.0 - smoothstep(0.0, 0.5, l1));    // lift/lower shadows
    c += u_highlights * smoothstep(0.5, 1.0, l1);         // recover/boost highlights
    float l2 = dot(clamp(c, 0.0, 1.0), LUMA);
    c = mix(vec3(l2), c, u_saturation);    // saturation
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), t.a);
  }`;

const TONAL_VERT = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = (a_pos + 1.0) * 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh));
  }
  return sh;
}

function getGL(canvas) {
  if (canvas._glctx) return canvas._glctx;
  const gl = canvas.getContext("webgl", {
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  });
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, TONAL_VERT));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, TONAL_FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  const u = (n) => gl.getUniformLocation(prog, n);
  canvas._glctx = {
    gl,
    tex,
    lastSource: null,
    u: {
      exposure: u("u_exposure"),
      contrast: u("u_contrast"),
      saturation: u("u_saturation"),
      temp: u("u_temp"),
      tint: u("u_tint"),
      highlights: u("u_highlights"),
      shadows: u("u_shadows"),
    },
  };
  return canvas._glctx;
}

// Draw `source` (a canvas) into `canvas` with the tonal adjustments applied.
function glAdjust(canvas, source, ed) {
  const ctx = getGL(canvas);
  const { gl, u, tex } = ctx;
  gl.viewport(0, 0, canvas.width, canvas.height);
  if (ctx.lastSource !== source) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    ctx.lastSource = source;
  }
  gl.uniform1f(u.exposure, Math.pow(2, (ed.exposure || 0) / 100));
  gl.uniform1f(u.contrast, 1 + (ed.contrast || 0) / 100);
  gl.uniform1f(u.saturation, 1 + (ed.saturation || 0) / 100);
  gl.uniform1f(u.temp, (ed.temperature || 0) / 100);
  gl.uniform1f(u.tint, (ed.tint || 0) / 100);
  gl.uniform1f(u.highlights, ((ed.highlights || 0) / 100) * 0.5);
  gl.uniform1f(u.shadows, ((ed.shadows || 0) / 100) * 0.5);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function renderEditorPreview() {
  if (!editImg) return;
  const oriented = getOriented();
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
  document.getElementById("ed-paste").disabled = false;
  setEditStatus("Copied ✓");
}

function pasteAdjustments() {
  if (!copiedEdits || !editState) return;
  for (const f of ADJ_FIELDS) {
    if (f in copiedEdits) editState[f] = copiedEdits[f];
  }
  orientedCache = null; // geometry may have changed
  orientedSig = "";
  syncEditorControls();
  renderEditorPreview();
  scheduleEditsSave();
  setEditStatus("Pasted ✓");
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
  if (!editImg) return;
  const oriented = getOriented(); // geometry, full resolution
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
      orientedCache = null;
      orientedSig = "";
      await invoke("save_edits", { path: editItem.path, edits: editState });
      syncEditorControls();
      try {
        editImg = await loadImage(
          await invoke("read_image_data", { path: editItem.path }),
        );
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

function initWebExport() {
  document.getElementById("lb-webexport").addEventListener("click", () => {
    if (!editItem) return;
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
  });
  document.getElementById("sel-webexport").addEventListener("click", () => {
    if (!mediaSelection.size) return;
    openWebExport({
      mode: "batch",
      items: [...mediaSelection].map((p) => ({
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
  if (!editImg) return;
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

  // Copy / paste adjustments.
  loadCopiedEdits();
  document.getElementById("ed-paste").disabled = !copiedEdits;
  document.getElementById("ed-copy").addEventListener("click", copyAdjustments);
  document
    .getElementById("ed-paste")
    .addEventListener("click", pasteAdjustments);
  window.addEventListener("resize", () => {
    if (editImg) renderEditorPreview();
  });
}

function initMedia() {
  initEditor();
  initWebExport();
  initRemoveBg();
  document.getElementById("sel-paste").addEventListener("click", batchPaste);
  document
    .getElementById("sel-clear")
    .addEventListener("click", clearSelection);

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!document.getElementById("lightbox").hidden) {
      // Editor is open.
      if (e.key === "Escape") {
        closeLightbox();
      } else if (mod && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        copyAdjustments();
      } else if (mod && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        pasteAdjustments();
      }
      return;
    }
    // Grid context: Cmd+V pastes onto selected tiles, or a clipboard image
    // into the project. Leave text fields alone so normal paste still works.
    if (mod && (e.key === "v" || e.key === "V")) {
      const ae = document.activeElement;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.tagName === "SELECT" ||
          ae.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (mediaSelection.size) batchPaste();
      else if (activeProject) pasteImageFromClipboard();
    }
  });
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

document.addEventListener("keydown", (e) => {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  if (document.activeElement && document.activeElement.tagName === "INPUT")
    return;
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
  } else if (selectedRow) {
    const { note, ri } = selectedRow;
    note.rows.splice(ri, 1);
    selectedRow = null;
    renderNotes();
    scheduleNotesSave();
  }
});

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
  notesData =
    data && Array.isArray(data.notes) ? data : { version: 1, notes: [] };
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
  const textarea = el("textarea", "notecard__textarea", {
    value: note.body || "",
  });
  textarea.hidden = true;

  const resizeTextarea = () => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  };

  const renderView = () => {
    if (note.body) {
      view.textContent = note.body;
    } else {
      view.innerHTML =
        '<span class="notecard__empty">Empty — click to edit</span>';
    }
  };
  renderView();

  view.addEventListener("click", () => {
    view.hidden = true;
    textarea.hidden = false;
    requestAnimationFrame(resizeTextarea);
    textarea.focus();
  });
  textarea.addEventListener("input", () => {
    note.body = textarea.value;
    resizeTextarea();
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
