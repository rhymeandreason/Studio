// Shared right-click menu.
//
// One floating `.menu` panel per document, built on demand and torn down on the
// next click/scroll/blur. Items are plain data so callers stay declarative:
//
//   openContextMenu(e.clientX, e.clientY, [
//     { label: "Open", icon: "arrows-out", run: () => open(note) },
//     "-",
//     { label: "Theme", icon: "palette", items: themeItems },   // submenu
//     { label: "Delete", run: del },
//   ]);
//
// Item fields: label, icon (Phosphor name), run, items (submenu),
// disabled, checked (shows a tick), swatch (colour dot), font (renders the
// label in that font, for font pickers). `"-"` is a separator.

const OPEN = []; // stack of open panels — [root, submenu, …]

export function closeContextMenu() {
  while (OPEN.length) OPEN.pop().remove();
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  window.removeEventListener("blur", closeContextMenu);
  window.removeEventListener("resize", closeContextMenu);
  document.removeEventListener("keydown", onKeydown, true);
}

function onDocPointerDown(e) {
  if (!OPEN.some((m) => m.contains(e.target))) closeContextMenu();
}

function onKeydown(e) {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeContextMenu();
  }
}

export function openContextMenu(x, y, items) {
  closeContextMenu();
  const panel = buildPanel(items, 0);
  place(panel, x, y);
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("blur", closeContextMenu);
  window.addEventListener("resize", closeContextMenu);
  return panel;
}

// `depth` is the panel's index in the stack: opening a submenu closes any
// deeper panel that's still hanging around from a previous hover.
function buildPanel(items, depth) {
  const panel = document.createElement("div");
  panel.className = "menu ctxmenu";
  for (const item of items) {
    if (item === "-") {
      panel.append(Object.assign(document.createElement("div"), { className: "menu__sep" }));
      continue;
    }
    panel.append(buildItem(item, depth));
  }
  // Opening at this depth replaces whatever was here (a sibling's submenu) and
  // everything below it — remove those from the DOM, not just from the stack.
  while (OPEN.length > depth) OPEN.pop().remove();
  document.body.append(panel);
  OPEN[depth] = panel;
  return panel;
}

function buildItem(item, depth) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "menu__item ctxmenu__item";
  btn.disabled = !!item.disabled;

  if (item.icon) {
    const ic = document.createElement("span");
    ic.className = `mi mi-sm ph ph-${item.icon}`;
    btn.append(ic);
  }
  if ("swatch" in item) {
    const sw = document.createElement("span");
    sw.className = "ctxmenu__swatch" + (item.swatch ? "" : " ctxmenu__swatch--none");
    if (item.swatch) sw.style.background = item.swatch;
    btn.append(sw);
  }
  const label = document.createElement("span");
  label.className = "ctxmenu__label";
  label.textContent = item.label;
  if (item.font) label.style.fontFamily = item.font;
  btn.append(label);

  if (item.items) {
    const chev = document.createElement("span");
    chev.className = "mi mi-sm ph ph-caret-right ctxmenu__chev";
    btn.append(chev);
    // Hover opens the submenu (and closes a sibling's); clicking does the same,
    // so it works for anyone who taps rather than hovers.
    const open = () => {
      if (btn.classList.contains("is-open")) return;
      for (const sib of btn.parentElement.children) sib.classList?.remove("is-open");
      btn.classList.add("is-open");
      const sub = buildPanel(item.items, depth + 1);
      const r = btn.getBoundingClientRect();
      place(sub, r.right - 2, r.top - 4, { flipFrom: r.left });
    };
    btn.addEventListener("pointerenter", open);
    btn.addEventListener("click", open);
  } else {
    if (item.checked) {
      const tick = document.createElement("span");
      tick.className = "mi mi-sm ph ph-check ctxmenu__tick";
      btn.append(tick);
    }
    btn.addEventListener("pointerenter", () => {
      // Moving back onto a leaf closes whatever submenu is still showing.
      for (const sib of btn.parentElement.children) sib.classList?.remove("is-open");
      while (OPEN.length > depth + 1) OPEN.pop().remove();
    });
    btn.addEventListener("click", () => {
      closeContextMenu();
      item.run?.();
    });
  }
  return btn;
}

// Measure once placed, then nudge back inside the window. `flipFrom` is the
// submenu's alternative right edge when there's no room to the right.
function place(panel, x, y, { flipFrom } = {}) {
  panel.style.left = "0px";
  panel.style.top = "0px";
  const r = panel.getBoundingClientRect();
  let left = x;
  if (left + r.width > window.innerWidth - 4) {
    left = flipFrom != null ? flipFrom - r.width : window.innerWidth - r.width - 4;
  }
  panel.style.left = Math.max(4, left) + "px";
  panel.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + "px";
}
