// Media subsystem: grid, tiles, selection, sort/reorder, the image editor
// (tonal/crop/geometry), lightbox, export, and the tools (remove-bg, extend,
// generate). Extracted from main.js. See interaction-spec / BACKLOG file-split.

import { el, mi, genId, clamp } from "./dom.js";
import { loadImage, makePreview, renderOriented, defaultEdits } from "./imageutil.js";
import { createSelection } from "./selection.js";
import { panelKeymaps } from "./keymap.js";
import { glAdjust } from "./gl.js";
import { state } from "./state.js";
import {
  selectTab,
  render,
  scheduleNotesSave,
  renderNotes,
  pasteFromClipboard,
  installOffClickDeselect,
  scheduleBentoLayout,
} from "./main.js";
import { scheduleWorkspaceSave, addRow } from "./workspace.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// --- Media -----------------------------------------------------------------

let mediaProjectPath = null;
let currentMedia = null;
// The single source of truth for selection. A selection of exactly one image
// opens the editor; 0 or 2+ (or a single non-image) shows the batch bar instead.
// Media tile selection (interaction-spec §3). Multi-select; onChange repaints
// tile rings + the batch bar.
const mediaSelection = createSelection({
  mode: "multi",
  onChange: () => updateSelectionUI(),
});
const mediaItemsByPath = new Map(); // path → MediaItem, refreshed by loadMedia

// Media sort (interaction-spec §8.2): added | edited | name | user, persisted
// per project in .studio-media.json.
let mediaSortMode = "added";
let mediaManualOrder = []; // paths, for "user" sort

function sortMediaItems(items) {
  const arr = [...items];
  if (mediaSortMode === "name")
    return arr.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  if (mediaSortMode === "edited")
    return arr.sort((a, b) => (b.edits_mtime || 0) - (a.edits_mtime || 0));
  if (mediaSortMode === "user") {
    const idx = new Map(mediaManualOrder.map((p, i) => [p, i]));
    const rank = (p) => (idx.has(p) ? idx.get(p) : Number.MAX_SAFE_INTEGER);
    return arr.sort(
      (a, b) => rank(a.path) - rank(b.path) || (b.modified || 0) - (a.modified || 0),
    );
  }
  return arr.sort((a, b) => (b.modified || 0) - (a.modified || 0)); // added
}

function updateMediaSortUI() {
  document.querySelectorAll("#media-sort .pill-tab").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.sort === mediaSortMode);
    if (b.dataset.sort === "user") b.hidden = mediaManualOrder.length === 0;
  });
}

async function loadMediaMeta(path) {
  mediaSortMode = "added";
  mediaManualOrder = [];
  try {
    const raw = await invoke("read_media_meta", { path });
    if (raw) {
      const m = JSON.parse(raw);
      if (m.sort) mediaSortMode = m.sort;
      if (Array.isArray(m.order)) mediaManualOrder = m.order;
    }
  } catch (_) {}
  updateMediaSortUI();
}

function saveMediaMeta() {
  if (!mediaProjectPath) return;
  invoke("save_media_meta", {
    path: mediaProjectPath,
    data: JSON.stringify({ sort: mediaSortMode, order: mediaManualOrder }),
  });
}

// --- Media tile drag-reorder (pointer-based; sets sort to "user") ----------

let mediaDrag = null; // { item, tile, startX, startY, active }
state.mediaDragActive = false; // suppresses the OS file-drop overlay
let lastMediaDragEnd = 0;
let mediaDropIndex = null;
let mediaDropToNotes = false; // dragging an image tile onto the Notes tab

// Create an image note referencing a media file in place (no copy); §9.1/§8.2.
function createImageNoteFromMedia(item) {
  if (!state.notesProjectPath || item.kind !== "image") return;
  const prefix = state.notesProjectPath + "/";
  const src = item.path.startsWith(prefix)
    ? item.path.slice(prefix.length)
    : item.path;
  state.notesData.notes.unshift({
    id: genId(),
    kind: "image",
    title: "",
    src,
    w: item.width || 0,
    h: item.height || 0,
    caption: "",
    createdAt: new Date().toISOString(),
  });
  renderNotes();
  scheduleNotesSave();
  selectTab("notes");
}

function onMediaTilePointerDown(e, item, tile) {
  if (e.button !== 0) return;
  // The tile itself is a <button>, so only exclude the rename field / links —
  // NOT "button" (that would match the tile and never start a drag).
  if (e.target.closest("textarea, input, a")) return;
  // Capture the pointer so WebKit doesn't hijack the drag over the image.
  try {
    tile.setPointerCapture(e.pointerId);
  } catch (_) {}
  mediaDrag = {
    item,
    tile,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
  };
  window.addEventListener("pointermove", onMediaPointerMove);
  window.addEventListener("pointerup", onMediaPointerUp);
  window.addEventListener("pointercancel", onMediaPointerUp);
}

function onMediaPointerMove(e) {
  if (!mediaDrag) return;
  if (!mediaDrag.active) {
    if (Math.hypot(e.clientX - mediaDrag.startX, e.clientY - mediaDrag.startY) < 5)
      return;
    mediaDrag.active = true;
    state.mediaDragActive = true;
    mediaDrag.tile.classList.add("is-dragging");
    document.body.classList.add("note-dragging"); // shared no-select/grab cursor
  }
  e.preventDefault();

  // Over the Notes tab? An image tile dropped there becomes an image note.
  const notesTab = document.querySelector('.tab[data-tab="notes"]');
  const overNotes =
    mediaDrag.item.kind === "image" &&
    !!notesTab &&
    document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest('.tab[data-tab="notes"]') === notesTab;
  mediaDropToNotes = overNotes;
  notesTab?.classList.toggle("is-drop-target", overNotes);
  if (overNotes) {
    hideMediaDropIndicator();
    return;
  }

  const grid = document.getElementById("media-grid");
  const target = computeMediaDrop(grid, e.clientX, e.clientY);
  mediaDropIndex = target ? target.index : null;
  showMediaDropIndicator(grid, target);
}

function onMediaPointerUp() {
  window.removeEventListener("pointermove", onMediaPointerMove);
  window.removeEventListener("pointerup", onMediaPointerUp);
  window.removeEventListener("pointercancel", onMediaPointerUp);
  const drag = mediaDrag;
  mediaDrag = null;
  if (drag) {
    try {
      drag.tile.releasePointerCapture(drag.pointerId);
    } catch (_) {}
  }
  state.mediaDragActive = false;
  document.body.classList.remove("note-dragging");
  hideMediaDropIndicator();
  document
    .querySelector('.tab[data-tab="notes"]')
    ?.classList.remove("is-drop-target");
  if (!drag || !drag.active) {
    mediaDropToNotes = false;
    return;
  }
  lastMediaDragEnd = Date.now();
  drag.tile.classList.remove("is-dragging");

  // Dropped on the Notes tab → image note (no reorder).
  if (mediaDropToNotes) {
    mediaDropToNotes = false;
    createImageNoteFromMedia(drag.item);
    return;
  }

  const to = mediaDropIndex;
  mediaDropIndex = null;
  if (to == null) return;

  const grid = document.getElementById("media-grid");
  const order = [...grid.querySelectorAll(".mediatile")].map((t) => t.dataset.path);
  const from = order.indexOf(drag.item.path);
  if (from === -1) return;
  order.splice(from, 1);
  let dest = from < to ? to - 1 : to;
  dest = Math.max(0, Math.min(dest, order.length));
  order.splice(dest, 0, drag.item.path);

  mediaManualOrder = order;
  mediaSortMode = "user";
  updateMediaSortUI();
  saveMediaMeta();
  if (mediaProjectPath) loadMedia(mediaProjectPath);
}

function computeMediaDrop(grid, x, y) {
  const tiles = [...grid.querySelectorAll(".mediatile")];
  if (!tiles.length) return { index: 0, tile: null, after: false };
  let rowHit;
  for (let i = 0; i < tiles.length; i++) {
    const r = tiles[i].getBoundingClientRect();
    if (y < r.top || y > r.bottom) continue; // not in this row band
    if (x < r.left + r.width / 2)
      return { index: i, tile: tiles[i], after: false };
    rowHit = { index: i + 1, tile: tiles[i], after: true };
  }
  if (rowHit) return rowHit;
  // Pointer in a gap/below: snap to the nearest tile by center.
  let best = null;
  let bestDist = Infinity;
  tiles.forEach((t, i) => {
    const r = t.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      const after = x >= r.left + r.width / 2;
      best = { index: after ? i + 1 : i, tile: t, after };
    }
  });
  return best;
}

function ensureMediaIndicator(grid) {
  let bar = grid.querySelector(".media-drop-indicator");
  if (!bar) {
    bar = el("div", "media-drop-indicator");
    grid.append(bar);
  }
  return bar;
}

function showMediaDropIndicator(grid, target) {
  const bar = ensureMediaIndicator(grid);
  if (!target || !target.tile) {
    bar.style.display = "none";
    return;
  }
  const gr = grid.getBoundingClientRect();
  const r = target.tile.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 12;
  const edgeX = target.after ? r.right + gap / 2 : r.left - gap / 2;
  bar.style.display = "block";
  bar.style.left = edgeX - gr.left - 1.5 + "px";
  bar.style.top = r.top - gr.top + "px";
  bar.style.height = r.height + "px";
}

function hideMediaDropIndicator() {
  // Remove (not just hide) so it never lingers as a grid child and confuses
  // loadMedia's tile-diff ordering.
  document.querySelector(".media-drop-indicator")?.remove();
}

function updateSelbar() {
  const n = mediaSelection.size();
  // Hide the batch bar only when the sole selected item is the one the editor
  // is already showing; otherwise show it (incl. multi-select with editor open).
  const editorOwnsSelection =
    n === 1 && state.activeItem && mediaSelection.has(state.activeItem.path);
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
  if (item.kind !== "image") {
    mediaSelection.set(item.path); // onChange → updateSelectionUI
    await closeInlineEditor();
    return;
  }

  // Claim editor ownership *before* the selection repaint so the batch bar
  // never flashes between the selection update and the (async) editor load.
  const alreadyShown = state.activeItem && state.activeItem.path === item.path;
  state.activeItem = item;
  mediaSelection.set(item.path); // onChange → updateSelectionUI (sees ownership)
  if (alreadyShown) return;

  if (editItem && editItem.path !== item.path) await flushEditSave();
  document.getElementById("side-name").textContent = item.name;
  document.getElementById("media-side").hidden = false;
  document.getElementById("app-right").hidden = false;
  invoke("set_window_width", { width: Math.max(window.innerWidth, 1220) });

  moveEditor(document.getElementById("media-side-editor"));
  await loadEditor(item);
}

// ⌘/Ctrl click: add/remove from the selection. The editor is sticky here — a
// second selection never opens, closes, or switches it.
async function toggleSelect(item) {
  mediaSelection.toggle(item.path, true); // onChange → updateSelectionUI
}

function clearSelection() {
  mediaSelection.clear(); // onChange → updateSelectionUI
  closeInlineEditor();
}

// Delete from the keyboard: in the editor/lightbox, trash the selection or the
// focused image; in the grid, trash the selection.
function mediaDeleteFromKeyboard() {
  const editorActive = !document.getElementById("lightbox").hidden || !!state.activeItem;
  if (editorActive) {
    const targets = mediaSelection.size()
      ? mediaSelection.get()
      : editItem
        ? [editItem.path]
        : [];
    trashMedia(targets);
  } else if (mediaSelection.size()) {
    trashMedia(mediaSelection.get());
  }
}

// Move the given media (and their edit sidecars) to the Trash, then refresh.
async function trashMedia(paths) {
  if (!paths.length) return;

  // Detach the editor from anything we're deleting so we don't re-save a
  // sidecar that trash_media is about to remove.
  if (editItem && paths.includes(editItem.path)) {
    editDirty = false;
    state.activeItem = null;
    editItem = null;
    editThumb = editImg = editPreview = editState = null;
    document.getElementById("lightbox").hidden = true;
    moveEditor(document.getElementById("media-side-editor"));
    document.getElementById("media-side").hidden = true;
    document.getElementById("app-right").hidden = true;
    invoke("set_window_width", { width: Math.max(window.innerWidth - 320, 900) });

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
  if (!copiedEdits || !mediaSelection.size()) return;
  const fields = {};
  for (const f of ADJ_FIELDS) if (f in copiedEdits) fields[f] = copiedEdits[f];

  const paths = mediaSelection.get();
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
  if (!state.activeProject) return;
  try {
    await invoke("paste_image", { projectPath: state.activeProject.path });
    selectTab("media");
    loadMedia(state.activeProject.path);
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
  const tw = Math.max(1, Math.round(base.width * scale));
  const th = Math.max(1, Math.round(base.height * scale));

  // Skip WebGL entirely when no tonal edits are applied — avoids spinning up
  // the GPU process just to view/browse images.
  const hasTonal =
    edits.exposure || edits.contrast || edits.saturation ||
    edits.temperature || edits.tint || edits.highlights || edits.shadows;
  if (!hasTonal) {
    const plain = document.createElement("canvas");
    plain.width = tw;
    plain.height = th;
    plain.getContext("2d").drawImage(base, 0, 0, tw, th);
    return plain.toDataURL("image/png");
  }

  thumbGLCanvas.width = tw;
  thumbGLCanvas.height = th;
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

function startRename(tile, nameEl, item) {
  if (tile.querySelector(".mediatile__rename")) return; // already renaming
  const input = el("textarea", "mediatile__rename", { rows: 1 });
  input.value = item.name;
  nameEl.replaceWith(input);
  // Auto-height.
  const resizeInput = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
  input.addEventListener("input", resizeInput);
  requestAnimationFrame(() => { resizeInput(); input.focus(); });
  // Select name without extension for convenience.
  const dotIdx = item.name.lastIndexOf(".");
  input.setSelectionRange(0, dotIdx > 0 ? dotIdx : item.name.length);

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName || newName === item.name) {
      cancel();
      return;
    }
    try {
      const newPath = await invoke("rename_media", { oldPath: item.path, newName });
      item.name = newName;
      item.path = newPath;
      tile.dataset.path = newPath;
      nameEl.textContent = newName;
    } catch (err) {
      console.error("Rename failed:", err);
    }
    input.replaceWith(nameEl);
  };

  const cancel = () => input.replaceWith(nameEl);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener("blur", commit);
  // Prevent tile click/select while renaming.
  input.addEventListener("click", (e) => e.stopPropagation());
}

// Build a media tile (queues its thumbnail load). `edited` collects edited
// images to bake after the grid is laid out.
function buildMediaTile(item, edited) {
  const isImage = item.kind === "image";
  const tile = el("button", "mediatile", { type: "button", title: item.name });
  tile.dataset.path = item.path;
  tile.dataset.sig = `${item.modified}|${item.edits_mtime}`;
  const thumb = el("div", "mediatile__thumb"); // the card visual + selection ring
  const img = el("img", "mediatile__img", {
    loading: "lazy",
    alt: item.name,
    draggable: false, // pointer-drag is ours; block native image drag
  });
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
  const nameEl = el("span", "mediatile__name", { textContent: item.name });
  nameEl.addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(tile, nameEl, item);
  });
  tile.append(nameEl);

  const metaParts = [];
  if (item.width && item.height) metaParts.push(`${item.width}×${item.height}`);
  if (item.file_size) {
    const kb = item.file_size / 1024;
    metaParts.push(kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`);
  }
  if (metaParts.length)
    tile.append(el("span", "mediatile__meta", { textContent: metaParts.join("  ·  ") }));

  if (mediaSelection.has(item.path)) tile.classList.add("is-selected");

  tile.addEventListener("pointerdown", (e) =>
    onMediaTilePointerDown(e, item, tile),
  );
  tile.addEventListener("click", (e) => {
    if (Date.now() - lastMediaDragEnd < 300) return; // ignore click after drag
    // Shift-click selects a range; ⌘/Ctrl-click toggles; plain click selects
    // only it (and opens the editor when it's a single image).
    if (e.shiftKey) {
      const order = [...document.querySelectorAll(".mediatile")].map(
        (t) => t.dataset.path,
      );
      mediaSelection.range(order, item.path);
    } else if (e.metaKey || e.ctrlKey) {
      toggleSelect(item);
    } else {
      selectOnly(item);
    }
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
  await loadMediaMeta(path);
  const items = sortMediaItems(await invoke("list_media", { path }));

  mediaItemsByPath.clear();
  for (const it of items) mediaItemsByPath.set(it.path, it);

  // Prune selection to files that still exist.
  const present = new Set(items.map((i) => i.path));
  for (const p of mediaSelection.get())
    if (!present.has(p)) mediaSelection.delete(p);
  updateSelbar();

  // Drop the inline edit focus if its file is gone.
  if (state.activeItem && !present.has(state.activeItem.path)) {
    state.activeItem = null;
    document.getElementById("media-side").hidden = true;
    document.getElementById("app-right").hidden = true;
    invoke("set_window_width", { width: Math.max(window.innerWidth - 320, 900) });

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
state.activeItem = null;

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
  if (!document.getElementById("lightbox").hidden)
    return editPreview || editThumb;
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
  const thumb = await loadImage(
    await invoke("read_image_data", { path: thumbPath }),
  );
  if (editItem !== item) return;
  editThumb = thumb;
  setEditStatus("");
  renderEditorPreview();
}

// Tear down the inline editor (no selection change). Refreshes the grid
// thumbnail if edits were made.
async function closeInlineEditor() {
  if (!state.activeItem) return;
  const dirty = editDirty;
  await flushEditSave();
  state.activeItem = null;
  document.getElementById("lightbox").hidden = true;
  moveEditor(document.getElementById("media-side-editor"));
  document.getElementById("media-side").hidden = true;
    document.getElementById("app-right").hidden = true;
    invoke("set_window_width", { width: Math.max(window.innerWidth - 320, 900) });

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
  if (!state.activeItem || state.activeItem.path !== item.path) {
    await selectOnly(item); // selects + loads the inline editor
  }
  if (!state.activeItem) return; // not an image — nothing to show
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
  if (state.activeItem) {
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
  const IMG_RE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
  // Heuristic preview of what a drop will do (the actual handling on drop uses
  // Rust is_dir for accuracy). Extensionless paths are treated as folders.
  function dropPreview(paths) {
    if (!paths.length)
      return { icon: "add_photo_alternate", label: "Drop to add to this project" };
    const hasFolder = paths.some((p) => !/\.[^/]+$/.test(p.split("/").pop()));
    if (hasFolder)
      return { icon: "create_new_folder", label: "Add folder to Workspace" };
    if (paths.every((p) => IMG_RE.test(p)))
      return { icon: "add_photo_alternate", label: "Move images into Project" };
    return { icon: "note_add", label: "Move files into the project" };
  }

  const blocked = () => state.draggingNoteId || state.mediaDragActive || !state.activeProject;
  // Only drag-enter carries paths in Tauri v2 (drag-over is position-only), so
  // set the label on enter and just keep the overlay visible on over.
  await listen("tauri://drag-enter", (e) => {
    if (blocked()) return;
    const preview = dropPreview((e.payload && e.payload.paths) || []);
    document.getElementById("dropzone-icon").textContent = preview.icon;
    document.getElementById("dropzone-label").textContent = preview.label;
    zone.hidden = false;
  });
  await listen("tauri://drag-over", () => {
    if (blocked()) return;
    zone.hidden = false;
  });
  await listen("tauri://drag-leave", () => (zone.hidden = true));
  await listen("tauri://drag-drop", async (e) => {
    zone.hidden = true;
    if (!state.activeProject || state.draggingNoteId) return;
    const paths = (e.payload && e.payload.paths) || [];
    if (!paths.length) return;
    try {
      // Classify the drop (§8.1): images → media/, files → project root,
      // folders → Workspace entries (referenced in place).
      const res = await invoke("handle_dropped_paths", {
        projectPath: state.activeProject.path,
        paths,
      });
      if (res.folders.length) {
        res.folders.forEach((f) => addRow("folders", f));
        scheduleWorkspaceSave();
        selectTab("workspace");
      } else if (res.images.length) {
        selectTab("media");
        loadMedia(state.activeProject.path);
      } else if (res.files.length) {
        // Non-image files moved into the project root; nothing to surface.
      }
    } catch (err) {
      console.error("Drop failed:", err);
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

// Longest side (px) for the inline thumbnail.
const THUMB_MAX = 768;


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
  if (!state.activeItem) return;
  liveThumbOriented = oriented;
  if (liveThumbRaf) return;
  liveThumbRaf = requestAnimationFrame(() => {
    liveThumbRaf = 0;
    if (!state.activeItem || !editState || !liveThumbOriented) return;
    const tile = document.querySelector(
      `.mediatile[data-path="${CSS.escape(state.activeItem.path)}"]`,
    );
    if (!tile) return;
    const url = bakeThumbFromOriented(liveThumbOriented, editState);
    thumbCache.set(state.activeItem.path, url);
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
  const noCrop = editState.crop === null;
  document.querySelectorAll("[data-aspect]").forEach((b) => {
    if (b.dataset.aspect === "none") {
      b.classList.toggle("is-active", noCrop);
    } else {
      const v = b.dataset.aspect === "free" ? null : Number(b.dataset.aspect);
      b.classList.toggle("is-active", !noCrop && v === R);
    }
  });
  document.getElementById("crop").style.display = noCrop ? "none" : "";
}

function applyAspect(R) {
  editState.cropAspect = R;
  if (!editState.crop) {
    editState.crop = { x: 0, y: 0, w: 1, h: 1 };
  }
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

// Bake a media item (geometry + crop + tonal applied) to a full-res PNG Blob,
// independent of the editor. Unedited images bake to identity (original pixels).
async function bakeItemToBlob(item) {
  const [dataUrl, saved] = await Promise.all([
    invoke("read_image_data", { path: item.path }),
    invoke("read_edits", { path: item.path }),
  ]);
  const img = await loadImage(dataUrl);
  const edits = { ...defaultEdits(), ...saved };
  const oriented = renderOriented(img, edits);
  exportGLCanvas.width = oriented.width;
  exportGLCanvas.height = oriented.height;
  glAdjust(exportGLCanvas, oriented, edits);
  let out = exportGLCanvas;
  const c = edits.crop;
  if (c && (c.x > 0 || c.y > 0 || c.w < 1 || c.h < 1)) {
    const sx = Math.round(c.x * exportGLCanvas.width);
    const sy = Math.round(c.y * exportGLCanvas.height);
    const sw = Math.max(1, Math.round(c.w * exportGLCanvas.width));
    const sh = Math.max(1, Math.round(c.h * exportGLCanvas.height));
    const cropped = document.createElement("canvas");
    cropped.width = sw;
    cropped.height = sh;
    cropped.getContext("2d").drawImage(exportGLCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    out = cropped;
  }
  return await new Promise((res) => out.toBlob(res, "image/png"));
}

// Shift+Mod+c: copy the actual image. Single → baked PNG bitmap on the
// clipboard (pastes into editors and Notes image-notes). The write must stay
// synchronous in the gesture, so the (async) bake rides as a Promise inside the
// ClipboardItem. (Multi-select → Finder-style file references is a native
// follow-up; for now it copies the first selected image as a bitmap.)
function copyMediaImage() {
  const items = mediaSelection
    .get()
    .map((p) => mediaItemsByPath.get(p))
    .filter((it) => it && it.kind === "image");
  if (!items.length) return;
  navigator.clipboard
    .write([new ClipboardItem({ "image/png": bakeItemToBlob(items[0]) })])
    .catch((e) => console.error("Copy image failed:", e));
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
    if (!mediaSelection.size()) return;
    openWebExport({
      mode: "batch",
      items: mediaSelection.get().map((p) => ({
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
let exMethod = null; // "patch" | "simple" | "color" — the last fill used
let exColor = "#cccccc"; // Color Fill colour (defaults to corner average)
let exHasAlpha = false; // whether the current image has transparent pixels

// True if any pixel in the canvas is not fully opaque.
function canvasHasAlpha(cv) {
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

const exTargetW = () => exBase.width + exMargins.l + exMargins.r;
const exTargetH = () => exBase.height + exMargins.t + exMargins.b;

// Average colour of the image's four corners (small sampled blocks) as #rrggbb.
function cornerAverage(cv) {
  const ctx = cv.getContext("2d");
  const s = Math.max(1, Math.round(Math.min(cv.width, cv.height) * 0.03));
  const corners = [
    [0, 0],
    [cv.width - s, 0],
    [0, cv.height - s],
    [cv.width - s, cv.height - s],
  ];
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (const [x, y] of corners) {
    const d = ctx.getImageData(x, y, s, s).data;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      n++;
    }
  }
  const hex = (v) =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// Select a fill method: highlight its button, show its options, and run it.
function selectFillMethod(method, btnId, run) {
  exMethod = method;
  document
    .querySelectorAll(".extend__fillbtn")
    .forEach((b) => b.classList.toggle("is-active", b.id === btnId));
  document.getElementById("opt-simple").hidden = method !== "simple";
  document.getElementById("opt-color").hidden = method !== "color";
  document.getElementById("extend-options").hidden =
    method !== "simple" && method !== "color";
  run();
}

// Re-run the active method when its options (sliders / colour) change.
function rerunActiveMethod() {
  if (exMethod === "simple") extendFillSimple();
  else if (exMethod === "color") extendFillColor();
}

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
  exHasAlpha = canvasHasAlpha(exBase);

  exMargins = { l: 0, r: 0, t: 0, b: 0 };
  exRatio = null;
  exRatioBase = null;
  exOrient = "landscape";
  exFinal = null;
  exMethod = null;
  setExtendReady(false);
  document.getElementById("extend-status").textContent = "";
  document
    .querySelectorAll("#extend-ratios .chip")
    .forEach((c) =>
      c.classList.toggle("is-active", c.dataset.ratio === "free"),
    );
  document
    .querySelectorAll("#extend-orient .orient-btn")
    .forEach((b) =>
      b.classList.toggle("is-active", b.dataset.orient === "landscape"),
    );
  // Reset fill-method selection + options.
  document
    .querySelectorAll(".extend__fillbtn")
    .forEach((b) => b.classList.remove("is-active"));
  document.getElementById("extend-options").hidden = true;
  // Seed Color Fill with the image's corner-average colour.
  exColor = cornerAverage(exBase);
  document.getElementById("extend-color").value = exColor;
  document.getElementById("extend-color-sw").style.background = exColor;
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
      if (a < 1)
        d[(y * c.width + x) * 4 + 3] = Math.round(Math.max(0, a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Shared fill flow. `engine(workPngB64, tw, th)` returns the filled PNG (base64)
// for the enlarged canvas; the original is feathered back on top to hide seams.
async function runExtendFill(engine, cap) {
  if (!exBase) return;
  // Color Fill is allowed with no extension (it backs a transparent image);
  // the others need actual margins to synthesize.
  if (
    exMargins.l + exMargins.r + exMargins.t + exMargins.b === 0 &&
    exMethod !== "color"
  ) {
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
    // Composite the original on top. Feather its edges into the fill to hide the
    // seam — except for Color Fill on a transparent image, where feathering
    // would fade the cutout's own edges into the colour (a halo).
    if (exMethod === "color" && exHasAlpha) {
      fctx.drawImage(exBase, exMargins.l, exMargins.t);
    } else {
      const feather = Math.min(
        64,
        Math.max(6, Math.round(Math.min(exBase.width, exBase.height) * 0.04)),
      );
      fctx.drawImage(
        featheredOriginal(exBase, exMargins, feather),
        exMargins.l,
        exMargins.t,
      );
    }
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
    if (y1 < wH - 1) o.drawImage(out, 0, y1, wW, 1, 0, y1 + 1, wW, wH - 1 - y1);

    // Blur the streaky stretch into a soft wash. Amount = Blur slider (% of the
    // working size).
    const blurPct = Number(document.getElementById("extend-blur").value);
    const blurred = document.createElement("canvas");
    blurred.width = wW;
    blurred.height = wH;
    const b = blurred.getContext("2d");
    b.filter = `blur(${Math.round((Math.min(wW, wH) * blurPct) / 100)}px)`;
    b.drawImage(out, 0, 0);

    // Add fine noise (Noise slider) so the flat blur isn't plasticky / banded.
    const img = b.getImageData(0, 0, wW, wH);
    const px = img.data;
    const amp = Number(document.getElementById("extend-noise").value);
    for (let i = 0; i < px.length; i += 4) {
      const n = (Math.random() - 0.5) * 2 * amp;
      px[i] = Math.max(0, Math.min(255, px[i] + n));
      px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + n));
      px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + n));
    }
    b.putImageData(img, 0, 0);
    return blurred.toDataURL("image/png").split(",")[1];
  }, 1024);
}

// "Color Fill" — fill the margins with a solid colour (exColor).
function extendFillColor() {
  return runExtendFill(async (work) => {
    const c = document.createElement("canvas");
    c.width = work.width;
    c.height = work.height;
    const ctx = c.getContext("2d");
    ctx.fillStyle = exColor;
    ctx.fillRect(0, 0, c.width, c.height);
    return c.toDataURL("image/png").split(",")[1];
  }, 512);
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

// --- Generate image (Image Playground via Shortcut) ------------------------

// Shortcut names (build these in the Shortcuts app):
//   text  → receives Shortcut Input (the prompt), runs Image Playground, returns image
//   photo → receives Shortcut Input (the image) + reads the prompt from the
//           clipboard, runs Image Playground, returns image
const GEN_SHORTCUT_TEXT = "Studio Generate";
const GEN_SHORTCUT_PHOTO = "Studio Generate From Photo";

function openGenerate() {
  if (!state.activeProject) return;
  document.getElementById("generate-prompt").value = "";
  document.getElementById("generate-status").textContent = "";
  // Offer "use selected image" only when a single image is selected.
  const seedable = !!(state.activeItem && state.activeItem.kind === "image");
  document.getElementById("generate-seed-row").hidden = !seedable;
  document.getElementById("generate-seed").checked = false;
  document.getElementById("generate").hidden = false;
  document.getElementById("generate-prompt").focus();
}

async function runGenerate() {
  if (!state.activeProject) return;
  const prompt = document.getElementById("generate-prompt").value.trim();
  const seed =
    document.getElementById("generate-seed").checked &&
    state.activeItem &&
    state.activeItem.kind === "image";
  if (!prompt && !seed) {
    document.getElementById("generate-status").textContent = "Enter a prompt";
    return;
  }

  const out = `${state.activeProject.path}/media/generated-${Date.now()}.png`;
  const status = document.getElementById("generate-status");
  const btn = document.getElementById("generate-run");
  status.textContent = "Generating…";
  btn.disabled = true;
  try {
    if (seed) {
      await invoke("run_shortcut", {
        name: GEN_SHORTCUT_PHOTO,
        inputPath: state.activeItem.path,
        clipboardText: prompt,
        outputPath: out,
      });
    } else {
      await invoke("run_shortcut", {
        name: GEN_SHORTCUT_TEXT,
        inputText: prompt,
        outputPath: out,
      });
    }
    document.getElementById("generate").hidden = true;
    if (mediaProjectPath) loadMedia(mediaProjectPath);
  } catch (err) {
    console.error("Generate failed:", err);
    status.textContent = `Failed: ${err}`;
  } finally {
    btn.disabled = false;
  }
}

function initGenerate() {
  document.getElementById("generate-open").addEventListener("click", openGenerate);
  document.getElementById("generate-run").addEventListener("click", runGenerate);
  document
    .getElementById("generate-cancel")
    .addEventListener(
      "click",
      () => (document.getElementById("generate").hidden = true),
    );
}

function initExtend() {
  document.getElementById("ed-extendbg").addEventListener("click", openExtend);
  document.getElementById("ed-photos").addEventListener("click", editInPhotos);
  document
    .getElementById("extend-fill")
    .addEventListener("click", () =>
      selectFillMethod("patch", "extend-fill", extendFill),
    );
  document
    .getElementById("extend-fill-simple")
    .addEventListener("click", () =>
      selectFillMethod("simple", "extend-fill-simple", extendFillSimple),
    );
  document
    .getElementById("extend-fill-color")
    .addEventListener("click", () =>
      selectFillMethod("color", "extend-fill-color", extendFillColor),
    );
  document
    .getElementById("extend-fill-sd")
    .addEventListener("click", () =>
      selectFillMethod("sd", "extend-fill-sd", extendFillSD),
    );
  // Live re-run when Simple/Color options change.
  document
    .getElementById("extend-blur")
    .addEventListener("change", rerunActiveMethod);
  document
    .getElementById("extend-noise")
    .addEventListener("change", rerunActiveMethod);
  document.getElementById("extend-color").addEventListener("input", (e) => {
    exColor = e.target.value;
    document.getElementById("extend-color-sw").style.background = exColor;
    rerunActiveMethod();
  });
  document.getElementById("extend-save").addEventListener("click", extendSave);
  document
    .getElementById("extend-edit-photos")
    .addEventListener("click", extendEditInPhotos);
  document
    .getElementById("extend-cancel")
    .addEventListener(
      "click",
      () => (document.getElementById("extend").hidden = true),
    );
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

  // Media sort toggles.
  document.getElementById("media-sort").addEventListener("click", (e) => {
    const btn = e.target.closest(".pill-tab");
    if (!btn) return;
    mediaSortMode = btn.dataset.sort;
    updateMediaSortUI();
    saveMediaMeta();
    if (mediaProjectPath) loadMedia(mediaProjectPath);
  });
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
      b.addEventListener("click", () => {
        if (b.dataset.aspect === "none") {
          resetCrop();
        } else {
          applyAspect(b.dataset.aspect === "free" ? null : Number(b.dataset.aspect));
        }
      }),
    );

  // Copy / paste adjustments live in the side "More" menu (wired in initMedia).
  loadCopiedEdits();
  window.addEventListener("resize", () => {
    if (previewSrc()) renderEditorPreview();
  });
}

// Re-pack the notes bento grid when the window (and thus column count) changes.
window.addEventListener("resize", () => {
  if (document.getElementById("notes-list")) scheduleBentoLayout();
});

function initMedia() {
  initEditor();
  initWebExport();
  initRemoveBg();
  initExtend();
  initGenerate();
  document.getElementById("sel-paste").addEventListener("click", batchPaste);
  document
    .getElementById("sel-clear")
    .addEventListener("click", clearSelection);

  // Side column: open the full lightbox for the selected image.
  document.getElementById("side-lightbox").addEventListener("click", () => {
    if (state.activeItem) openLightbox(state.activeItem);
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

  // Click off a thumbnail (empty grid space, panel padding, header) to clear
  // the selection. The batch bar and the editor side column keep their clicks.
  installOffClickDeselect({
    panel: "media",
    keep: [".mediatile", ".selbar", ".media-side"],
    hasSelection: () => mediaSelection.size(),
    clear: clearSelection,
  });

  // Media keyboard, routed through the shared dispatcher. The lightbox / inline
  // editor are Media sub-modes (not modals), so the handlers branch on mode.
  const lbOpen = () => !document.getElementById("lightbox").hidden;
  const editorActive = () => lbOpen() || !!state.activeItem;
  const activateSelectedMedia = () => {
    const ids = mediaSelection.get();
    if (ids.length !== 1) return;
    const item = mediaItemsByPath.get(ids[0]);
    if (!item) return;
    if (item.kind === "image") openLightbox(item);
    else invoke("open_path", { path: item.path });
  };
  panelKeymaps.media = {
    Enter: activateSelectedMedia,
    Escape: () => (lbOpen() ? closeLightbox() : clearSelection()),
    "Mod+c": () => {
      if (editorActive()) copyAdjustments();
    },
    "Mod+Shift+c": copyMediaImage,
    "Mod+v": () => {
      if (editorActive()) pasteAdjustments();
      else if (mediaSelection.size()) batchPaste();
      else pasteFromClipboard();
    },
    Delete: mediaDeleteFromKeyboard,
    Backspace: mediaDeleteFromKeyboard,
  };

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


export {
  loadMedia,
  initMedia,
  initDragDrop,
  mediaSelection,
  pasteImageFromClipboard,
};
