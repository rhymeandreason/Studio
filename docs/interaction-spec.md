# Interaction Spec — Selection & Keyboard

Status: **DRAFT** — edit freely. Decision points are marked **[DECIDE]**.
Goal: one selection model and one keyboard model shared across all four areas
(Projects, Workspace, Media, Notes), so behavior is consistent and multi-window
stays clean.

---

## 1. Principles

1. **One selection primitive.** Every panel uses the same `Selection` object;
   only its mode (single/multi) and its action callbacks differ.
2. **One keyboard dispatcher.** A single `document` keydown listener gates once
   (editable field? modal open?) and routes to the active panel's keymap.
3. **Shared action names.** `Delete`, `Enter`, `Escape`, arrows mean the same
   verb everywhere; only the implementation differs per panel.
4. **No behavior that depends on which window you're in.** A panel behaves
   identically in any window.

---

## 2. Current state (for reference — what we're replacing)

| Area | Selection today | Keyboard today |
|---|---|---|
| Projects | none — click opens, trash button deletes | none |
| Workspace | none (form inputs) | local Enter/Esc per input |
| Media | `mediaSelection: Set<path>`; click replaces, Cmd/Ctrl-click toggles; selbar shows count | global keydown: Esc, Mod+C/V (copy/paste edits), Delete |
| Notes | `selectedNoteId` (card) **+** `selectedCol` **+** `selectedRow` (table) | global keydown: Arrows reorder card, Delete removes card/col/row |

Two separate global `keydown` listeners exist (media ~line 2845, notes ~line
2936), each re-deriving "is editable / is modal open / which tab".

---

## 3. Selection model

### 3.1 The `Selection` primitive

```js
const sel = createSelection({
  mode: "single" | "multi",
  onChange: () => repaint(),   // panel repaints is-selected from sel state
});
```

API:

| Method | Behavior |
|---|---|
| `has(id)` | is id selected |
| `get()` | array of selected ids (insertion order) |
| `size()` | count |
| `set(id)` | replace selection with just `id` |
| `add(id)` / `delete(id)` | multi-mode primitives |
| `toggle(id, additive)` | see rules below |
| `clear()` | empty it |
| `anchor` | last single-set id, for range-select **[DECIDED: yes shift-range]** |

`toggle(id, additive)` rules:
- **single mode:** ignores `additive`; clicking the selected item again →
  **[DECIDED: deselect]** (Notes currently deselects.)
- **multi mode, `additive=false`:** replace selection with `id`.
- **multi mode, `additive=true`** (Cmd/Ctrl-click): flip `id` in/out of the set.

`onChange` fires after every mutation; the panel's repaint toggles the
`is-selected` class. The primitive does **not** touch the DOM itself.

### 3.2 What "id" is, per panel

| Panel | id | mode |
|---|---|---|
| Projects | project path | multi |
| Media | media path | multi |
| Notes (cards) | note id | **[DECIDED: multi]** today single |
| Notes (table col/row) | see 3.3 | single, separate |
| Workspace | row index / field id | **[DECIDED: same selection behavior as other panels]** |

### 3.3 Notes' nested selection (the tricky one)

Notes has three selection scopes that are currently independent globals:
`selectedNoteId`, `selectedCol`, `selectedRow`. Proposal:

- One **card** Selection at the panel level.
- Table col/row selection is a **sub-selection local to the focused table
  note**, mutually exclusive with each other.
- Selecting a card clears any table sub-selection and vice versa. **[DECIDED: Yes.]**

### 3.4 Click semantics (must be consistent)

| Gesture | Result |
|---|---|
| Click item | `sel.set(id)` (replace) |
| Cmd/Ctrl-click | `sel.toggle(id, additive=true)` |
| Shift-click | range select **[DECIDED: yes for all]** |
| Click empty space in panel | `sel.clear()` |
| Double-click | panel "open/activate" action (Projects → open project; Media → open lightbox; Notes → **[DECIDED: open in Modal]**, Workspace → launch item;) **[DECIDED: new]**|

> **Projects behavior change:** today single-click *opens* a project. To match
> Media/Notes, single-click would *select* and double-click (or Enter) opens.
> **[DECIDED: accept this change]**

---

## 4. Keyboard model

### 4.1 The dispatcher

```js
document.addEventListener("keydown", (e) => {
  if (anyModalOpen()) { modalKeymap(e); return; }      // modals win
  if (isEditableTarget(e.target)) return;              // typing → let it through
  const map = panelKeymaps[activePanel];
  const handler = map?.[keyName(e)];
  if (handler) { e.preventDefault(); handler(e); }
});
```

- `activePanel`: one of `projects | workspace | media | notes`, set by
  `selectTab()` and by entering/leaving the overview.
- `isEditableTarget(el)`: INPUT / TEXTAREA / SELECT / contentEditable. The single
  source of truth (replaces the duplicated checks).
- `anyModalOpen()`: generate / extend / lightbox / new-project modal.
  **[DECIDED: lightbox is Media's own mode. Escape key closes]**
- `keyName(e)`: normalizes to strings like `"Delete"`, `"Enter"`, `"Escape"`,
  `"ArrowLeft"`, `"Mod+c"`, `"Mod+v"`, `"Shift+ArrowDown"`. `Mod` = Cmd on mac,
  Ctrl elsewhere.

### 4.2 Keymap registration

Each panel registers a flat map of `keyName → handler`:

```js
panelKeymaps.notes = {
  "Delete":     () => deleteSelectedNotes(),
  "Backspace":  () => deleteSelectedNotes(),
  "ArrowLeft":  () => moveSelectedNote(-1),
  "ArrowRight": () => moveSelectedNote(+1),
  "Escape":     () => notesSelection.clear(),
};
```

### 4.3 Proposed unified keymaps

Fill in / correct these — this is the heart of the spec.

**Global (any panel, checked before panel maps):** **[DECIDED: global key combos add later for project/window browsing]**
| Key | Action |
|---|---|
| `Mod+n` | New project. New text note in Notes. **[DECIDED: yes]** |
| `Escape` | clear selection in the active panel (fallback) |

**[DECIDED: add 'Space' does same as 'Enter' for everything]**
**Projects**
| Key | Action |
|---|---|
| `Enter` | open selected project (single) |
| `Delete` / `Backspace` | trash selected project(s) **[DECIDED: add confirm dialog]** |
| `ArrowLeft/Right/Up/Down` | move selection across grid |
| `Mod+a` | select all **[DECIDED: no]** |
| `Escape` | clear selection |

**Workspace**
| Key | Action |
|---|---|
| `Enter` | Launch app or open link (single) |
| `Delete` / `Backspace` | delete selected item(s) |
| `ArrowLeft/Right/Up/Down` | move selection across grid | **[DECIDED: add grid keyboard behavior]** |
| `Escape` | clear selection |

**Media**
| Key | Action |
|---|---|
| `Delete` / `Backspace` | trash selected media |
| `Mod+c` | copy adjustments (when editor active) |
| `Mod+v` | paste adjustments to selection / paste clipboard image |
| `Enter` | open lightbox for selected **[DECIDED: same as double click]** |
| `ArrowLeft/Right/Up/Down` | move selection across grid **[DECIDED: yes]** |
| `Escape` | close lightbox → else clear selection |

**Notes**
| Key | Action |
|---|---|
| `Delete` / `Backspace` | delete selected card(s), or selected table col/row |
| `ArrowLeft/Right` | reorder selected card |
| `ArrowUp/Down` | **[DECIDED: keep removed]** |
| `Escape` | clear card / table selection |
| `Mod+c` | copy note **[DECIDED: new, copy/paste notes should preserve type of note inside studio, allow copy/paste between projects. Outside of studio, it should paste as text, TSV, or bulleted list]** |
| `Mod+v` | paste into notes (existing pasteIntoNotes) **[DECIDED: keep]** |

### 4.4 Modal keymap

While a modal is open, only the modal's keys fire (everything else swallowed):
| Key | Action |
|---|---|
| `Escape` | close modal |
| `Enter` | confirm (new-project create, etc.) |
| `ArrowLeft/Right` | browse to next item **[DECIDED: new]**| 

---

## 5. Edge cases & rules

- **Typing focus wins:** if focus is in an editable field, panel keymaps never
  fire (the dispatcher returns early). Field-local handlers (Enter to commit a
  rename, Esc to cancel) are registered on the field, not the dispatcher.
- **Selection survives re-render:** panels rebuild DOM often (`renderNotes`,
  `loadMedia`). Selection is keyed by stable id, repaint reads `sel.has(id)`.
- **Deleting selected items:** after delete, selection should **[DECIDED: clear]**
- **Switching tabs/windows:** `activePanel` changes; selection per panel is
  **[DECIDED: preserved]**
- **Click-after-drag:** Notes already suppresses the click that follows a drag
  (300ms guard) — keep this in the click→select path.

---

## 6. Multi-window implications (for later, but shapes the above)

- Window model: **one window per project**, keyed by project path (Tauri window
  label = path). Opening an already-open project focuses its window.
- Each window has its own `activePanel` and its own per-panel Selections — no
  cross-window selection sharing needed.
- Because one project = at most one window, two windows never edit the same
  `notes.json` / `workspace.json`, so no write-conflict handling is required.
- Therefore the selection/keyboard layer needs **no** awareness of windows; it's
  purely per-document state. Good.

---

## 7. Open decisions summary (collected for quick editing) **[DECIDED]**

1. Shift-range select — support it, grids only 
2. Single-mode re-click — deselect 
3. Notes cards — multi select
4. Workspace — grid selection/keyboard added
5. Projects — single-click-selects (double/Enter opens)
6. Lightbox — Media sub-mode (because it also opens Modals)
7. Truly global shortcuts - see above
8. Notes ArrowUp/Down — keep removed
9. Delete confirm dialog for projects - yes
10. Post-delete selection — clear
11. Selection on tab switch — preserve
