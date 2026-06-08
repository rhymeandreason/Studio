// Shared selection primitive (interaction-spec §3).
//
// One small object every panel instantiates. It owns the set of selected ids
// and fires `onChange` after every mutation; the panel's repaint reads
// `has(id)` and toggles its own `is-selected` class. The primitive never
// touches the DOM itself.
//
//   const sel = createSelection({ mode: "multi", onChange: repaint });
//
// `mode`:
//   "single" — at most one id; re-selecting the current id deselects it.
//   "multi"  — any number; supports additive toggle and range select.

export function createSelection({ mode = "single", onChange } = {}) {
  const ids = new Set();
  let anchor = null; // last single-set id; the pivot for range selection

  const emit = () => onChange?.(api);

  const api = {
    mode,

    has: (id) => ids.has(id),
    get: () => [...ids],
    size: () => ids.size,
    get anchor() {
      return anchor;
    },

    // Replace the selection with just `id` (or clear if id == null).
    set(id) {
      ids.clear();
      if (id != null) {
        ids.add(id);
        anchor = id;
      } else {
        anchor = null;
      }
      emit();
    },

    add(id) {
      ids.add(id);
      anchor = id;
      emit();
    },

    delete(id) {
      if (ids.delete(id)) emit();
    },

    // Click semantics live here (§3.4):
    //  - single mode: re-clicking the lone selected id deselects; else replace.
    //  - multi + additive (Cmd/Ctrl-click): flip id in/out.
    //  - multi + !additive (plain click): replace with id.
    toggle(id, additive = false) {
      if (mode === "single") {
        if (ids.has(id) && ids.size === 1) {
          ids.clear();
          anchor = null;
        } else {
          ids.clear();
          ids.add(id);
          anchor = id;
        }
      } else if (additive) {
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        anchor = id;
      } else {
        ids.clear();
        ids.add(id);
        anchor = id;
      }
      emit();
    },

    // Shift-click range select (multi only). `orderedIds` is the panel's
    // current visual order; selects the inclusive span from anchor to id.
    range(orderedIds, id) {
      if (mode !== "multi" || anchor == null) {
        api.set(id);
        return;
      }
      const a = orderedIds.indexOf(anchor);
      const b = orderedIds.indexOf(id);
      if (a === -1 || b === -1) {
        api.set(id);
        return;
      }
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      ids.clear();
      for (let i = lo; i <= hi; i++) ids.add(orderedIds[i]);
      // anchor stays put so successive shift-clicks pivot from the same point
      emit();
    },

    clear() {
      if (!ids.size && anchor == null) return;
      ids.clear();
      anchor = null;
      emit();
    },
  };

  return api;
}
