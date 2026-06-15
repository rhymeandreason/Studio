// Artifacts panel: lists a project's artifacts (brand kits, etc.), renders a
// preview per artifact, and opens them in their editor tool. See
// docs/artifacts.md. Claude authors artifacts into <project>/artifacts/; tools
// edit them; this panel is the human's gallery / launch surface.

import { state } from "./state.js";
import { el, mi } from "./dom.js";

const { invoke } = window.__TAURI__.core;

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

  // Header: title + actions.
  const head = el("div", "artifacts__head");
  head.appendChild(el("h2", "artifacts__title", { textContent: "Artifacts" }));
  const actions = el("div", "artifacts__actions");
  actions.appendChild(
    actionBtn("add", "New brand kit", () =>
      invoke("open_tool", { file: EDITOR["brand-kit"], query: null }),
    ),
  );
  actions.appendChild(actionBtn("refresh", "Refresh", renderArtifacts, true));
  head.appendChild(actions);
  root.appendChild(head);

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
        "No artifacts yet. Make one with “New brand kit”, or ask Claude to generate some.",
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
  }
}

function artifactCard(item) {
  let data = {};
  try {
    data = JSON.parse(item.content);
  } catch {}

  const card = el("div", "artifact-card");
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

// --- Reusable brand-kit preview (the "separable preview" from the spec) -----
export function brandKitPreview(data) {
  const fonts = data.fonts || {};
  const colors = Array.isArray(data.colors) ? data.colors : [];

  const wrap = el("div", "artifact__preview artifact__preview--brand");

  const type = el("div", "artifact__type");
  type.appendChild(el("div", "artifact__type-h", { textContent: fonts.heading || "—" }));
  type.appendChild(el("div", "artifact__type-b", { textContent: fonts.body || "—" }));
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
  const b = el("button", "btn-save" + (iconOnly ? " btn-save--icon" : ""), {
    type: "button",
    title: label,
  });
  b.innerHTML = iconOnly ? mi(icon) : mi(icon) + label;
  b.addEventListener("click", onClick);
  return b;
}
