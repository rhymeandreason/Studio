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
const $video = document.getElementById("video");
const $play = document.getElementById("play");
const $time = document.getElementById("time");
const $addsel = document.getElementById("addsel");
const $clips = document.getElementById("clips");
const $toast = document.getElementById("toast");

$project.textContent = projectName;
$project.title = projectPath;
document.title = `Video — ${projectName}`;

let doc = { version: 1, preset: "youtube", hdr: "sdr", clips: [], text: [] };
let currentFile = null; // basename of the open edit under videos/
let edits = []; // [{ file, name, modified }]
let activeIdx = 0; // which clip is loaded into the <video> element

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

function renderClips() {
  $clips.innerHTML = "";
  if (clips().length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No clips. Use “+ Add clip…” to start.";
    $clips.append(e);
    return;
  }
  clips().forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "clip" + (i === activeIdx ? " active" : "");
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = i + 1;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.src.split("/").pop();
    name.title = c.src;
    const dur = document.createElement("span");
    dur.className = "dur";
    dur.textContent = fmt(clipDur(c));
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Remove clip";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      removeClip(i);
    });
    row.append(idx, name, dur, x);
    row.addEventListener("click", () => loadClip(i));
    $clips.append(row);
  });
}

function render() {
  renderClips();
  const has = clips().length > 0;
  $play.disabled = !has;
  $placeholder.hidden = has;
  $video.hidden = !has;
  if (has) {
    if (activeIdx >= clips().length) activeIdx = 0;
    loadClip(activeIdx);
  } else {
    $video.removeAttribute("src");
  }
  updateTime();
}

// ── Playback (single <video>, swap src per clip) ────────────────────────────
function loadClip(i) {
  activeIdx = i;
  const c = clips()[i];
  if (!c) return;
  const url = convertFileSrc(absSrc(c.src));
  if ($video.dataset.src !== url) {
    $video.dataset.src = url;
    $video.src = url;
  }
  const seekTo = () => {
    $video.currentTime = c.in ?? 0;
    $video.removeEventListener("loadedmetadata", seekTo);
  };
  if ($video.readyState >= 1) $video.currentTime = c.in ?? 0;
  else $video.addEventListener("loadedmetadata", seekTo);
  renderClips();
}

$play.addEventListener("click", () => {
  if ($video.paused) $video.play();
  else $video.pause();
});
$video.addEventListener("play", () => ($play.textContent = "❚❚ Pause"));
$video.addEventListener("pause", () => ($play.textContent = "▶︎ Play"));

// Advance to the next clip when the current clip reaches its out point.
$video.addEventListener("timeupdate", () => {
  const c = clips()[activeIdx];
  if (!c) return;
  if ($video.currentTime >= (c.out ?? $video.duration)) {
    if (activeIdx < clips().length - 1) {
      const wasPlaying = !$video.paused;
      loadClip(activeIdx + 1);
      if (wasPlaying) $video.play();
    } else {
      $video.pause();
    }
  }
  updateTime();
});

function updateTime() {
  const c = clips()[activeIdx];
  const within = c ? Math.max(0, ($video.currentTime || 0) - (c.in ?? 0)) : 0;
  const elapsedBefore = clips()
    .slice(0, activeIdx)
    .reduce((s, x) => s + clipDur(x), 0);
  $time.textContent = `${fmt(elapsedBefore + within)} / ${fmt(totalDur())}`;
}

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
  // Probe duration so a new clip spans the whole file by default.
  const dur = await probeDuration(abs);
  clips().push({
    id: "c" + Math.random().toString(36).slice(2, 8),
    src: relSrc(abs),
    in: 0,
    out: dur,
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
  scheduleVideoSave();
  render();
}

// ── Toast ───────────────────────────────────────────────────────────────────
let toastTimer;
function toast(text) {
  $toast.textContent = text;
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
