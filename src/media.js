// Media subsystem: grid, tiles, selection, sort/reorder, the image editor
// (tonal/crop/geometry), lightbox, export, and the tools (remove-bg, extend,
// generate). Extracted from main.js. See interaction-spec / BACKLOG file-split.

import { el, mi, genId } from "./dom.js";
import { loadImage, renderOriented, defaultEdits } from "./imageutil.js";
import { createSelection } from "./selection.js";
import { panelKeymaps } from "./keymap.js";
import { glAdjust } from "./gl.js";
import {
  setEditorHooks,
  initEditor,
  loadEditor,
  ensureFullRes,
  renderEditorPreview,
  flushEditSave,
  clearEditor,
  getEditItem,
  getCopiedEdits,
  ADJ_FIELDS,
  copyAdjustments,
  pasteAdjustments,
  exportEdited,
  exportCurrent,
  editInPhotos,
  bakeItemToBlob,
  openWebExport,
  setEditStatus,
  shouldSuppressLightboxClick,
  bumpRotate,
} from "./editor.js";
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
// The single source of truth for selection. A selection of exactly one image
// opens the editor; 0 or 2+ (or a single non-image) shows the batch bar instead.
// Media tile selection (interaction-spec §3). Multi-select; onChange repaints
// tile rings + the batch bar.
const mediaSelection = createSelection({
  mode: "multi",
  onChange: () => updateSelectionUI(),
});
const mediaItemsByPath = new Map(); // path → MediaItem, refreshed by loadMedia
// Absolute media path → number of video edits (videos/*.json) referencing it,
// refreshed by loadMedia alongside the file listing. Backs the "used in N
// edits" meta line on video tiles, a heads-up before a destructive rotate.
const videoUsage = new Map();

async function refreshVideoUsage(projectPath) {
  videoUsage.clear();
  let edits = [];
  try {
    edits = await invoke("list_videos", { path: projectPath });
  } catch {
    return;
  }
  await Promise.all(
    edits.map(async (v) => {
      let data;
      try {
        data = await invoke("read_video", { path: projectPath, file: v.file });
      } catch {
        return;
      }
      const clips = Array.isArray(data.clips) ? data.clips : [];
      // Count each edit once per referenced file, even if it has multiple clips.
      const refs = new Set();
      for (const c of clips) {
        if (!c.src) continue;
        refs.add(c.src.startsWith("/") ? c.src : `${projectPath}/${c.src}`);
      }
      for (const abs of refs) videoUsage.set(abs, (videoUsage.get(abs) || 0) + 1);
    }),
  );
}

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

// Build a PNG data-URL drag image (what the cursor carries during drag-out).
// Prefers the tile's own thumbnail; falls back to a neutral card if the
// thumbnail can't be read (e.g. a tainted canvas from the asset:// protocol).
// A count badge is drawn when dragging a multi-selection.
function makeDragIcon(tile, count) {
  const size = 72;
  const drawBadge = (ctx) => {
    if (count <= 1) return;
    const r = 12;
    ctx.beginPath();
    ctx.arc(size - r - 2, r + 2, r, 0, Math.PI * 2);
    ctx.fillStyle = "#e0392b";
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(count), size - r - 2, r + 3);
  };
  const img = tile.querySelector(".mediatile__img");
  try {
    if (!img || !img.complete || !img.naturalWidth) throw new Error("no thumb");
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const s = Math.max(size / img.naturalWidth, size / img.naturalHeight);
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    drawBadge(ctx);
    return c.toDataURL("image/png"); // throws if the canvas is tainted
  } catch (_) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#9a8f80";
    ctx.beginPath();
    ctx.roundRect(8, 6, size - 16, size - 12, 8);
    ctx.fill();
    drawBadge(ctx);
    return c.toDataURL("image/png");
  }
}

// Drag the real file(s) out to other apps. Honors the current selection: if the
// grabbed tile is part of a multi-selection, drag them all; otherwise just it.
async function startNativeFileDrag(item, tile, move = true) {
  const paths =
    mediaSelection.has(item.path) && mediaSelection.size() > 1
      ? mediaSelection.get()
      : [item.path];
  try {
    // Invoked directly rather than through `__TAURI__.drag.startDrag`, because
    // the plugin ships its own inlined Channel implementation that expects a
    // `{message, id}` envelope this Tauri version no longer sends — passing an
    // onEvent callback through it throws "undefined is not an object". Tauri's
    // own Channel always matches its own envelope.
    const onEvent = new window.__TAURI__.core.Channel();
    onEvent.onmessage = async (e) => {
      if (!move || e.result !== "Dropped") return;
      try {
        // "move" only states intent: macOS gives the destination the final say
        // and Finder answers cross-app file drags with Copy regardless, so the
        // move is finished on our side — and only when the drop landed in
        // Finder. See finish_drag_out in lib.rs.
        const res = await invoke("finish_drag_out", { paths });
        if (res.removed.length && mediaProjectPath) loadMedia(mediaProjectPath);
      } catch (err) {
        // Never swallow this — a silent failure here is indistinguishable from
        // "the move just didn't happen".
        console.error("[drag-out] finish failed:", err);
      }
    };
    await invoke("plugin:drag|start_drag", {
      item: paths,
      image: makeDragIcon(tile, paths.length),
      options: { mode: move ? "move" : "copy" },
      onEvent,
    });
  } catch (err) {
    console.error("drag-out failed:", err);
  }
}

function onMediaTilePointerDown(e, item, tile) {
  if (e.button !== 0) return;
  // The tile itself is a <button>, so only exclude the rename field / links /
  // the name label — NOT "button" (that would match the tile and never start
  // a drag). Excluding the name label matters: capturing the pointer here
  // would make WebKit retarget the resulting "click" to the tile instead of
  // the label, so click-to-rename would never fire.
  if (e.target.closest("textarea, input, a, .mediatile__name")) return;
  // Plain drag hands the file(s) to macOS, same as the File Directory: dropping
  // in Finder moves them out of the project, Option-drag copies instead. The
  // internal gesture — reorder within the grid, or drop onto the Notes tab to
  // make an image note — is on ⌘-drag, since dragging out is the far more
  // common intent.
  if (!e.metaKey) {
    const startX = e.clientX, startY = e.clientY;
    let started = false;
    const onMove = (ev) => {
      if (started) return;
      // Threshold, so a plain click still selects instead of starting a drag.
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      started = true;
      cleanup();
      // Modifier read at drag start, not at press — you can decide to copy
      // after you've already started moving.
      startNativeFileDrag(item, tile, !ev.altKey);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    return;
  }
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
  document.getElementById("sel-paste").disabled = !getCopiedEdits() || n === 0;
  const rotatable = n > 0 || !!getEditItem();
  document.getElementById("media-rotl").disabled = !rotatable;
  document.getElementById("media-rotr").disabled = !rotatable;
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

  const cur = getEditItem();
  if (cur && cur.path !== item.path) await flushEditSave();
  document.getElementById("side-name").textContent = item.name;
  const appRight = document.getElementById("app-right");
  if (editorSidebarEnabled && appRight.hidden) {
    document.getElementById("media-side").hidden = false;
    appRight.hidden = false;
    invoke("set_window_width", { width: window.innerWidth + 320 });
  }

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
    const cur = getEditItem();
    const targets = mediaSelection.size()
      ? mediaSelection.get()
      : cur
        ? [cur.path]
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
  const cur = getEditItem();
  if (cur && paths.includes(cur.path)) {
    state.activeItem = null;
    clearEditor();
    document.getElementById("lightbox").hidden = true;
    moveEditor(document.getElementById("media-side-editor"));
    const appRight = document.getElementById("app-right");
    if (appRight && !appRight.hidden) {
      document.getElementById("media-side").hidden = true;
      appRight.hidden = true;
      invoke("set_window_width", { width: window.innerWidth - 320 });
    }
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

// Rotate the current selection (or the item open in the editor, if nothing's
// selected) by a multiple of 90°, Finder-style. Images rotate non-destructively
// via the edit sidecar (same field the editor's rotate buttons use); videos
// have no such non-destructive layer in the grid, so the file itself is
// losslessly rotated (remux, no re-encode) by rotate_video.
async function rotateMedia(deltaDeg) {
  const cur = getEditItem();
  const paths = mediaSelection.size()
    ? mediaSelection.get()
    : cur
      ? [cur.path]
      : [];
  const items = paths.map((p) => mediaItemsByPath.get(p)).filter(Boolean);
  if (!items.length) return;

  for (const item of items) {
    if (item.kind === "image") {
      if (cur && cur.path === item.path) {
        bumpRotate(deltaDeg); // editor owns this item — let it save its own state
        continue;
      }
      const existing = await invoke("read_edits", { path: item.path });
      const rotate = (((existing.rotate ?? 0) + deltaDeg) % 360 + 360) % 360;
      await invoke("save_edits", { path: item.path, edits: { version: 1, ...existing, rotate } });
      invalidateThumb(item.path);
    } else if (item.kind === "video") {
      try {
        await invoke("rotate_video", { path: item.path, degrees: deltaDeg });
      } catch (err) {
        console.error("Rotate video failed:", err);
      }
    }
  }
  if (mediaProjectPath) loadMedia(mediaProjectPath);
}

// Write the copied adjustments onto every selected image's sidecar.
async function batchPaste() {
  const copiedEdits = getCopiedEdits();
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
  const nameEl = el("span", "mediatile__name text-s", { textContent: item.name });
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
  if (item.kind === "video" && videoUsage.has(item.path)) {
    const n = videoUsage.get(item.path);
    metaParts.push(`used in ${n} edit${n === 1 ? "" : "s"}`);
  }
  if (metaParts.length)
    tile.append(el("span", "mediatile__meta text-xs", { textContent: metaParts.join("  ·  ") }));

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
  const [items] = await Promise.all([
    invoke("list_media", { path }).then(sortMediaItems),
    refreshVideoUsage(path),
  ]);

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
    // Only reclaim the column if it was actually showing. The width change is
    // *relative*, so an unguarded shrink here compounds — every reload that
    // notices a missing file takes another 320px off, which is how dragging a
    // file out used to leave the window a sliver.
    const appRight = document.getElementById("app-right");
    if (appRight && !appRight.hidden) {
      document.getElementById("media-side").hidden = true;
      appRight.hidden = true;
      invoke("set_window_width", { width: window.innerWidth - 320 });
    }
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

// Tear down the inline editor (no selection change). Refreshes the grid
// thumbnail if edits were made.
async function closeInlineEditor() {
  if (!state.activeItem) return;
  const dirty = await flushEditSave(); // true only if there were pending edits
  state.activeItem = null;
  document.getElementById("lightbox").hidden = true;
  moveEditor(document.getElementById("media-side-editor"));
  // Only reclaim the 320px column width if it was actually showing — otherwise
  // deselecting with the sidebar off wrongly shrinks the window.
  const appRight = document.getElementById("app-right");
  if (appRight && !appRight.hidden) {
    document.getElementById("media-side").hidden = true;
    appRight.hidden = true;
    invoke("set_window_width", { width: window.innerWidth - 320 });
  }

  clearEditor();
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
  const current = getEditItem();
  setEditStatus("Loading…");
  await ensureFullRes(); // …then upgrade to the ~2048px preview
  if (getEditItem() === current) {
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
    clearEditor();
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

  // The Files tab embeds the File Directory tool, which handles OS drops itself
  // (dropping onto a folder row moves the files there) — so the project-wide
  // "add to this project" routing steps aside while that tab is open.
  const blocked = () =>
    state.draggingNoteId ||
    state.mediaDragActive ||
    state.activePanel === "files" ||
    !state.activeProject;
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

let editorSidebarEnabled = false;
state.editorSidebarEnabled = false;
// Live-preview hook for the editor: mirror the current edit onto the selected
// image's grid tile, reusing the editor's cached oriented canvas. Coalesced to
// one bake per animation frame.
let liveThumbRaf = 0;
let liveThumbOriented = null;
let liveThumbEdits = null;
function scheduleLiveThumb(oriented, edits) {
  if (!state.activeItem) return;
  liveThumbOriented = oriented;
  liveThumbEdits = edits;
  if (liveThumbRaf) return;
  liveThumbRaf = requestAnimationFrame(() => {
    liveThumbRaf = 0;
    if (!state.activeItem || !liveThumbOriented) return;
    const tile = document.querySelector(
      `.mediatile[data-path="${CSS.escape(state.activeItem.path)}"]`,
    );
    if (!tile) return;
    const url = bakeThumbFromOriented(liveThumbOriented, liveThumbEdits);
    thumbCache.set(state.activeItem.path, url);
    tile.querySelector(".mediatile__img").src = url;
  });
}

// Optimistic grid-tile thumbnail used after a paste, before the full re-bake.
function optimisticTileThumb(path, src, edits) {
  const tile = document.querySelector(
    `.mediatile[data-path="${CSS.escape(path)}"]`,
  );
  if (!tile) return;
  const url = bakeThumbDataURL(src, edits);
  thumbCache.set(path, url);
  tile.querySelector(".mediatile__img").src = url;
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

// Wire the media-grid sort toggles (the editor surface itself is wired by
// editor.js's initEditor).
function initMediaSort() {
  document.getElementById("media-sort").addEventListener("click", (e) => {
    const btn = e.target.closest(".pill-tab");
    if (!btn) return;
    mediaSortMode = btn.dataset.sort;
    updateMediaSortUI();
    saveMediaMeta();
    if (mediaProjectPath) loadMedia(mediaProjectPath);
  });
}

// Re-pack the notes bento grid when the window (and thus column count) changes.
window.addEventListener("resize", () => {
  if (document.getElementById("notes-list")) scheduleBentoLayout();
});

function setEditorSidebar(enabled) {
  editorSidebarEnabled = enabled;
  state.editorSidebarEnabled = enabled;
  document.getElementById("media-editor-toggle").checked = enabled;
  // Guarded both ways: the width change is relative, so toggling toward the
  // state the column is already in would resize the window for nothing.
  const appRight = document.getElementById("app-right");
  if (!enabled && state.activeItem && appRight && !appRight.hidden) {
    document.getElementById("media-side").hidden = true;
    appRight.hidden = true;
    invoke("set_window_width", { width: window.innerWidth - 320 });
  } else if (enabled && state.activeItem && appRight && appRight.hidden) {
    document.getElementById("media-side").hidden = false;
    appRight.hidden = false;
    invoke("set_window_width", { width: window.innerWidth + 320 });
  }
}

function initMedia() {
  // The shared editor controller drives the edit surface + Export / Remove-bg /
  // Extend modals; inject the grid-specific behaviour it needs.
  setEditorHooks({
    livePreview: scheduleLiveThumb,
    optimisticThumb: optimisticTileThumb,
    afterWrite: () => {
      if (mediaProjectPath) loadMedia(mediaProjectPath);
    },
    invalidateThumb,
  });
  initEditor();
  initMediaSort();
  initGenerate();
  document.getElementById("media-rotl").addEventListener("click", () => rotateMedia(-90));
  document.getElementById("media-rotr").addEventListener("click", () => rotateMedia(90));
  document.getElementById("media-editor-toggle").addEventListener("change", (e) =>
    setEditorSidebar(e.target.checked)
  );
  document.getElementById("sel-paste").addEventListener("click", batchPaste);
  document
    .getElementById("sel-clear")
    .addEventListener("click", clearSelection);

  // Batch export of the current grid selection (the editor wires single-image
  // export itself).
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
      document.getElementById("m-pasteadj").disabled = !getCopiedEdits();
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
    const it = getEditItem();
    if (it) navigator.clipboard.writeText(it.path);
  });
  menuAction("m-reveal", () => {
    const it = getEditItem();
    if (it) invoke("reveal_in_finder", { path: it.path });
  });
  menuAction("m-photos", editInPhotos); // Edit in Photos

  // Click off a thumbnail (empty grid space, panel padding, header) to clear
  // the selection. The batch bar and the editor side column keep their clicks.
  installOffClickDeselect({
    panel: "media",
    keep: [".mediatile", ".selbar", ".media-side", ".media-toolbar"],
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
    // Spacebar previews full-size in a separate window (like Finder's Quick
    // Look); the inline editor lightbox is reached via the side "expand" button.
    // qlmanage's preview panel crashes on AV items, so video opens in the
    // default player instead.
    if (item.kind === "video") invoke("open_path", { path: item.path });
    else invoke("quicklook_preview", { path: item.path });
  };
  panelKeymaps.media = {
    Enter: activateSelectedMedia,
    Escape: () => (lbOpen() ? closeLightbox() : clearSelection()),
    "Mod+c": () => {
      if (editorActive() && editorSidebarEnabled) copyAdjustments();
      else if (state.activeItem || mediaSelection.size()) copyMediaImage();
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

  // Lightbox bar "More" menu (file actions). The lb-* items keep their ids, so
  // editor.js / the handlers below wire them regardless of where they live.
  const lbMenu = document.getElementById("lb-menu");
  document.getElementById("lb-more").addEventListener("click", (e) => {
    e.stopPropagation();
    lbMenu.hidden = !lbMenu.hidden;
  });
  lbMenu.addEventListener("click", () => (lbMenu.hidden = true)); // any item closes it
  document.addEventListener("click", () => (lbMenu.hidden = true));

  document.getElementById("lightbox").addEventListener("click", (e) => {
    if (shouldSuppressLightboxClick()) return;
    if (
      e.target.id === "lightbox" ||
      e.target.classList.contains("lightbox__stage")
    ) {
      closeLightbox();
    }
  });
  document.getElementById("lb-copy").addEventListener("click", () => {
    const it = getEditItem();
    if (it) navigator.clipboard.writeText(it.path);
  });
  document.getElementById("lb-reveal").addEventListener("click", () => {
    const it = getEditItem();
    if (it) invoke("reveal_in_finder", { path: it.path });
  });
}


export {
  loadMedia,
  initMedia,
  initDragDrop,
  mediaSelection,
  pasteImageFromClipboard,
};
