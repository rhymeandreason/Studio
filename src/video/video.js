// Video editor window. The whole edit is `<project>/videos/<edit>.json`,
// shared live with Claude Code: we save (debounced) on every change and reload
// when the file genuinely changes on disk (`fs-changed` / focus / the refresh
// button). Text animations live in effects.js, shader backgrounds in
// shaders.js — both are used verbatim by the export pipeline, which renders
// overlay frames in this webview and hands them to the native compositor.
// See docs/video.md.
import { initDevInspect } from "../devinspect.js";
import { TEXT_EFFECTS, drawCaption, clearCaptionCache } from "./effects.js";
import { SHADERS, shaderDefaults, createShaderRenderer } from "./shaders.js";
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
const $refresh = document.getElementById("refresh");
const $stage = document.getElementById("stage");
const $frame = document.getElementById("frame");
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
const $shaderCv = document.getElementById("shaderCv");
const previewShader = createShaderRenderer($shaderCv);

// Size the preview frame to the export aspect ratio, fit within the stage.
// (Sized explicitly in px — a flex item with only aspect-ratio and absolutely
// positioned children collapses to 0.)
function setFrameAspect() {
  const d = presetDims();
  const SW = $stage.clientWidth || 1;
  const SH = $stage.clientHeight || 1;
  const scale = Math.min(SW / d.w, SH / d.h);
  $frame.style.width = Math.max(1, Math.floor(d.w * scale)) + "px";
  $frame.style.height = Math.max(1, Math.floor(d.h * scale)) + "px";
}

// Size + rotate a video element so its clip fits the frame (contain), matching
// the exporter. Rotation swaps the fitted footprint for 90°/270°.
function applyVidTransform(el) {
  const idx = parseInt(el.dataset.clip);
  const c = clips()[idx];
  const r = (((c?.rotate || 0) % 360) + 360) % 360;
  const FW = $frame.clientWidth || 1;
  const FH = $frame.clientHeight || 1;
  const vw = el.videoWidth || 16;
  const vh = el.videoHeight || 9;
  const aspect = vw / vh;
  let w;
  if (r === 90 || r === 270) {
    w = Math.min(FH, FW * aspect); // footprint is rotated 90°
  } else {
    w = Math.min(FW, FH * aspect);
  }
  el.style.width = w + "px";
  el.style.height = w / aspect + "px";
  el.style.transform = `translate(-50%, -50%) rotate(${r}deg)`;
}
const $play = document.getElementById("play");
const $time = document.getElementById("time");
const $addsel = document.getElementById("addsel");
const $addtext = document.getElementById("addtext");
const $preset = document.getElementById("preset");
const $export = document.getElementById("export");
const $overlay = document.getElementById("overlay");
const $timeline = document.getElementById("timeline");
const $clipLane = document.getElementById("clipLane");
const $textLane = document.getElementById("textLane");
const $playhead = document.getElementById("playhead");
const $inspector = document.getElementById("inspector");
const $toast = document.getElementById("toast");

$project.append(projectName);
$project.title = projectPath;
document.title = `Video — ${projectName}`;

let doc = { version: 1, preset: "youtube", hdr: "sdr", clips: [], text: [] };
let currentFile = null; // basename of the open edit under videos/
let edits = []; // [{ file, name, modified }]
let activeIdx = 0; // which timeline segment is current
let playhead = 0; // global timeline position, seconds
let sel = null; // current selection: { type:"clip"|"text", id }
let dragging = false; // suppress scrub during block drag/trim

// ── Persistence ────────────────────────────────────────────────────────────
// `lastPersisted` is the JSON of the doc as it exists ON DISK (last read or
// written). Live reloads compare against it, so our own write echo — and any
// fs-changed for an unrelated file — never clobbers the UI. While an edit is
// pending (dirty / debounce timer armed), auto-reload is skipped entirely:
// the local doc is the newer truth and is about to be written.
let saveTimer = null;
let dirty = false;
function scheduleVideoSave() {
  if (!currentFile) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave();
  }, 400);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!currentFile || !dirty) return;
  try {
    await invoke("write_video", { path: projectPath, file: currentFile, doc });
    lastPersisted = JSON.stringify(doc);
    dirty = false;
  } catch (e) {
    toast(String(e));
  }
}
let lastPersisted = "";

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
    dirty = false;
    await refreshEditList();
    if (edits.length) await openEdit(edits[0].file);
    else await ensureAnEdit();
  } catch (e) {
    toast(String(e));
  }
});

// Explicit reload — for pulling in edits made directly to the file. Discards
// any not-yet-saved local change by design (it's the "reload from file" button).
$refresh.addEventListener("click", async () => {
  if (!currentFile) return;
  dirty = false;
  clearTimeout(saveTimer);
  saveTimer = null;
  await refreshEditList();
  await openEdit(currentFile, { keepPosition: true });
  toast("Reloaded from file");
});

// Normalize a freshly-read doc in place (defaults + legacy migrations).
function normalizeDoc(d) {
  if (!d.clips) d.clips = [];
  if (!d.text) d.text = [];
  for (const c of d.clips) {
    if (isShader(c) && !c.params) c.params = shaderDefaults(c.effect);
  }
  // Migrate legacy height-fraction sizes (≤ 1) to output pixels.
  for (const l of d.text) {
    if ((l.size ?? 0) > 0 && l.size <= 1) l.size = Math.round(l.size * presetDims().h);
  }
}

async function openEdit(file, { keepPosition = false } = {}) {
  currentFile = file;
  try {
    doc = await invoke("read_video", { path: projectPath, file });
  } catch (e) {
    toast(String(e));
    return;
  }
  lastPersisted = JSON.stringify(doc);
  dirty = false;
  normalizeDoc(doc);
  clearCaptionCache();
  if (keepPosition) {
    playhead = Math.min(playhead, totalDur());
    if (sel) {
      const pool = sel.type === "clip" ? clips() : text();
      if (!pool.some((x) => x.id === sel.id)) sel = null;
    }
    activeIdx = segAt(playhead)?.idx ?? 0;
  } else {
    activeIdx = 0;
    playhead = 0;
    sel = null;
    timelineSpan = 0; // fresh doc → fit the timeline to its content again
  }
  setPlaying(false);
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
const isShader = (c) => c?.kind === "shader";
const clipDur = (c) =>
  isShader(c) ? Math.max(0.1, c.dur ?? 5) : Math.max(0, (c.out ?? 0) - (c.in ?? 0));

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

// The timeline's visible span: grows with content but never auto-shrinks
// while editing (trimming a clip shouldn't rescale everything under your
// cursor). Resets when an edit is opened fresh.
let timelineSpan = 0;
function span() {
  timelineSpan = Math.max(timelineSpan, totalDur());
  return timelineSpan || 1;
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

// Which segment a global time falls in (+ the source time for video clips).
function segAt(t) {
  const segs = layout();
  for (let i = 0; i < segs.length; i++) {
    if (t < segs[i].end || i === segs.length - 1) {
      return { idx: i, seg: segs[i], src: (clips()[i].in ?? 0) + (t - segs[i].start) };
    }
  }
  return null;
}

function render() {
  const has = clips().length > 0;
  $play.disabled = !has;
  $placeholder.hidden = has;
  $addtext.disabled = !has;
  $frame.style.display = has ? "" : "none";
  for (const el of els) el.style.display = has ? "" : "none";
  if (has) {
    if (activeIdx >= clips().length) activeIdx = 0;
    enterSegment(activeIdx, false);
  } else {
    for (const el of els) {
      el.removeAttribute("src");
      el.dataset.src = "";
      el.dataset.clip = "";
    }
    $shaderCv.classList.remove("active");
  }
  $preset.value = doc.preset || "youtube";
  setFrameAspect();
  for (const el of els) if (el.readyState >= 1) applyVidTransform(el);
  renderTimeline();
  renderOverlay();
  updateTime();
  renderInspector();
}

// ── Timeline rendering ──────────────────────────────────────────────────────
function renderTimeline() {
  const total = span();
  const segs = layout();
  $clipLane.innerHTML = "";
  segs.forEach((s, i) => {
    const c = clips()[i];
    const b = document.createElement("div");
    b.className =
      "block" +
      (isShader(c) ? " block--shader" : "") +
      (sel?.type === "clip" && sel.id === c.id ? " sel" : "");
    b.style.left = (s.start / total) * 100 + "%";
    b.style.width = (s.dur / total) * 100 + "%";
    const label = document.createElement("span");
    label.className = "label";
    if (isShader(c)) {
      const mi = document.createElement("span");
      mi.className = "mi";
      mi.textContent = "blur_on";
      label.append(mi, SHADERS[c.effect]?.label || c.effect);
    } else {
      label.textContent = c.src.split("/").pop();
    }
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
  const total = span();
  const pad = 6; // .timeline padding
  const w = $timeline.clientWidth - pad * 2;
  $playhead.style.left = pad + (playhead / total) * w + "px";
}

// ── Overlay (captions) — drawn by effects.js, shared with export ────────────
// Font size in OUTPUT pixels. Values ≤ 1 are treated as legacy height-fractions.
function fontPxOutput(l) {
  const s = l.size ?? 72;
  return s <= 1 ? s * presetDims().h : s;
}

function renderOverlay() {
  const ctx = $overlay.getContext("2d");
  const FW = Math.max(1, Math.round($frame.clientWidth));
  const FH = Math.max(1, Math.round($frame.clientHeight));
  if ($overlay.width !== FW) $overlay.width = FW;
  if ($overlay.height !== FH) $overlay.height = FH;
  ctx.clearRect(0, 0, FW, FH);
  const scale = FH / presetDims().h; // output px → preview px
  for (const l of text()) {
    const s = l.start ?? 0;
    const e = l.end ?? 0;
    if (playhead < s || playhead > e) continue;
    drawCaption(ctx, l, playhead - s, e - s, FW, FH, fontPxOutput(l) * scale);
  }
}

// ── Playback ────────────────────────────────────────────────────────────────
// One master clock: in a video segment the active <video> element drives the
// playhead (frame-accurate); in a shader segment there is no media clock, so
// the rAF loop advances the playhead by wall time and renders the shader.
let playing = false;
let rafId = null;
let lastTick = 0;

function setPlaying(v) {
  if (playing === v) return;
  playing = v;
  $play.innerHTML = `<span class="mi">${v ? "pause" : "play_arrow"}</span>`;
  const c = clips()[activeIdx];
  if (v) {
    lastTick = performance.now();
    if (c && !isShader(c)) activeVid().play();
    if (!rafId) rafId = requestAnimationFrame(tick);
  } else {
    activeVid().pause();
  }
}

function tick(ts) {
  if (!playing) {
    rafId = null;
    return;
  }
  const c = clips()[activeIdx];
  if (!c) {
    setPlaying(false);
    rafId = null;
    return;
  }
  if (isShader(c)) {
    playhead += (ts - lastTick) / 1000;
    const seg = layout()[activeIdx];
    if (seg && playhead >= seg.end) advance();
    else renderShaderFrame();
  } else {
    syncFromVideo();
  }
  lastTick = ts;
  positionPlayhead();
  renderOverlay();
  updateTime();
  rafId = playing ? requestAnimationFrame(tick) : null;
}

// Render the current shader segment's frame into the preview canvas.
function renderShaderFrame() {
  const c = clips()[activeIdx];
  if (!isShader(c) || !previewShader) return;
  const seg = layout()[activeIdx];
  const local = Math.max(0, playhead - (seg?.start ?? 0));
  const FW = Math.max(1, Math.round($frame.clientWidth));
  const FH = Math.max(1, Math.round($frame.clientHeight));
  previewShader.render(c.effect, c.params, local, FW, FH);
}

// Load clip `idx` into a given element and (optionally) seek to its in-point.
function loadInto(el, idx, { play = false } = {}) {
  const c = clips()[idx];
  if (!c || isShader(c)) return;
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

// Preload the next VIDEO clip after `idx` into the standby element (paused,
// pre-seeked) — shader segments between need no preload.
function preloadNext(idx) {
  const n = clips().findIndex((c, j) => j > idx && !isShader(c));
  if (n >= 0) loadInto(standbyVid(), n, { play: false });
}

// Make segment `i` current (used for scrub/select/initial load/boundaries).
function enterSegment(i, keepPlaying) {
  activeIdx = i;
  const c = clips()[i];
  if (!c) return;
  if (isShader(c)) {
    activeVid().pause();
    for (const el of els) el.classList.remove("active");
    $shaderCv.classList.add("active");
    renderShaderFrame();
  } else {
    $shaderCv.classList.remove("active");
    loadInto(activeVid(), i, { play: keepPlaying });
    showActive();
  }
  preloadNext(i);
}

// Move to the next segment at a boundary. Video→video swaps to the preloaded
// standby element so no black frame shows.
function advance() {
  const next = activeIdx + 1;
  if (next >= clips().length) {
    playhead = totalDur();
    setPlaying(false);
    return;
  }
  const c = clips()[next];
  playhead = layout()[next].start;
  if (isShader(c)) {
    activeVid().pause();
    activeIdx = next;
    for (const el of els) el.classList.remove("active");
    $shaderCv.classList.add("active");
    renderShaderFrame();
    preloadNext(next);
  } else {
    $shaderCv.classList.remove("active");
    const sb = standbyVid();
    if (parseInt(sb.dataset.clip) !== next) loadInto(sb, next, { play: false });
    activeVid().pause();
    curEl ^= 1; // standby becomes active
    activeIdx = next;
    showActive();
    if (playing) activeVid().play();
    preloadNext(next); // preload the next video into the now-standby element
  }
}

// Read the active video's clock; advance at the clip's out-point.
function syncFromVideo() {
  let c = clips()[activeIdx];
  if (!c) return;
  const v = activeVid();
  if (v.currentTime >= (c.out ?? v.duration)) {
    advance();
    c = clips()[activeIdx];
    if (!c || isShader(c)) return;
  }
  const seg = layout()[activeIdx];
  if (seg) playhead = seg.start + Math.max(0, activeVid().currentTime - (c.in ?? 0));
}

// Seek the whole timeline to a global time.
function seekGlobal(t) {
  const total = totalDur();
  playhead = Math.max(0, Math.min(total, t));
  const m = segAt(playhead);
  if (!m) return;
  if (m.idx !== activeIdx) enterSegment(m.idx, playing);
  const c = clips()[m.idx];
  if (isShader(c)) {
    renderShaderFrame();
  } else {
    const v = activeVid();
    if (v.readyState >= 1) {
      try {
        v.currentTime = m.src;
      } catch {}
    }
  }
  positionPlayhead();
  renderOverlay();
  updateTime();
}

for (const el of els) {
  el.addEventListener("loadedmetadata", () => applyVidTransform(el));
}

$play.addEventListener("click", () => {
  if (!playing && playhead >= totalDur() - 0.01) seekGlobal(0); // replay from the top
  setPlaying(!playing);
});
window.addEventListener("keydown", (e) => {
  if (e.key !== " ") return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  e.preventDefault();
  if (!$play.disabled) $play.click();
});

function updateTime() {
  $time.textContent = `${fmt(playhead)} / ${fmt(totalDur())}`;
}

// ── Timeline interactions: scrub, trim, reorder, text move/resize ───────────
function timeAtX(clientX) {
  const r = $timeline.getBoundingClientRect();
  const pad = 6;
  const w = r.width - pad * 2;
  const frac = Math.max(0, Math.min(1, (clientX - r.left - pad) / w));
  return frac * span(); // seekGlobal clamps to the actual content length
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
  return (r.width - 12) / span();
}

function startTrim(e, i, edge) {
  e.stopPropagation();
  e.preventDefault();
  const c = clips()[i];
  const startX = e.clientX;
  const pps = pxPerSecond();
  selectClip(c);
  if (isShader(c)) {
    // Both handles just resize a generator clip (duration is its only length).
    const orig = clipDur(c);
    const sign = edge === "in" ? -1 : 1;
    const move = (ev) => {
      c.dur = Math.max(0.5, orig + (sign * (ev.clientX - startX)) / pps);
      renderTimeline();
      updateTime();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      scheduleVideoSave();
      seekGlobal(layout()[i]?.start ?? 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return;
  }
  const orig = edge === "in" ? c.in ?? 0 : c.out ?? 0;
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
  if (isShader(c)) return;
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
    const total = span(); // blocks are laid out against the span
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

function selectedClip() {
  return sel?.type === "clip" ? clips().find((c) => c.id === sel.id) : null;
}

// Inspector field helpers — kit-styled controls wired to save + re-render.
function inspectorField(label, node, full) {
  if (full) {
    node.classList.add("full");
    $inspector.append(node);
  } else {
    const l = document.createElement("label");
    l.textContent = label;
    $inspector.append(l, node);
  }
}
function fieldInput(val, on, type = "text", attrs = {}) {
  const el = document.createElement("input");
  el.className = "field";
  el.type = type;
  Object.assign(el, attrs);
  el.value = val;
  el.addEventListener("input", () => {
    on(type === "number" ? parseFloat(el.value) : el.value);
    scheduleVideoSave();
    renderTimeline();
    renderOverlay();
  });
  return el;
}
function fieldColor(val, on) {
  const el = document.createElement("studio-color");
  el.setAttribute("value", val);
  el.addEventListener("input", () => {
    on(el.value);
    scheduleVideoSave();
    renderOverlay();
    renderShaderFrame();
  });
  return el;
}
function fieldSelect(options, current, on) {
  const s = document.createElement("select");
  s.className = "field";
  for (const [value, label] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    if (value === current) o.selected = true;
    s.append(o);
  }
  s.addEventListener("change", () => on(s.value));
  return s;
}

function renderVideoClipInspector(clip) {
  const name = document.createElement("label");
  name.textContent = clip.src.split("/").pop();
  name.className = "full";
  $inspector.append(name);

  const row = document.createElement("div");
  row.className = "row";
  const setRotate = (deg) => {
    clip.rotate = ((deg % 360) + 360) % 360;
    scheduleVideoSave();
    applyVidTransform(activeVid());
    renderOverlay();
    renderInspector();
  };
  const mkRot = (icon, title, delta) => {
    const b = document.createElement("button");
    b.className = "btn btn-icon";
    b.title = title;
    b.innerHTML = `<span class="mi">${icon}</span>`;
    b.addEventListener("click", () => setRotate((clip.rotate || 0) + delta));
    return b;
  };
  const cur = document.createElement("span");
  cur.className = "text-xs";
  cur.textContent = `${clip.rotate || 0}°`;
  row.append(mkRot("rotate_left", "Rotate counter-clockwise", -90), mkRot("rotate_right", "Rotate clockwise", 90), cur);
  inspectorField("Rotate", row);
}

function renderShaderClipInspector(clip) {
  const def = SHADERS[clip.effect];
  inspectorField(
    "Background",
    fieldSelect(
      Object.entries(SHADERS).map(([id, d]) => [id, d.label]),
      clip.effect,
      (v) => {
        clip.effect = v;
        clip.params = { ...shaderDefaults(v), ...clip.params };
        scheduleVideoSave();
        renderTimeline();
        renderShaderFrame();
        renderInspector();
      }
    )
  );
  inspectorField(
    "Duration (s)",
    fieldInput(clipDur(clip), (v) => (clip.dur = Math.max(0.5, v || 0.5)), "number", {
      min: 0.5,
      step: 0.5,
    })
  );
  if (!def) return;
  if (!clip.params) clip.params = shaderDefaults(clip.effect);
  for (const p of def.params) {
    const cur = clip.params[p.key] ?? p.default;
    if (p.type === "color") {
      inspectorField(p.label, fieldColor(cur, (v) => (clip.params[p.key] = v)));
    } else {
      const input = fieldInput(cur, (v) => (clip.params[p.key] = v), "number", {
        min: p.min ?? 0,
        max: p.max ?? 10,
        step: p.step ?? 0.1,
      });
      input.addEventListener("input", renderShaderFrame);
      inspectorField(p.label, input);
    }
  }
}

function renderInspector() {
  $inspector.innerHTML = "";
  const clip = selectedClip();
  if (clip) {
    if (isShader(clip)) renderShaderClipInspector(clip);
    else renderVideoClipInspector(clip);
    appendDeleteButton(() => {
      const i = clips().findIndex((c) => c.id === clip.id);
      if (i >= 0) removeClip(i);
    }, "Delete clip");
    return;
  }
  const tx = selectedText();
  if (!tx) {
    const hint = document.createElement("div");
    hint.className = "inspector__hint";
    hint.textContent = "Select a clip or text layer to edit it.";
    $inspector.append(hint);
    return;
  }

  inspectorField("Text", fieldInput(tx.text || "", (v) => (tx.text = v)), true);

  inspectorField(
    "Animation",
    fieldSelect(
      Object.entries(TEXT_EFFECTS).map(([id, e]) => [id, e.label]),
      tx.anim || "none",
      (v) => {
        tx.anim = v;
        scheduleVideoSave();
        renderOverlay();
        renderInspector(); // effect-specific fields (from / highlight)
      }
    )
  );

  if ((tx.anim || "none") === "slide") {
    inspectorField(
      "From",
      fieldSelect(
        ["bottom", "top", "left", "right"].map((d) => [d, d]),
        tx.from || "bottom",
        (v) => {
          tx.from = v;
          scheduleVideoSave();
          renderOverlay();
        }
      )
    );
  }
  if (tx.anim === "karaoke") {
    inspectorField("Highlight", fieldColor(tx.hi || "#ffd23f", (v) => (tx.hi = v)));
  }

  inspectorField("X", fieldInput(tx.x ?? 0.5, (v) => (tx.x = v), "number", { step: 0.01 }));
  inspectorField("Y", fieldInput(tx.y ?? 0.85, (v) => (tx.y = v), "number", { step: 0.01 }));
  inspectorField(
    "Size (px)",
    fieldInput(Math.round(fontPxOutput(tx)), (v) => (tx.size = v), "number", { min: 8 })
  );
  inspectorField("Color", fieldColor(tx.color || "#ffffff", (v) => (tx.color = v)));

  appendDeleteButton(() => {
    doc.text = text().filter((t) => t.id !== tx.id);
    sel = null;
    scheduleVideoSave();
    render();
  }, "Delete text layer");
}

function appendDeleteButton(onDelete, label) {
  const del = document.createElement("button");
  del.className = "btn btn-ghost full";
  del.style.justifySelf = "start";
  del.innerHTML = `<span class="mi mi-sm">delete</span>${label}`;
  del.addEventListener("click", onDelete);
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
    size: Math.round(presetDims().h * 0.06),
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
  setFrameAspect();
  for (const el of els) if (el.readyState >= 1) applyVidTransform(el);
  renderShaderFrame();
  renderOverlay();
});

// ── Export ──────────────────────────────────────────────────────────────────
$preset.addEventListener("change", () => {
  doc.preset = $preset.value;
  scheduleVideoSave();
  setFrameAspect();
  renderShaderFrame();
  renderOverlay();
});

// Render dimensions for each preset. "web" follows the first clip's source
// size (even dimensions, H.264 needs them).
function presetDims() {
  switch (doc.preset) {
    case "reels": return { w: 1080, h: 1920 };
    case "square": return { w: 1080, h: 1080 };
    case "web": {
      const v = activeVid();
      let w = v.videoWidth || 1920;
      let h = v.videoHeight || 1080;
      return { w: w - (w % 2), h: h - (h % 2) };
    }
    default: return { w: 1920, h: 1080 }; // youtube
  }
}

const EXPORT_FPS = 30;

// Render the overlay frame sequence at output resolution: shader-clip pixels
// (opaque) + text layers (transparent elsewhere), drawn by the SAME effects.js
// / shaders.js code as the preview — so the baked result matches exactly.
// Frames with nothing on them are skipped (the compositor treats missing
// frames as fully transparent).
async function renderOverlayFrames(dir, dims, onProgress) {
  const total = totalDur();
  const count = Math.ceil(total * EXPORT_FPS);
  const cv = document.createElement("canvas");
  cv.width = dims.w;
  cv.height = dims.h;
  const ctx = cv.getContext("2d");
  const shader = createShaderRenderer();
  const segs = layout();
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / EXPORT_FPS;
    ctx.clearRect(0, 0, dims.w, dims.h);
    let drew = false;
    const seg = segs.find((s) => t >= s.start && t < s.end);
    if (seg && isShader(seg.c) && shader) {
      const out = shader.render(seg.c.effect, seg.c.params, t - seg.start, dims.w, dims.h);
      if (out) {
        ctx.drawImage(out, 0, 0);
        drew = true;
      }
    }
    for (const l of text()) {
      const s = l.start ?? 0;
      const e = l.end ?? 0;
      if (t < s || t > e) continue;
      drawCaption(ctx, l, t - s, e - s, dims.w, dims.h, fontPxOutput(l));
      drew = true;
    }
    if (drew) {
      await invoke("save_export_frame", { dir, idx: i, data: cv.toDataURL("image/png") });
    }
    if (i % 15 === 0) {
      onProgress(i / count);
      await new Promise((r) => requestAnimationFrame(r)); // keep the UI alive
    }
  }
  return count;
}

function buildSpec(framesDir) {
  const d = presetDims();
  return {
    width: d.w,
    height: d.h,
    fit: doc.fit || "contain",
    fps: EXPORT_FPS,
    framesDir,
    clips: clips().map((c) =>
      isShader(c)
        ? { kind: "gap", dur: clipDur(c) }
        : {
            kind: "video",
            src: absSrc(c.src),
            in: c.in ?? 0,
            out: c.out ?? 0,
            rotate: c.rotate || 0,
          }
    ),
  };
}

let exporting = false;
listen("video-export-progress", (e) => {
  if (!exporting) return;
  const pct = Math.round((e.payload || 0) * 100);
  $export.textContent = `Exporting ${pct}%`;
});

$export.addEventListener("click", async () => {
  if (exporting) return;
  if (clips().length === 0) {
    toast("Add a clip first.");
    return;
  }
  const cur = edits.find((e) => e.file === currentFile);
  const base = (cur ? cur.name : "video").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "");
  let dst;
  try {
    dst = await dialog.save({
      defaultPath: `${base || "video"}.mp4`,
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
  } catch (e) {
    toast("Save dialog failed: " + e);
    return;
  }
  if (!dst) return;

  // Flush any pending edit so the export matches what's on screen.
  await flushSave();

  exporting = true;
  $export.disabled = true;
  const exportLabel = $export.innerHTML;
  setPlaying(false);
  try {
    const dims = presetDims();
    const framesDir = await invoke("create_export_frames_dir");
    await renderOverlayFrames(framesDir, dims, (p) => {
      $export.textContent = `Rendering ${Math.round(p * 100)}%`;
    });
    $export.textContent = "Exporting…";
    await invoke("export_video", { spec: buildSpec(framesDir), dst });
    toast("Exported ✓ — revealed in Finder");
  } catch (e) {
    toast("Export failed: " + e);
  } finally {
    exporting = false;
    $export.disabled = false;
    $export.innerHTML = exportLabel;
  }
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
  // Shader generator clips — animated backgrounds, no source file.
  const sep = document.createElement("option");
  sep.disabled = true;
  sep.textContent = "—— backgrounds ——";
  $addsel.append(sep);
  for (const [id, def] of Object.entries(SHADERS)) {
    const opt = document.createElement("option");
    opt.value = "__shader__:" + id;
    opt.textContent = def.label;
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
  if (abs.startsWith("__shader__:")) {
    const effect = abs.slice("__shader__:".length);
    const c = {
      id: "c" + Math.random().toString(36).slice(2, 8),
      kind: "shader",
      effect,
      params: shaderDefaults(effect),
      dur: 5,
    };
    clips().push(c);
    activeIdx = clips().length - 1;
    scheduleVideoSave();
    render();
    selectClip(c);
    return;
  }
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
// Triggered by the global `fs-changed` event and window focus. Reloads ONLY
// when the file's content actually differs from what we last read/wrote —
// never while a local edit is pending — so UI edits can't be clobbered by our
// own write echo or by unrelated project file changes. The titlebar refresh
// button force-reloads regardless.
async function liveRefresh() {
  if (dirty || saveTimer || exporting) return; // local edits win; save is imminent
  await refreshEditList();
  if (!currentFile || !edits.some((e) => e.file === currentFile)) {
    await ensureAnEdit();
    return;
  }
  let fresh;
  try {
    fresh = await invoke("read_video", { path: projectPath, file: currentFile });
  } catch {
    return;
  }
  if (dirty || saveTimer) return; // an edit landed while we were reading
  const s = JSON.stringify(fresh);
  if (s === lastPersisted) return; // no real change (e.g. our own write echo)
  await openEdit(currentFile, { keepPosition: true });
}
listen("fs-changed", liveRefresh);
window.addEventListener("focus", liveRefresh);

// Jump to a specific edit (Artifacts-panel card → already-open window).
listen("video-open-edit", async (e) => {
  const f = e.payload;
  await refreshEditList();
  if (f && edits.some((x) => x.file === f)) await openEdit(f);
});

async function init() {
  await populateAddMenu();
  await refreshEditList();
  const wanted = params.get("file");
  if (wanted && edits.some((e) => e.file === wanted)) await openEdit(wanted);
  else await ensureAnEdit();
}
init();
