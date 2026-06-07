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
const mediaSelection = new Set();
const mediaItemsByPath = new Map(); // path → MediaItem, refreshed by loadMedia

function updateSelbar() {
  const n = mediaSelection.size;
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
  mediaSelection.clear();
  mediaSelection.add(item.path);

  if (item.kind !== "image") {
    updateSelectionUI();
    await closeInlineEditor();
    return;
  }

  // Claim editor ownership synchronously so the batch bar never flashes between
  // the selection update and the (async) editor load.
  const alreadyShown = activeItem && activeItem.path === item.path;
  activeItem = item;
  updateSelectionUI(); // selbar now sees the editor owns the lone selection
  if (alreadyShown) return;

  if (editItem && editItem.path !== item.path) await flushEditSave();
  document.getElementById("side-name").textContent = item.name;
  document.getElementById("media-side").hidden = false;
  moveEditor(document.getElementById("media-side-editor"));
  await loadEditor(item);
}

// ⌘/Ctrl click: add/remove from the selection. The editor is sticky here — a
// second selection never opens, closes, or switches it.
async function toggleSelect(item) {
  if (mediaSelection.has(item.path)) mediaSelection.delete(item.path);
  else mediaSelection.add(item.path);
  updateSelectionUI();
}

function clearSelection() {
  mediaSelection.clear();
  updateSelectionUI();
  closeInlineEditor();
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
  tile.append(el("span", "mediatile__name", { textContent: item.name }));
  if (mediaSelection.has(item.path)) tile.classList.add("is-selected");

  tile.addEventListener("click", (e) => {
    // ⌘/Ctrl-click toggles the item in the selection; plain click selects only
    // it (and opens the editor when it's a single image).
    if (e.metaKey || e.ctrlKey) toggleSelect(item);
    else selectOnly(item);
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
  for (const p of [...mediaSelection])
    if (!present.has(p)) mediaSelection.delete(p);
  updateSelbar();

  // Drop the inline edit focus if its file is gone.
  if (activeItem && !present.has(activeItem.path)) {
    activeItem = null;
    document.getElementById("media-side").hidden = true;
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
  if (!document.getElementById("lightbox").hidden) return editPreview || editThumb;
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
  const thumb = await loadImage(await invoke("read_image_data", { path: thumbPath }));
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

// Longest side (px) for the inline thumbnail and the lightbox preview.
const THUMB_MAX = 768;
const PREVIEW_MAX = 2048;

// Width/height of an image source (HTMLImageElement or canvas).
function srcW(s) {
  return s.naturalWidth || s.width;
}
function srcH(s) {
  return s.naturalHeight || s.height;
}

// A downscaled copy of `img` (longest side ≤ max) for fast preview rendering.
// Returns the image itself when it's already small enough. Derived from the
// clean data-URL image, so it stays WebGL/export-safe.
function makePreview(img, max = PREVIEW_MAX) {
  const w = srcW(img);
  const h = srcH(img);
  const scale = Math.min(1, max / Math.max(w, h));
  if (scale === 1) return img;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c;
}

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

// Render the oriented (rotate + flip + straighten) image (HTMLImageElement or
// canvas) at its source resolution.
function renderOriented(img, edits) {
  const iw = srcW(img);
  const ih = srcH(img);
  const rot = (((edits.rotate || 0) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const ow = swap ? ih : iw;
  const oh = swap ? iw : ih;

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
  ctx.drawImage(img, -iw / 2, -ih / 2);

  return canvas;
}

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

const exTargetW = () => exBase.width + exMargins.l + exMargins.r;
const exTargetH = () => exBase.height + exMargins.t + exMargins.b;

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

  exMargins = { l: 0, r: 0, t: 0, b: 0 };
  exRatio = null;
  exRatioBase = null;
  exOrient = "landscape";
  exFinal = null;
  setExtendReady(false);
  document.getElementById("extend-status").textContent = "";
  document
    .querySelectorAll("#extend-ratios .chip")
    .forEach((c) => c.classList.toggle("is-active", c.dataset.ratio === "free"));
  document
    .querySelectorAll("#extend-orient .orient-btn")
    .forEach((b) =>
      b.classList.toggle("is-active", b.dataset.orient === "landscape"),
    );
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
      if (a < 1) d[(y * c.width + x) * 4 + 3] = Math.round(Math.max(0, a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Shared fill flow. `engine(workPngB64, tw, th)` returns the filled PNG (base64)
// for the enlarged canvas; the original is feathered back on top to hide seams.
async function runExtendFill(engine, cap) {
  if (!exBase) return;
  if (exMargins.l + exMargins.r + exMargins.t + exMargins.b === 0) {
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
    const feather = Math.min(
      64,
      Math.max(6, Math.round(Math.min(exBase.width, exBase.height) * 0.04)),
    );
    fctx.drawImage(
      featheredOriginal(exBase, exMargins, feather),
      exMargins.l,
      exMargins.t,
    );
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
    if (y1 < wH - 1)
      o.drawImage(out, 0, y1, wW, 1, 0, y1 + 1, wW, wH - 1 - y1);

    // Soften the streaky stretch with a blur.
    const blurred = document.createElement("canvas");
    blurred.width = wW;
    blurred.height = wH;
    const b = blurred.getContext("2d");
    b.filter = `blur(${Math.max(3, Math.round(Math.min(wW, wH) * 0.03))}px)`;
    b.drawImage(out, 0, 0);
    return blurred.toDataURL("image/png").split(",")[1];
  }, 1024);
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

function initExtend() {
  document.getElementById("ed-extendbg").addEventListener("click", openExtend);
  document.getElementById("ed-photos").addEventListener("click", editInPhotos);
  document.getElementById("extend-fill").addEventListener("click", extendFill);
  document
    .getElementById("extend-fill-simple")
    .addEventListener("click", extendFillSimple);
  document
    .getElementById("extend-fill-sd")
    .addEventListener("click", extendFillSD);
  document.getElementById("extend-save").addEventListener("click", extendSave);
  document
    .getElementById("extend-edit-photos")
    .addEventListener("click", extendEditInPhotos);
  document
    .getElementById("extend-cancel")
    .addEventListener("click", () => (document.getElementById("extend").hidden = true));
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

function initMedia() {
  initEditor();
  initWebExport();
  initRemoveBg();
  initExtend();
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

  // Click anywhere off a thumbnail (empty grid space, panel padding) to clear
  // the selection. The batch bar and the editor side column keep their clicks.
  document
    .querySelector('[data-panel="media"]')
    .addEventListener("click", (e) => {
      if (
        e.target.closest(".mediatile") ||
        e.target.closest(".selbar") ||
        e.target.closest(".media-side")
      )
        return;
      clearSelection();
    });

  // Clicking the project header (name/path, empty space) also counts as off.
  document.getElementById("project-header").addEventListener("click", () => {
    if (!document.querySelector('[data-panel="media"]').hidden) clearSelection();
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // The Extend-background modal takes Escape first.
    if (!document.getElementById("extend").hidden) {
      if (e.key === "Escape") document.getElementById("extend").hidden = true;
      return;
    }
    const lightboxOpen = !document.getElementById("lightbox").hidden;
    const inlineActive =
      activeItem &&
      !document.querySelector('[data-panel="media"]').hidden &&
      document.activeElement?.tagName !== "INPUT" &&
      document.activeElement?.tagName !== "TEXTAREA";
    if (lightboxOpen || inlineActive) {
      // The editor is active (full lightbox or inline side column).
      if (e.key === "Escape") {
        if (lightboxOpen) closeLightbox();
        else clearSelection();
      } else if (mod && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        copyAdjustments();
      } else if (mod && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        pasteAdjustments();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        // Delete the focused image (or the checkbox selection, if any).
        e.preventDefault();
        trashMedia(mediaSelection.size ? [...mediaSelection] : [editItem.path]);
      }
      return;
    }
    // Grid context: leave text fields and other panels' handlers alone.
    const ae = document.activeElement;
    const inField =
      ae &&
      (ae.tagName === "INPUT" ||
        ae.tagName === "TEXTAREA" ||
        ae.tagName === "SELECT" ||
        ae.isContentEditable);
    const onMedia = !document.querySelector('[data-panel="media"]').hidden;

    // Cmd+V pastes onto selected tiles, or a clipboard image into the project.
    if (mod && (e.key === "v" || e.key === "V")) {
      if (inField) return;
      e.preventDefault();
      if (mediaSelection.size) batchPaste();
      else pasteFromClipboard();
    }
    // Delete/Backspace trashes the checkbox-selected media.
    else if (
      onMedia &&
      !inField &&
      mediaSelection.size &&
      (e.key === "Delete" || e.key === "Backspace")
    ) {
      e.preventDefault();
      trashMedia([...mediaSelection]);
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
let selectedNoteId = null;

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  const isEditable = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;

  // Arrow keys move a selected note within the grid
  if (selectedNoteId && !isEditable && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const idx = notesData.notes.findIndex((n) => n.id === selectedNoteId);
    if (idx === -1) return;
    let delta;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      delta = e.key === "ArrowLeft" ? -1 : 1;
    } else {
      // Simulate grid auto-placement to find each note's row, respecting spans.
      const listEl = document.getElementById("notes-list");
      const colCount = getComputedStyle(listEl).gridTemplateColumns.split(" ").length;
      const noteRows = [];
      let col = 0, row = 0;
      for (const n of notesData.notes) {
        const span = Math.min(n.span || 1, colCount);
        if (col + span > colCount) { row++; col = 0; }
        noteRows.push(row);
        col += span;
      }
      const myRow = noteRows[idx];
      if (e.key === "ArrowUp") {
        if (myRow === 0) return;
        const prevRowCount = noteRows.filter((r) => r === myRow - 1).length;
        delta = -prevRowCount;
      } else {
        const maxRow = noteRows[noteRows.length - 1];
        if (myRow === maxRow) return;
        const nextRowCount = noteRows.filter((r) => r === myRow + 1).length;
        delta = nextRowCount;
      }
    }
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= notesData.notes.length) return;
    const [note] = notesData.notes.splice(idx, 1);
    notesData.notes.splice(newIdx, 0, note);
    renderNotes();
    scheduleNotesSave();
    return;
  }

  if (e.key !== "Delete" && e.key !== "Backspace") return;
  if (isEditable) return;
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
  const note = { id: genId(), kind, title: "", createdAt: new Date().toISOString() };
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
    const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
      });
    }
    scheduleNotesSave();
  });
  footer.append(width);
  return footer;
}

function buildTextNote(note) {
  const card = el("div", "notecard");
  card.append(noteHeader(note));

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
    scheduleNotesSave();
  });
  requestAnimationFrame(resizeTextarea);

  card.append(textarea);
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
    if (note.id === selectedNoteId) card.classList.add("is-selected");
    card.addEventListener("click", (e) => {
      const rect = card.getBoundingClientRect();
      if (e.clientY - rect.top <= 8) {
        selectedNoteId = selectedNoteId === note.id ? null : note.id;
        listEl.querySelectorAll(".notecard").forEach((c) => {
          c.classList.toggle("is-selected", c.dataset.noteId === selectedNoteId);
        });
      }
    });
    listEl.append(card);
  }
}

function initNotes() {
  document.querySelectorAll("[data-new-note]").forEach((btn) => {
    btn.addEventListener("click", () => newNote(btn.dataset.newNote));
  });

  document.addEventListener("click", (e) => {
    if (selectedNoteId && !e.target.closest(".notecard")) {
      selectedNoteId = null;
      document.querySelectorAll(".notecard.is-selected").forEach((c) => c.classList.remove("is-selected"));
    }
  });

  // Paste on the notes panel is handled via the keydown Cmd+V path calling pasteIntoNotes()
  // so that navigator.clipboard.readText() can be used (e.clipboardData is empty in Tauri
  // on non-editable elements). The paste event still handles pastes inside inputs/textareas.
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
