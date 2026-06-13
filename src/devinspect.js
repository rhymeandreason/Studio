// Dev tool: Cmd+Option+Click an element to jump to its CSS rule in Zed.
// Walks document.styleSheets for the last rule matching the clicked element,
// maps the stylesheet to its source file under src/, finds the selector's
// line by fetching the file text, and asks Rust to open `zed file:line`.
const { invoke } = window.__TAURI__.core;

const FILE_MAP = {
  "styles.css": "src/styles.css",
  "claude.css": "src/claude/claude.css",
  "schedules.css": "src/schedules/schedules.css",
};

function findMatchingRule(el) {
  let best = null;
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (!rule.selectorText) continue;
      try {
        if (el.matches(rule.selectorText)) {
          best = { sheet, rule };
        }
      } catch {
        // invalid/unsupported selector text (e.g. ::before) — skip
      }
    }
  }
  return best;
}

async function findLineNumber(href, selectorText) {
  const res = await fetch(href);
  const text = await res.text();
  const idx = text.indexOf(selectorText);
  if (idx === -1) return 1;
  return text.slice(0, idx).split("\n").length;
}

// Resolve which source file a matched rule lives in. External stylesheets
// map via FILE_MAP; inline <style> blocks (sheet.href === null, e.g. the
// git/Tools windows) live in this page's own .html file under src/.
function resolveSourceFile(sheet) {
  if (sheet.href) {
    const fileName = sheet.href.split("/").pop();
    return FILE_MAP[fileName] ?? null;
  }
  const path = location.pathname.replace(/^\/+/, "");
  return `src/${path}`;
}

const HIGHLIGHT_ID = "__devinspect_highlight";

function getHighlight() {
  let box = document.getElementById(HIGHLIGHT_ID);
  if (!box) {
    box = document.createElement("div");
    box.id = HIGHLIGHT_ID;
    box.style.position = "fixed";
    box.style.zIndex = "999999";
    box.style.pointerEvents = "none";
    box.style.background = "rgba(80, 160, 255, 0.25)";
    box.style.outline = "1px solid rgba(80, 160, 255, 0.9)";
    box.style.display = "none";
    document.body.appendChild(box);
  }
  return box;
}

function updateHighlight(e) {
  const box = getHighlight();
  if (!e.metaKey || !e.altKey) {
    box.style.display = "none";
    return;
  }
  const target = e.target;
  if (target === box) {
    box.style.display = "none";
    return;
  }
  const rect = target.getBoundingClientRect();
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  box.style.display = "block";
}

export function initDevInspect() {
  document.addEventListener("mousemove", updateHighlight, { capture: true });
  document.addEventListener("keyup", () => {
    getHighlight().style.display = "none";
  });

  document.addEventListener(
    "click",
    async (e) => {
      if (!e.metaKey || !e.altKey) return;
      const match = findMatchingRule(e.target);
      if (!match) {
        console.warn("devinspect: no matching CSS rule for", e.target);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      getHighlight().style.display = "none";

      const file = resolveSourceFile(match.sheet);
      if (!file) return;

      const href = match.sheet.href ?? location.href;
      const line = await findLineNumber(href, match.rule.selectorText);
      invoke("open_in_zed", { file, line }).catch((err) =>
        console.error("open_in_zed failed:", err)
      );
    },
    { capture: true }
  );
}
