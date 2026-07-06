// Artifacts panel: lists a project's artifacts (brand kits, etc.), renders a
// preview per artifact, and opens them in their editor tool. See
// docs/artifacts.md. Claude authors artifacts into <project>/artifacts/; tools
// edit them; this panel is the human's gallery / launch surface.

import { state } from "./state.js";
import { el, mi } from "./dom.js";
import { createSelection } from "./selection.js";
import { renderDiagram } from "./diagram/render.js";
import { createShaderRenderer } from "./video/shaders.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;

// Selection — keyed by artifact path.
export const artifactsSelection = createSelection({
  mode: "multi",
  onChange: (sel) => {
    document.querySelectorAll(".artifact-card[data-path]").forEach((c) =>
      c.classList.toggle("is-selected", sel.has(c.dataset.path)),
    );
  },
});

export async function deleteArtifactsSelection() {
  const paths = artifactsSelection.get();
  if (!paths.length) return;
  artifactsSelection.clear();
  await Promise.all(paths.map((p) => invoke("delete_artifact", { path: p })));
  renderArtifacts();
}

export function clearArtifactsSelection() {
  artifactsSelection.clear();
}

// Editor tool per artifact kind (open-on-artifact via ?artifact=<path>).
const EDITOR = {
  "brand-kit": "brand-explorer.html",
  "presentation": "slides.html",
  "theme": "theme-editor.html",
  "diagram": "diagram.html",
};

const KIND_LABEL = {
  "brand-kit": "Brand kits",
  "presentation": "Presentations",
  "theme": "Themes",
  "diagram": "Diagrams",
};

let _renderGen = 0;
export async function renderArtifacts() {
  const gen = ++_renderGen;
  const root = document.getElementById("artifacts-panel");
  if (!root) return;
  root.innerHTML = "";

  const project = state.activeProject;
  if (!project) {
    root.appendChild(emptyMsg("No project active."));
    return;
  }

  // Toolbar.
  const toolbar = el("div", "toolbar");
  const newKitBtn = el("button", "btn-add", { type: "button" });
  newKitBtn.innerHTML = `<span class="mi mi-sm">add</span>Brand kit`;
  newKitBtn.addEventListener("click", () =>
    invoke("open_tool", { file: EDITOR["brand-kit"], query: null }),
  );
  toolbar.appendChild(newKitBtn);
  const newDeckBtn = el("button", "btn-add", { type: "button" });
  newDeckBtn.innerHTML = `<span class="mi mi-sm">add</span>Presentation`;
  newDeckBtn.addEventListener("click", () =>
    invoke("open_tool", { file: EDITOR["presentation"], query: null }),
  );
  toolbar.appendChild(newDeckBtn);
  const newThemeBtn = el("button", "btn-add", { type: "button" });
  newThemeBtn.innerHTML = `<span class="mi mi-sm">add</span>Theme`;
  newThemeBtn.addEventListener("click", () =>
    invoke("open_tool", { file: EDITOR["theme"], query: null }),
  );
  toolbar.appendChild(newThemeBtn);
  const newDiagramBtn = el("button", "btn-add", { type: "button" });
  newDiagramBtn.innerHTML = `<span class="mi mi-sm">add</span>Diagram`;
  newDiagramBtn.addEventListener("click", () =>
    invoke("open_tool", { file: EDITOR["diagram"], query: null }),
  );
  toolbar.appendChild(newDiagramBtn);
  const newVideoBtn = el("button", "btn-add", { type: "button" });
  newVideoBtn.innerHTML = `<span class="mi mi-sm">add</span>Video`;
  newVideoBtn.addEventListener("click", () =>
    invoke("open_video_window", { path: project.path, file: null }),
  );
  toolbar.appendChild(newVideoBtn);
  root.appendChild(toolbar);

  let items = [];
  try {
    items = await invoke("list_artifacts", { projectPath: project.path });
  } catch (err) {
    if (gen !== _renderGen) return;
    root.appendChild(emptyMsg("Couldn't read artifacts: " + err));
    return;
  }
  // Video edits (videos/*.json) aren't artifacts on disk, but they're the same
  // idea — Claude-writable design JSON with an editor — so they get a group too.
  let videos = [];
  try {
    videos = await invoke("list_videos", { path: project.path });
  } catch {}
  if (gen !== _renderGen) return;

  if (!items.length && !videos.length) {
    root.appendChild(
      emptyMsg(
        "No artifacts yet. Make one with “New brand kit”, or ask Studio Claude to generate some — it knows the format.",
      ),
    );
    return;
  }

  // Group by kind.
  const byKind = {};
  for (const it of items) (byKind[it.kind] ||= []).push(it);

  for (const [kind, group] of Object.entries(byKind)) {
    root.appendChild(
      el("div", "artifacts__kind", { textContent: KIND_LABEL[kind] || kind }),
    );
    const grid = el("div", "artifacts__grid");
    for (const it of group) grid.appendChild(artifactCard(it));
    root.appendChild(grid);
    // Click on empty grid space clears selection.
    grid.addEventListener("click", (e) => {
      if (e.target === grid) artifactsSelection.clear();
    });
  }

  if (videos.length) {
    root.appendChild(el("div", "artifacts__kind", { textContent: "Videos" }));
    const grid = el("div", "artifacts__grid");
    for (const v of videos) grid.appendChild(videoCard(project, v));
    root.appendChild(grid);
  }
}

// --- Video cards: videos/<edit>.json, opened in the Video window -------------
// Not part of the multi-select model (deletion lives in the Video window).
function videoCard(project, v) {
  const card = el("div", "artifact-card");
  const prev = el("div", "artifact__preview artifact__preview--video");
  prev.innerHTML = mi("movie"); // placeholder until the thumb loads
  card.appendChild(prev);

  const open = () =>
    invoke("open_video_window", { path: project.path, file: v.file });

  const foot = el("div", "artifact-card__foot");
  const info = el("div", "artifact-card__info");
  info.appendChild(el("span", "artifact-card__name", { textContent: v.name }));
  const meta = el("span", "artifact-card__meta");
  info.appendChild(meta);
  foot.appendChild(info);
  foot.appendChild(actionBtn("open_in_new", "Open", open, true));
  card.appendChild(foot);
  card.addEventListener("dblclick", open);

  fillVideoPreview(prev, meta, project, v);
  return card;
}

async function fillVideoPreview(prev, meta, project, v) {
  let data;
  try {
    data = await invoke("read_video", { path: project.path, file: v.file });
  } catch {
    return;
  }
  const clips = Array.isArray(data.clips) ? data.clips : [];
  const dur = clips.reduce(
    (sum, c) =>
      sum +
      (c.kind === "shader"
        ? Math.max(0.1, c.dur ?? 5)
        : Math.max(0, (c.out ?? 0) - (c.in ?? 0))),
    0,
  );
  const mm = Math.floor(dur / 60);
  const ss = Math.floor(dur % 60);
  meta.textContent = `${clips.length} clip${clips.length === 1 ? "" : "s"} · ${mm}:${String(ss).padStart(2, "0")}`;

  // "reels" is portrait output — letterbox the thumb instead of cropping it,
  // so the preview reads as a vertical video rather than a cropped square.
  const vertical = data.preset === "reels";
  prev.classList.toggle("artifact__preview--vertical", vertical);

  const first = clips[0];
  if (!first) return; // keep the movie-icon placeholder
  if (first.kind === "shader") {
    // Render the shader itself — the preview IS the first frame's look.
    const r = createShaderRenderer();
    const [w, h] = vertical ? [180, 320] : [340, 240];
    const out = r?.render(first.effect, first.params, 1.0, w, h);
    if (out) {
      out.className = "artifact__preview-media";
      prev.replaceChildren(out);
    }
  } else {
    const abs = first.src.startsWith("/") ? first.src : `${project.path}/${first.src}`;
    try {
      const p = await invoke("quicklook_thumb", { path: abs, size: 340 });
      const img = el("img", "artifact__preview-media");
      img.src = convertFileSrc(p);
      // quicklook_thumb reflects the source file's raw orientation; the editor
      // applies clip.rotate on top of that (see applyVidTransform in video.js),
      // so the thumb needs the same rotation to match what the editor shows.
      const rot = (((first.rotate || 0) % 360) + 360) % 360;
      if (rot) {
        img.onload = () => rotateThumb(img, prev, rot);
      }
      prev.replaceChildren(img);
    } catch {} // keep the placeholder
  }
}

// Mirrors applyVidTransform's math (video.js) for a static <img>: rotate the
// frame in place and swap its fitted footprint for 90°/270° rotations so it
// still fills the (now letterboxed) preview box without spilling out of it.
function rotateThumb(img, box, deg) {
  const bw = box.clientWidth || 1;
  const bh = box.clientHeight || 1;
  const aspect = (img.naturalWidth || 16) / (img.naturalHeight || 9);
  const w = deg === 90 || deg === 270 ? Math.min(bh, bw * aspect) : Math.min(bw, bh * aspect);
  img.style.position = "absolute";
  img.style.left = "50%";
  img.style.top = "50%";
  img.style.width = w + "px";
  img.style.height = w / aspect + "px";
  img.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
}

function artifactCard(item) {
  let data = {};
  try {
    data = JSON.parse(item.content);
  } catch {}

  const card = el("div", "artifact-card");
  card.dataset.path = item.path;
  card.addEventListener("click", (e) => {
    artifactsSelection.toggle(item.path, e.metaKey || e.ctrlKey);
  });
  card.appendChild(
    item.kind === "brand-kit"
      ? brandKitPreview(data)
      : item.kind === "presentation"
        ? presentationPreview(data)
        : item.kind === "theme"
          ? themePreview(data)
          : item.kind === "diagram"
            ? diagramPreview(data)
            : el("div", "artifact__preview"),
  );

  const open = () => {
    const editor = EDITOR[item.kind];
    if (!editor) return;
    invoke("open_tool", {
      file: editor,
      query: "artifact=" + encodeURIComponent(item.path),
    });
  };

  const foot = el("div", "artifact-card__foot");
  const info = el("div", "artifact-card__info");
  info.appendChild(el("span", "artifact-card__name", { textContent: item.name }));
  if (item.kind === "presentation") {
    const n = Array.isArray(data.slides) ? data.slides.length : 0;
    info.appendChild(
      el("span", "artifact-card__meta", { textContent: `${n} slide${n === 1 ? "" : "s"}` }),
    );
  }
  foot.appendChild(info);
  foot.appendChild(actionBtn("open_in_new", "Open", open, true));
  card.appendChild(foot);

  card.addEventListener("dblclick", open);
  return card;
}

// Lazy-load a Google Fonts family (mirrors brand-explorer.html's loader).
const loadedFonts = new Set();
function loadGoogleFont(family, weight) {
  if (!family) return;
  const key = weight ? `${family}@${weight}` : family;
  if (loadedFonts.has(key)) return;
  loadedFonts.add(key);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=" +
    family.replace(/ /g, "+") +
    (weight ? `:wght@${weight}` : "") +
    "&display=swap";
  document.head.appendChild(link);
}

// --- Reusable brand-kit preview (the "separable preview" from the spec) -----
export function brandKitPreview(data) {
  const fonts = data.fonts || {};
  const colors = Array.isArray(data.colors) ? data.colors : [];

  // Tolerate both shapes: { family, weight } (current) and "Family" (legacy).
  const fontLabel = (f) => {
    if (!f) return "—";
    if (typeof f === "string") return f;
    return f.family || "—";
  };
  const fontFamily = (f) => (typeof f === "string" ? f : f?.family);
  const fontWeight = (f) => (f && typeof f === "object" ? f.weight : undefined);

  const wrap = el("div", "artifact__preview artifact__preview--brand");

  const type = el("div", "artifact__type");
  const h = el("div", "artifact__type-h", { textContent: fontLabel(fonts.heading) });
  const b = el("div", "artifact__type-b", { textContent: fontLabel(fonts.body) });
  for (const [node, f] of [[h, fonts.heading], [b, fonts.body]]) {
    const family = fontFamily(f);
    if (!family) continue;
    const weight = fontWeight(f);
    loadGoogleFont(family, weight);
    node.style.fontFamily = `"${family}", sans-serif`;
    if (weight) node.style.fontWeight = String(weight);
  }
  type.appendChild(h);
  type.appendChild(b);
  wrap.appendChild(type);

  const sw = el("div", "artifact__swatches");
  for (const c of colors) {
    const s = el("span", "artifact__swatch", {
      title: `${c.name || ""} ${c.value || ""}`.trim(),
    });
    s.style.background = c.value || "#ccc";
    sw.appendChild(s);
  }
  wrap.appendChild(sw);
  return wrap;
}

// Derive a slide's {bg, text, muted} from the theme palette + color scheme.
// Mirrors colorScheme() in slides.html (kept light — preview only).
function deckSchemePalette(c, scheme) {
  if (scheme === "soft") return { bg: c.surface, text: c.text, muted: c.muted };
  if (scheme === "dark") return { bg: c.text, text: c.bg, muted: c.surface };
  if (scheme === "accent") return { bg: c.accent, text: c.bg, muted: c.bg };
  if (scheme === "accent2") return { bg: c.accent2, text: c.bg, muted: c.bg };
  return { bg: c.bg, text: c.text, muted: c.muted };
}

// --- Theme preview: brand-kit-style card on the theme's fonts + 6 colors -----
export function themePreview(data) {
  const c = data.colors || {};
  return brandKitPreview({
    fonts: data.fonts || {},
    colors: [
      { name: "Background", value: c.bg }, { name: "Surface", value: c.surface },
      { name: "Text", value: c.text }, { name: "Muted", value: c.muted },
      { name: "Accent", value: c.accent }, { name: "Accent 2", value: c.accent2 },
    ].filter((x) => x.value),
  });
}

// --- Presentation preview: a mini render of the deck's first slide ----------
export function presentationPreview(data) {
  const theme = data.theme || {};
  const colors = theme.colors || {};
  const fonts = theme.fonts || {};
  const slides = Array.isArray(data.slides) ? data.slides : [];
  const slide = slides[0] || {};

  const heading = fonts.heading?.family;
  const body = fonts.body?.family;
  if (heading) loadGoogleFont(heading, fonts.heading?.weight);
  if (body) loadGoogleFont(body, fonts.body?.weight);

  const scheme = slide.colorScheme || (slide.layout === "section" ? "accent" : "light");
  const pal = deckSchemePalette(colors, scheme);

  const wrap = el("div", "artifact__preview artifact__preview--deck");
  wrap.style.background = pal.bg || "#fff";
  wrap.style.color = pal.text || "#222";
  wrap.style.justifyContent = "center";
  wrap.style.gap = "7px";
  wrap.style.padding = "16px 18px";
  wrap.style.overflow = "hidden";

  const titleText = slide.title || slide.quote || (slides.length ? "" : "Empty deck");
  const big = el("div", "", { textContent: titleText });
  big.style.fontFamily = heading ? `"${heading}", serif` : "var(--serif)";
  if (fonts.heading?.weight) big.style.fontWeight = String(fonts.heading.weight);
  big.style.fontSize = "21px";
  big.style.lineHeight = "1.1";
  big.style.display = "-webkit-box";
  big.style.webkitLineClamp = "3";
  big.style.webkitBoxOrient = "vertical";
  big.style.overflow = "hidden";
  wrap.appendChild(big);

  if (slide.subtitle) {
    const sub = el("div", "", { textContent: slide.subtitle });
    sub.style.fontFamily = body ? `"${body}", sans-serif` : "var(--sans)";
    sub.style.fontSize = "13px";
    sub.style.color = pal.muted || pal.text;
    sub.style.whiteSpace = "nowrap";
    sub.style.overflow = "hidden";
    sub.style.textOverflow = "ellipsis";
    wrap.appendChild(sub);
  }
  return wrap;
}

// --- Diagram preview: the real renderer, scaled to the card ------------------
export function diagramPreview(data) {
  const wrap = el("div", "artifact__preview artifact__preview--diagram");
  wrap.style.padding = "0";
  wrap.style.overflow = "hidden";
  const fonts = data.theme?.fonts;
  if (fonts?.heading) loadGoogleFont(fonts.heading.family, fonts.heading.weight);
  if (fonts?.body) loadGoogleFont(fonts.body.family, fonts.body.weight);
  try {
    const svg = renderDiagram(data);
    svg.style.width = "100%";
    svg.style.height = "100%";
    // Fill the card (crop edges) rather than letterbox — it's a thumbnail.
    svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    wrap.appendChild(svg);
  } catch {
    wrap.appendChild(el("span", "artifact-card__meta", { textContent: "diagram" }));
  }
  return wrap;
}

function emptyMsg(text) {
  return el("p", "artifacts__empty", { textContent: text });
}

function actionBtn(icon, label, onClick, iconOnly = false) {
  const b = el("button", "btn-main" + (iconOnly ? " btn-main--icon" : ""), {
    type: "button",
    title: label,
  });
  b.innerHTML = iconOnly ? mi(icon) : mi(icon) + label;
  b.addEventListener("click", onClick);
  return b;
}
