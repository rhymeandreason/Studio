// Shared keyboard model (interaction-spec §4).
//
// One document-level keydown dispatcher replaces the per-feature global
// listeners. It gates once (modal open? editable field?) and routes the
// normalized key to the active panel's keymap, falling back to a global map.

// Normalize a keydown event to a canonical string, e.g. "Delete", "Enter",
// "Escape", "ArrowLeft", "Mod+c", "Mod+Shift+c".
//
// Canonical modifier order is **Mod, Shift, Alt** — write keymap keys in that
// order. `Mod` = Cmd on mac, Ctrl elsewhere. `Space` normalizes to `Enter`.
export function keyName(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");

  let k = e.key;
  if (k === " " || k === "Spacebar") k = "Enter"; // Space behaves as Enter
  if (k.length === 1) k = k.toLowerCase(); // letters/digits are case-insensitive

  parts.push(k);
  return parts.join("+");
}

// True if the event target is something the user is typing into — panel keymaps
// must not fire there. The single source of truth (§4.1).
export function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

// Install the global dispatcher. Dependencies are injected so this module stays
// app-agnostic:
//   getActivePanel() -> "projects" | "workspace" | "media" | "notes"
//   panelKeymaps     -> { [panel]: { [keyName]: handler } }  (read live)
//   globalKeymap     -> { [keyName]: handler }               (fallback)
//   anyModalOpen()   -> bool; when true, only modalKeymap fires
//   modalKeymap(e)   -> handles keys while a modal is open
// Returns a teardown function.
export function installKeyDispatcher({
  getActivePanel,
  panelKeymaps,
  globalKeymap = {},
  anyModalOpen,
  modalKeymap,
}) {
  const onKeydown = (e) => {
    if (anyModalOpen?.()) {
      modalKeymap?.(e);
      return;
    }
    if (isEditableTarget(e.target)) return;

    const key = keyName(e);
    const handler =
      panelKeymaps[getActivePanel()]?.[key] ?? globalKeymap[key];
    if (handler) {
      e.preventDefault();
      handler(e);
    }
  };

  document.addEventListener("keydown", onKeydown);
  return () => document.removeEventListener("keydown", onKeydown);
}
