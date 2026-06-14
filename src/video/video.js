// Video editor window. The whole edit is `<project>/video.json`, shared live
// with Claude Code: we save (debounced) on every change and reload whenever the
// file changes on disk (`fs-changed`). See docs/video-plan.md.
import { initDevInspect } from "../devinspect.js";
initDevInspect();

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;

const params = new URLSearchParams(location.search);
const projectPath = params.get("path") || "";
const projectName = projectPath.split("/").filter(Boolean).pop() || "Untitled";

const $project = document.getElementById("project");
const $docsel = document.getElementById("docsel");
const $newdoc = document.getElementById("newdoc");
const $deldoc = document.getElementById("deldoc");
const $stage = document.getElementById("stage");
const $placeholder = document.getElementById("placeholder");
// Double-buffered playback: two <video> elements, one visible ("active") and
// one preloading the next clip ("standby"). They swap at clip boundaries so no
// black frame shows during the src reload.
const els = [document.getElementById("vidA"), document.getElementById("vidB")];
let curEl = 0;
const activeVid = () => els[curEl];
const standbyVid = () => els[curEl ^ 1];
function showActive() {
  els[curEl].classList.add("active");
  els[curEl ^ 1].classList.remove("active");
}
const $play = document.getElementById("play");
const $time = document.getElementById("time");
const $addsel = document.getElementById("addsel");
const $addtext = document.getElementById("addtext");
const $overlay = document.getElementById("overlay");
const $timeline = document.getElementById("timeline");
const $clipLane = document.getElementById("clipLane");
const $textLane = document.getElementById("textLane");
const $playhead = document.getElementById("playhead");
const $inspector = document.getElementById("inspector");
const $toast = document.getElementById("toast");

$project.textContent = projectName;
$project.title = projectPath;
document.title = `Video — ${projectName}`;

let doc = { version: 1, preset: "youtube", hdr: "sdr", clips: [], text: [] };
let currentFile = null; // basename of the open edit under videos/
let edits = []; // [{ file, name, modified }]
let activeIdx = 0; // which clip is loaded into the <video> element
let playhead = 0; // global timeline position, seconds
let sel = null; // current selection: { type:"clip"|"text", id }
let dragging = false; // suppress scrub during block drag/trim

// ── Persistence ────────────────────────────────────────────────────────────
let saveTimer;
let writingSelf = false; // suppress the fs-changed echo from our own write
function scheduleVideoSave() {
  if (!currentFile) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    writingSelf = true;
    try {
      await invoke("write_video", { path: projectPath, file: currentFile, doc });
    } catch (e) {
      toast(String(e));
    }
    // Let the FSEvents echo land before re-enabling reload.
    setTimeout(() => (writingSelf = false), 250);
  }, 400);
}

// ── Edit documents (multiple per project) ───────────────────────────────────
function renderDocSel() {
  $docsel.innerHTML = "";
  for (const e of edits) {
    const opt = document.createElement("option");
    opt.value = e.file;
    opt.textContent = e.name;
    if (e.file === currentFile) opt.selected = true;
    $docsel.append(opt);
  }
  $deldoc.disabled = edits.length === 0;
}

async function refreshEditList() {
  edits = await invoke("list_videos", { path: projectPath });
  renderDocSel();
}

$docsel.addEventListener("change", () => openEdit($docsel.value));

$newdoc.addEventListener("click", async () => {
  const name = prompt("Name this video", "Untitled");
  if (name === null) return;
  try {
    const file = await invoke("create_video", { path: projectPath, name: name.trim() || "Untitled" });
    await refreshEditList();
    await openEdit(file);
  } catch (e) {
    toast(String(e));
  }
});

$deldoc.addEventListener("click", async () => {
  if (!currentFile) return;
  const cur = edits.find((e) => e.file === currentFile);
  if (!confirm(`Delete “${cur ? cur.name : currentFile}”? This can't be undone.`)) return;
  try {
    await invoke("delete_video", { path: projectPath, file: currentFile });
    currentFile = null;
    await refreshEditList();
    if (edits.length) await openEdit(edits[0].file);
    else await ensureAnEdit();
  } catch (e) {
    toast(String(e));
  }
});

async function openEdit(file) {
  currentFile = file;
  activeIdx = 0;
  playhead = 0;
  sel = null;
  try {
    doc = await invoke("read_video", { path: projectPath, file });
  } catch (e) {
    toast(String(e));
    return;
  }
  if (!doc.clips) doc.clips = [];
  if (!doc.text) doc.text = [];
  renderDocSel();
  render();
}

// Make sure the project has at least one edit to show on first open.
async function ensureAnEdit() {
  if (edits.length === 0) {
    const file = await invoke("create_video", { path: projectPath, name: "Untitled" });
    await refreshEditList();
    await openEdit(file);
  } else {
    await openEdit(edits[0].file);
  }
}

// ── Path helpers ────────────────────────────────────────────────────────────
// JSON stores clip `src` relative to the project folder when possible (so it's
// portable + readable for Claude); resolve to absolute for playback.
function absSrc(src) {
  if (src.startsWith("/")) return src;
  return `${projectPath}/${src}`;
}
function relSrc(abs) {
  const prefix = projectPath.endsWith("/") ? projectPath : projectPath + "/";
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

const clips = () => doc.clips || (doc.clips = []);
const clipDur = (c) => Math.max(0, (c.out ?? 0) - (c.in ?? 0));

// ── Rendering ───────────────────────────────────────────────────────────────
function fmt(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function totalDur() {
  return clips().reduce((sum, c) => sum + clipDur(c), 0);
}

const text = () => doc.text || (doc.text = []);

// Global timeline layout: each clip's [start,end] on the final timeline.
function layout() {
  let t = 0;
  return clips().map((c) => {
    const start = t;
    const dur = clipDur(c);
    t += dur;
    return { c, start, end: start + dur, dur };
  });
}

// Map a global time → which clip + the source `currentTime` to seek to.
function globalToClip(t) {
  const segs = layout();
  for (let i = 0; i < segs.length; i++) {
    if (t < segs[i].end || i === segs.length - 1) {
      return { idx: i, src: (clips()[i].in ?? 0) + (t - segs[i].start) };
    }
  }
  return null;
}

function render() {
  const has = clips().length > 0;
  $play.disabled = !has;
  $placeholder.hidden = has;
  $addtext.disabled = !has;
  for (const el of els) el.style.display = has ? "" : "none";
  if (has) {
    if (activeIdx >= clips().length) activeIdx = 0;
    loadClip(activeIdx, false);
  } else {
    for (const el of els) {
      el.removeAttribute("src");
      el.dataset.src = "";
      el.dataset.clip = "";
    }
  }
  renderTimeline();
  renderOverlay();
  updateTime();
  renderInspector();
}

// ── Timeline rendering ──────────────────────────────────────────────────────
function renderTimeline() {
  const total = totalDur() || 1;
  const segs = layout();
  $clipLane.innerHTML = "";
  segs.forEach((s, i) => {
    const b = document.createElement("div");
    b.className = "block" + (sel?.type === "clip" && sel.id === clips()[i].id ? " sel" : "");
    b.style.left = (s.start / total) * 100 + "%";
    b.style.width = (s.dur / total) * 100 + "%";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = clips()[i].src.split("/").pop();
    const hl = document.createElement("div");
    hl.className = "handle l";
    const hr = document.createElement("div");
    hr.className = "handle r";
    b.append(hl, label, hr);
    hl.addEventListener("pointerdown", (e) => startTrim(e, i, "in"));
    hr.addEventListener("pointerdown", (e) => startTrim(e, i, "out"));
    b.addEventListener("pointerdown", (e) => startClipDrag(e, i));
    $clipLane.append(b);
  });

  // Stack text layers into separate tracks so overlapping captions don't
  // collide — greedily pack each into the first row where it fits (by time).
  $textLane.innerHTML = "";
  const rows = assignTextRows();
  if (rows.length === 0) {
    const lane = document.createElement("div");
    lane.className = "lane lane--text";
    $textLane.append(lane); // an empty placeholder track
  }
  rows.forEach((row) => {
    const lane = document.createElement("div");
    lane.className = "lane lane--text";
    row.forEach((tx) => {
      const b = document.createElement("div");
      b.className = "block" + (sel?.type === "text" && sel.id === tx.id ? " sel" : "");
      b.style.left = ((tx.start ?? 0) / total) * 100 + "%";
      b.style.width = Math.max(0.02, ((tx.end ?? 0) - (tx.start ?? 0)) / total) * 100 + "%";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = tx.text || "(text)";
      const hl = document.createElement("div");
      hl.className = "handle l";
      const hr = document.createElement("div");
      hr.className = "handle r";
      b.append(hl, label, hr);
      hl.addEventListener("pointerdown", (e) => startTextResize(e, tx, "start"));
      hr.addEventListener("pointerdown", (e) => startTextResize(e, tx, "end"));
      b.addEventListener("pointerdown", (e) => startTextDrag(e, tx));
      lane.append(b);
    });
    $textLane.append(lane);
  });

  positionPlayhead();
}

// Greedy packing of text layers into rows with no time overlap within a row.
function assignTextRows() {
  const items = [...text()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const rows = [];
  for (const tx of items) {
    let placed = false;
    for (const row of rows) {
      const last = row[row.length - 1];
      if ((tx.start ?? 0) >= (last.end ?? 0)) {
        row.push(tx);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([tx]);
  }
  return rows;
}

function positionPlayhead() {
  const total = totalDur() || 1;
  const pad = 6; // .timeline padding
  const w = $timeline.clientWidth - pad * 2;
  $playhead.style.left = pad + (playhead / total) * w + "px";
}

// ── Caption/title overlay (preview of the baked look) ───────────────────────
function renderOverlay() {
  $overlay.innerHTML = "";
  const fh = activeVid().clientHeight || $overlay.clientHeight || 1;
  for (const tx of text()) {
    const s = tx.start ?? 0;
    const e = tx.end ?? 0;
    if (playhead < s || playhead > e) continue;
    const node = buildLayerNode(tx, playhead - s, e - s, fh);
    if (node) $overlay.append(node);
  }
}

// One animated text node. `lt` = local time within the layer, `dur` its length.
function buildLayerNode(tx, lt, dur, frameH) {
  const node = document.createElement("div");
  node.className = "lyr";
  node.style.left = (tx.x ?? 0.5) * 100 + "%";
  node.style.top = (tx.y ?? 0.85) * 100 + "%";
  node.style.color = tx.color || "#fff";
  node.style.background = tx.bg || "transparent";
  if (tx.font) node.style.fontFamily = tx.font;
  node.style.fontSize = Math.max(8, (tx.size ?? 0.06) * frameH) + "px";

  const anim = tx.anim || "none";
  const into = Math.min(0.4, dur / 3); // ease-in window
  const full = tx.text || "";
  if (anim === "words") {
    const words = full.split(/\s+/).filter(Boolean);
    const shown = Math.max(1, Math.ceil((lt / dur) * words.length));
    node.textContent = words.slice(0, shown).join(" ");
  } else if (anim === "typewriter") {
    const n = Math.max(1, Math.ceil((lt / dur) * full.length));
    node.textContent = full.slice(0, n);
  } else {
    node.textContent = full;
  }
  if (anim === "fade") {
    const out = dur - into;
    node.style.opacity = lt < into ? lt / into : lt > out ? Math.max(0, (dur - lt) / into) : 1;
  } else if (anim === "slide") {
    const p = Math.min(1, lt / into);
    const off = (1 - p) * 30; // px
    const dir = tx.from || "bottom";
    const dx = dir === "left" ? -off : dir === "right" ? off : 0;
    const dy = dir === "top" ? -off : dir === "bottom" ? off : 0;
    node.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    node.style.opacity = p;
  }
  return node;
}

// ── Playback (double-buffered, global-time driven) ──────────────────────────
// Load clip `idx` into a given element and (optionally) seek to its in-point.
function loadInto(el, idx, { play = false } = {}) {
  const c = clips()[idx];
  if (!c) return;
  el.dataset.clip = String(idx);
  const url = convertFileSrc(absSrc(c.src));
  if (el.dataset.src !== url) {
    el.dataset.src = url;
    el.src = url;
  }
  const target = c.in ?? 0;
  const apply = () => {
    try {
      el.currentTime = target;
    } catch {}
    if (play) el.play();
  };
  if (el.readyState >= 1) apply();
  else {
    el.addEventListener("loadedmetadata", function h() {
      el.removeEventListener("loadedmetadata", h);
      apply();
    });
  }
}

// Preload the clip after `idx` into the standby element (paused, pre-seeked).
function preloadNext(idx) {
  const n = idx + 1;
  if (n < clips().length) loadInto(standbyVid(), n, { play: false });
}

// Jump the active element to clip `i` (used for scrub/select/initial load).
function loadClip(i, keepPlaying) {
  activeIdx = i;
  loadInto(activeVid(), i, { play: keepPlaying });
  showActive();
  preloadNext(i);
}

// Swap to the preloaded standby element at a clip boundary — no black frame.
function advance() {
  const next = activeIdx + 1;
  if (next >= clips().length) {
    activeVid().pause();
    return;
  }
  const wasPlaying = !activeVid().paused;
  const old = activeVid();
  const sb = standbyVid();
  if (parseInt(sb.dataset.clip) !== next) loadInto(sb, next, { play: false });
  old.pause();
  curEl ^= 1; // standby becomes active
  activeIdx = next;
  showActive();
  if (wasPlaying) activeVid().play();
  preloadNext(next); // preload next+1 into the now-standby (old active)
}

// Seek the whole timeline to a global time.
function seekGlobal(t) {
  const total = totalDur();
  playhead = Math.max(0, Math.min(total, t));
  const m = globalToClip(playhead);
  if (!m) return;
  const wasPlaying = !activeVid().paused;
  if (m.idx !== activeIdx) loadClip(m.idx, wasPlaying);
  const v = activeVid();
  if (v.readyState >= 1) {
    try {
      v.currentTime = m.src;
    } catch {}
  }
  positionPlayhead();
  renderOverlay();
  updateTime();
}

$play.addEventListener("click", () => {
  const v = activeVid();
  if (v.paused) v.play();
  else v.pause();
});
let rafId = null;
// Listeners on both elements; only the active one drives the UI.
for (const el of els) {
  el.addEventListener("play", (e) => {
    if (e.target !== activeVid()) return;
    $play.textContent = "❚❚ Pause";
    if (!rafId) rafId = requestAnimationFrame(frame);
  });
  el.addEventListener("pause", (e) => {
    if (e.target !== activeVid()) return;
    $play.textContent = "▶︎ Play";
  });
  // `timeupdate` is a coarse (~4 Hz) backstop; the rAF loop does smooth work.
  el.addEventListener("timeupdate", (e) => {
    if (e.target === activeVid()) syncPlayhead();
  });
}

function frame() {
  syncPlayhead();
  rafId = activeVid().paused ? null : requestAnimationFrame(frame);
}

function syncPlayhead() {
  let c = clips()[activeIdx];
  if (!c) return;
  const v = activeVid();
  if (v.currentTime >= (c.out ?? v.duration)) {
    advance();
    c = clips()[activeIdx];
    if (!c) return;
  }
  const seg = layout()[activeIdx];
  if (seg) playhead = seg.start + Math.max(0, activeVid().currentTime - (c.in ?? 0));
  positionPlayhead();
  renderOverlay();
  updateTime();
}

function updateTime() {
  $time.textContent = `${fmt(playhead)} / ${fmt(totalDur())}`;
}

// ── Timeline interactions: scrub, trim, reorder, text move/resize ───────────
function timeAtX(clientX) {
  const r = $timeline.getBoundingClientRect();
  const pad = 6;
  const w = r.width - pad * 2;
  const frac = Math.max(0, Math.min(1, (clientX - r.left - pad) / w));
  return frac * (totalDur() || 0);
}

// Scrub by pressing anywhere on the timeline background (or grabbing the
// playhead) and dragging. Blocks/handles stopPropagation so they don't scrub.
// Window-level move/up means the cursor can roam well outside the thin
// playhead without dropping the drag.
function startScrub(e) {
  e.preventDefault();
  dragging = true;
  $timeline.classList.add("scrubbing");
  seekGlobal(timeAtX(e.clientX));
  const move = (ev) => seekGlobal(timeAtX(ev.clientX));
  const up = () => {
    dragging = false;
    $timeline.classList.remove("scrubbing");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
$timeline.addEventListener("pointerdown", startScrub);

function pxPerSecond() {
  const r = $timeline.getBoundingClientRect();
  return (r.width - 12) / (totalDur() || 1);
}

function startTrim(e, i, edge) {
  e.stopPropagation();
  e.preventDefault();
  const c = clips()[i];
  const startX = e.clientX;
  const orig = edge === "in" ? c.in ?? 0 : c.out ?? 0;
  const pps = pxPerSecond();
  selectClip(c);
  const move = (ev) => {
    let v = orig + (ev.clientX - startX) / pps;
    if (edge === "in") c.in = Math.max(0, Math.min(v, (c.out ?? 0) - 0.1));
    else c.out = Math.max((c.in ?? 0) + 0.1, v); // upper clamp on commit/probe
    renderTimeline();
    updateTime();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    clampClipOut(c);
    scheduleVideoSave();
    seekGlobal(layout()[i]?.start ?? 0);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Keep out within the source duration (probe if we don't know it yet).
async function clampClipOut(c) {
  if (!c.srcDur) c.srcDur = await probeDuration(absSrc(c.src));
  if (c.srcDur && c.out > c.srcDur) {
    c.out = c.srcDur;
    renderTimeline();
    scheduleVideoSave();
  }
}

function startClipDrag(e, i) {
  e.preventDefault();
  e.stopPropagation();
  selectClip(clips()[i]);
  const startX = e.clientX;
  let moved = false;
  let targetIdx = i;
  const move = (ev) => {
    if (Math.abs(ev.clientX - startX) < 4 && !moved) return;
    moved = true;
    // Determine drop index from cursor position across the clip lane.
    const segs = layout();
    const total = totalDur() || 1;
    const r = $clipLane.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * total;
    targetIdx = segs.findIndex((s) => t < (s.start + s.end) / 2);
    if (targetIdx === -1) targetIdx = segs.length - 1;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (moved && targetIdx !== i) {
      const [c] = clips().splice(i, 1);
      clips().splice(targetIdx, 0, c);
      activeIdx = targetIdx;
      scheduleVideoSave();
    } else if (!moved) {
      seekGlobal(layout()[i]?.start ?? 0); // click → scrub to clip start
    }
    render();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function startTextDrag(e, tx) {
  e.preventDefault();
  e.stopPropagation();
  selectText(tx);
  const startX = e.clientX;
  const len = (tx.end ?? 0) - (tx.start ?? 0);
  const origStart = tx.start ?? 0;
  const pps = pxPerSecond();
  let moved = false;
  const move = (ev) => {
    if (Math.abs(ev.clientX - startX) < 3 && !moved) return;
    moved = true;
    const total = totalDur();
    tx.start = Math.max(0, Math.min(total - len, origStart + (ev.clientX - startX) / pps));
    tx.end = tx.start + len;
    renderTimeline();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (moved) scheduleVideoSave();
    renderOverlay();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function startTextResize(e, tx, edge) {
  e.stopPropagation();
  e.preventDefault();
  selectText(tx);
  const startX = e.clientX;
  const orig = edge === "start" ? tx.start ?? 0 : tx.end ?? 0;
  const pps = pxPerSecond();
  const move = (ev) => {
    const v = orig + (ev.clientX - startX) / pps;
    if (edge === "start") tx.start = Math.max(0, Math.min(v, (tx.end ?? 0) - 0.1));
    else tx.end = Math.max((tx.start ?? 0) + 0.1, Math.min(v, totalDur()));
    renderTimeline();
    renderOverlay();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    scheduleVideoSave();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ── Selection + inspector ───────────────────────────────────────────────────
function selectClip(c) {
  sel = { type: "clip", id: c.id };
  renderTimeline();
  renderInspector();
}
function selectText(tx) {
  sel = { type: "text", id: tx.id };
  renderTimeline();
  renderInspector();
}

function selectedText() {
  return sel?.type === "text" ? text().find((t) => t.id === sel.id) : null;
}

function renderInspector() {
  const tx = selectedText();
  if (!tx) {
    $inspector.hidden = true;
    return;
  }
  $inspector.hidden = false;
  $inspector.innerHTML = "";
  const field = (label, node, full) => {
    const l = document.createElement("label");
    l.textContent = label;
    if (full) {
      node.classList.add("full");
      $inspector.append(node);
    } else {
      $inspector.append(l, node);
    }
  };
  const input = (val, on, type = "text") => {
    const el = document.createElement("input");
    el.type = type;
    el.value = val;
    el.addEventListener("input", () => {
      on(type === "number" ? parseFloat(el.value) : el.value);
      scheduleVideoSave();
      renderTimeline();
      renderOverlay();
    });
    return el;
  };
  const txt = input(tx.text || "", (v) => (tx.text = v));
  field("Text", txt, true);

  const animSel = document.createElement("select");
  for (const a of ["none", "fade", "slide", "words", "typewriter"]) {
    const o = document.createElement("option");
    o.value = a;
    o.textContent = a;
    if ((tx.anim || "none") === a) o.selected = true;
    animSel.append(o);
  }
  animSel.addEventListener("change", () => {
    tx.anim = animSel.value;
    scheduleVideoSave();
    renderOverlay();
  });
  field("Animation", animSel);

  const fromSel = document.createElement("select");
  for (const d of ["bottom", "top", "left", "right"]) {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = d;
    if ((tx.from || "bottom") === d) o.selected = true;
    fromSel.append(o);
  }
  fromSel.addEventListener("change", () => {
    tx.from = fromSel.value;
    scheduleVideoSave();
    renderOverlay();
  });
  field("From", fromSel);

  field("X", input(tx.x ?? 0.5, (v) => (tx.x = v), "number"));
  field("Y", input(tx.y ?? 0.85, (v) => (tx.y = v), "number"));
  field("Size", input(tx.size ?? 0.06, (v) => (tx.size = v), "number"));
  field("Color", input(tx.color || "#ffffff", (v) => (tx.color = v), "color"));

  const del = document.createElement("button");
  del.className = "del";
  del.textContent = "Delete text layer";
  del.addEventListener("click", () => {
    doc.text = text().filter((t) => t.id !== tx.id);
    sel = null;
    scheduleVideoSave();
    render();
  });
  $inspector.append(del);
}

$addtext.addEventListener("click", () => {
  const total = totalDur();
  const start = Math.min(playhead, Math.max(0, total - 2));
  const tx = {
    id: "t" + Math.random().toString(36).slice(2, 8),
    kind: "title",
    text: "Text",
    start,
    end: Math.min(total, start + 2),
    x: 0.5,
    y: 0.85,
    size: 0.06,
    color: "#ffffff",
    bg: "#00000055",
    font: "Futura",
    anim: "fade",
    from: "bottom",
  };
  text().push(tx);
  scheduleVideoSave();
  selectText(tx);
  renderOverlay();
});

window.addEventListener("resize", () => {
  positionPlayhead();
  renderOverlay();
});

// ── Clip add / remove ───────────────────────────────────────────────────────
async function populateAddMenu() {
  let media = [];
  try {
    media = await invoke("list_media", { path: projectPath });
  } catch {}
  const vids = media.filter((m) => m.kind === "video");
  $addsel.innerHTML = '<option value="">+ Add clip…</option>';
  // Always offer a native picker to import a clip from anywhere (Photos export,
  // Desktop, Downloads…). It's copied into the project's media/ folder.
  const browse = document.createElement("option");
  browse.value = "__browse__";
  browse.textContent = "Browse…";
  $addsel.append(browse);
  if (vids.length) {
    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "—— in this project ——";
    $addsel.append(sep);
  }
  for (const v of vids) {
    const opt = document.createElement("option");
    opt.value = v.path;
    opt.textContent = v.name;
    $addsel.append(opt);
  }
}

async function browseForClip() {
  if (!dialog || !dialog.open) {
    toast("File picker unavailable.");
    return null;
  }
  const picked = await dialog.open({
    multiple: false,
    filters: [{ name: "Video", extensions: ["mov", "mp4", "m4v", "webm", "avi", "mkv"] }],
  });
  if (!picked) return null;
  try {
    const dest = await invoke("import_clip", { projectPath, file: picked });
    await populateAddMenu();
    return dest;
  } catch (e) {
    toast(String(e));
    return null;
  }
}

$addsel.addEventListener("change", async () => {
  let abs = $addsel.value;
  $addsel.value = "";
  if (!abs) return;
  if (abs === "__browse__") {
    abs = await browseForClip();
    if (!abs) return;
  }
  // Probe duration so a new clip spans the whole file by default. `srcDur` is
  // kept so trim handles can clamp without re-probing.
  const dur = await probeDuration(abs);
  clips().push({
    id: "c" + Math.random().toString(36).slice(2, 8),
    src: relSrc(abs),
    in: 0,
    out: dur,
    srcDur: dur,
    volume: 1,
  });
  activeIdx = clips().length - 1;
  scheduleVideoSave();
  render();
});

function probeDuration(abs) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = convertFileSrc(abs);
    v.addEventListener("loadedmetadata", () => resolve(v.duration || 0), { once: true });
    v.addEventListener("error", () => resolve(0), { once: true });
  });
}

function removeClip(i) {
  clips().splice(i, 1);
  if (activeIdx >= clips().length) activeIdx = Math.max(0, clips().length - 1);
  if (sel?.type === "clip") sel = null;
  scheduleVideoSave();
  render();
}

// Delete/Backspace removes the selected clip or text layer (unless typing).
window.addEventListener("keydown", (e) => {
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (!sel) return;
  e.preventDefault();
  if (sel.type === "clip") {
    const i = clips().findIndex((c) => c.id === sel.id);
    if (i >= 0) removeClip(i);
  } else {
    doc.text = text().filter((t) => t.id !== sel.id);
    sel = null;
    scheduleVideoSave();
    render();
  }
});

// ── Toast ───────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove("show"), 2400);
}

// ── Live reload (Claude Code edits files under videos/ on disk) ─────────────
// Two triggers: the global `fs-changed` event (live, while focused elsewhere)
// and window focus (reliable belt-and-suspenders, like the Git window). Both
// re-list the edits and reload the current doc.
async function liveRefresh() {
  if (writingSelf) return;
  await refreshEditList();
  if (currentFile && edits.some((e) => e.file === currentFile)) {
    await openEdit(currentFile);
  } else {
    await ensureAnEdit();
  }
}
listen("fs-changed", liveRefresh);
window.addEventListener("focus", liveRefresh);

async function init() {
  await populateAddMenu();
  await refreshEditList();
  await ensureAnEdit();
}
init();
