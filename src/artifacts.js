// Artifacts panel: lists a project's artifacts (brand kits, etc.), renders a
// preview per artifact, and opens them in their editor tool. See
// docs/artifacts.md. Claude authors artifacts into <project>/artifacts/; tools
// edit them; this panel is the human's gallery / launch surface.

import { state } from "./state.js";
import { el, mi } from "./dom.js";
import { createSelection } from "./selection.js";

const { invoke } = window.__TAURI__.core;

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
};

const KIND_LABEL = {
  "brand-kit": "Brand kits",
};

export async function renderArtifacts() {
  const root = document.getElementById("artifacts-panel");
  if (!root) return;
  root.innerHTML = "";

  const project = state.activeProject;
  if (!project) {
    root.appendChild(emptyMsg("No project active."));
    return;
  }

  // Toolbar.
  const toolbar = el("div", "ws-toolbar");
  const newKitBtn = el("button", "btn-add", { type: "button" });
  newKitBtn.innerHTML = `<span class="mi mi-sm">add</span>Brand kit`;
  newKitBtn.addEventListener("click", () =>
    invoke("open_tool", { file: EDITOR["brand-kit"], query: null }),
  );
  toolbar.appendChild(newKitBtn);
  root.appendChild(toolbar);

  let items = [];
  try {
    items = await invoke("list_artifacts", { projectPath: project.path });
  } catch (err) {
    root.appendChild(emptyMsg("Couldn't read artifacts: " + err));
    return;
  }

  if (!items.length) {
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
  foot.appendChild(el("span", "artifact-card__name", { textContent: item.name }));
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
    return f.weight ? `${f.family} · ${f.weight}` : f.family || "—";
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
