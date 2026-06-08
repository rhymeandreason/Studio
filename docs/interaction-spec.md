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
  const key = keyName(e);
  // Panel map first, then global fallback. This is how Mod+n means "new note"
  // in Notes but "new project" everywhere else.
  const handler = panelKeymaps[activePanel]?.[key] ?? globalKeymap[key];
  if (handler) { e.preventDefault(); handler(e); }
});
```

- `activePanel`: one of `projects | workspace | media | notes`, set by
  `selectTab()` and by entering/leaving the overview.
- `isEditableTarget(el)`: INPUT / TEXTAREA / SELECT / contentEditable. The single
  source of truth (replaces the duplicated checks).
- `anyModalOpen()`: generate / extend / new-project modal. (Lightbox is **not**
  a modal — it's Media's own mode; see 4.3.)
- `keyName(e)`: normalizes to strings like `"Delete"`, `"Enter"`, `"Escape"`,
  `"ArrowLeft"`, `"Mod+c"`, `"Mod+v"`, `"Shift+ArrowDown"`. `Mod` = Cmd on mac,
  Ctrl elsewhere. **`Space` normalizes to `Enter`** (so every panel's Enter
  handler also fires on Space). Space/Enter in a field is gated out by
  `isEditableTarget`.
- **Resolution order:** panel keymap → global keymap. There is no separate
  "checked before" global tier; global is the *fallback*, so a panel can always
  override a global key.

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

**Global (fallback — fires only if the active panel didn't claim the key):**
More combos for project/window browsing to be added later.
| Key | Action |
|---|---|
| `Mod+n` | New project. (In Notes, the panel keymap overrides this to "new text note".) |
| `Escape` | clear selection in the active panel (fallback) |

> `Space` is normalized to `Enter` everywhere (see 4.1).

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
| `ArrowLeft/Right` | reorder selected card — **only when exactly one card is selected** (multi-select reorder is **[DECIDE: disable, or move the whole block keeping order?]**) |
| `ArrowUp/Down` | none (kept removed) |
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

---

## 8. Copy / Paste

### 8.0 Constraint (current reality)

There is **no Tauri clipboard plugin** today. Clipboard is:
- **Text:** `navigator.clipboard.readText/writeText` (webview) + macOS `pbpaste`
  via the `read_clipboard_text` Rust command.
- **Image:** `paste_image` Rust command (macOS shell) reads a clipboard image
  into a project's `media/`.

So the system clipboard, as wired today, carries **plain text or an image** —
no rich/HTML flavor, macOS-only. Anything richer needs a new mechanism (8.3).

### 8.1 Model

"Copy" / "Paste" act on the **active panel's selection**. Each panel defines
`copy()` and `paste()`; the dispatcher routes `Mod+c` / `Mod+v` to them.

| Panel | `Mod+c` copies | `Mod+v` pastes |
|---|---|---|
| Media | image **adjustments** (in-mem `copiedEdits`) — from the editor-active image or the selected tile | **adjustments → selected tiles** (priority); only if there are no copied adjustments does it fall back to importing a clipboard image |
| Notes | selected note(s) — Studio-native (8.2) | clipboard → new note(s) (8.2) |
| Projects | **[DECIDED:nothing]** | — |
| Workspace | **[DECIDED: copy selected field value]** | — |

**Media is adjustments-first (decided — keep current behavior):**
- `Mod+c` always copies the image **adjustments** into the in-memory
  `copiedEdits` (never the image file or path).
- `Mod+v` precedence: if `copiedEdits` exists → paste adjustments onto the
  selected tiles. Only when there are no copied adjustments does `Mod+v` fall
  back to importing a clipboard image into the project.

### 8.2 Notes copy/paste — the rich case

Decided behavior — **copy writes two payloads; only the Studio one has styling:**
- **Within Studio (incl. cross-project, cross-window):** the Studio-native
  payload preserves note **type** (text / checklist / table), content, **and
  styling — theme, title/body fonts, span.** Pasting in Studio recreates the
  card exactly, theme included.
- **Outside Studio:** the system clipboard carries only the degraded **plain
  content — no theme, no fonts, no span.** So external apps never see styling;
  Studio does.

This is the whole reason for the two-representation mechanism in 8.3: the rich
flavor (Studio) carries the theme, the plain flavor (system clipboard) does not.

- **Outside Studio**, degrade to plain content:
  - text note → its body text
  - checklist → bulleted list, one item per line **[DECIDE: include checkbox
    state, e.g. `- [x]` / `- [ ]`, or plain `• item`?]**
  - table → **TSV** (header row + rows, tab-separated)
  - multiple notes → concatenated, blank line between.

Paste **into** Notes:
- If the clipboard holds a Studio-native payload (8.3) → reconstruct the
  note(s) with type preserved.
- Else parse the system text (existing `pasteIntoNotes` logic):
  - contains tabs → table note
  - multiple lines → **[DECIDE: checklist, or text note?]** (today: text)
  - single line / plain → text note
  - clipboard image → **[DECIDE: import to media (today), or make an image
    note?]**

### 8.3 How to carry the Studio-native payload — **[DECIDE between A and B]**

**Option A — Sidecar "Studio clipboard" file.**
On copy: write rich note JSON to a known app-cache file via a Rust command
*and* write the degraded text to the system clipboard. On paste: read the
sidecar file; if its stored degraded-text still equals the current system
clipboard text, use the rich payload (type preserved); else fall back to
parsing system text.
- ✓ Works cross-window & cross-project (shared file). ✓ No new plugin.
  External apps get the degraded text.
- ✗ Relies on the "system text still matches" heuristic to detect staleness.

**Option B — Real clipboard with an HTML flavor.**
Add a clipboard plugin/crate that writes `text/html` + `text/plain`. Embed the
note JSON in the HTML (data attribute or a typed `<script>` blob); plain text is
the degraded form. Studio reads the HTML flavor; external apps get HTML rich
text or plain text.
- ✓ Standard, no staleness heuristic. ✗ New dependency + capability; must
  confirm the WKWebView/Tauri path actually round-trips an HTML flavor.

> Recommendation: **A** for now (no new deps, satisfies all the decided
> requirements), revisit **B** if/when we want true rich-text interop.

---

## 9. Drag & Drop

### 9.0 Constraint (current reality)

Tauri's native file-drop (`dragDropEnabled: true`, default) **swallows HTML5
`dragover`/`drop`** in the webview. Consequences, now codified as rules:
- **External file drops** use the Tauri `drag-enter/over/leave/drop` events.
- **Internal reordering** must use **pointer events** (as Notes card reorder
  already does) — never HTML5 DnD.
- Any internal pointer-drag sets a flag that **suppresses the external file-drop
  overlay** (today: `draggingNoteId`; generalize to `internalDragActive`).

### 9.1 External file drop (OS files → app)

| Drop onto | Behavior |
|---|---|
| Media panel | import image files into project `media/` (today: works, switches to Media tab) |
| Notes panel | **[DECIDE: create image note? import to media + reference? ignore?]** |
| Workspace | **[DECIDE: set the relevant path field from a dropped file/folder? ignore?]** |
| Projects overview | **[DECIDE: dropped folder → open/add as project? ignore?]** |
| Non-image files anywhere | **[DECIDE: ignore, or import as generic media via QuickLook thumbs?]** |

Overlay: today a single global dropzone overlay. **[DECIDE: make it
context-aware — highlight only the panel that will receive the drop, with a
per-target label like "Add to Media" / "New note"?]**

### 9.2 Internal drag (within the app, pointer-based)

| Panel | Internal drag |
|---|---|
| Notes | reorder cards (done; horizontal drop indicator between column items) |
| Media | **[DECIDE: manual reorder, or stay sorted (date/name) with no manual order?]** |
| Projects | **[DECIDE: reorder tiles, or fixed order?]** |
| Cross-panel | **[DECIDE/Future: drag a media tile into a note to embed an image?]** |

### 9.3 Drag + selection interplay — **[DECIDE]**

When a drag starts on an item:
- If the item **is** in the current selection → drag the **whole selection**.
- If the item is **not** selected → `sel.set(item)` first, then drag just it.

Confirm this is the rule (it's the platform-standard behavior).

### 9.4 Open decisions (Copy/Paste + DnD)

1. Media copy/paste — **DECIDED: adjustments-first (keep current).** `Mod+c`
   copies adjustments; `Mod+v` pastes adjustments to selection, falling back to
   clipboard-image import only when no adjustments are copied.
2. Notes copy — **DECIDED: Studio-native payload includes theme/fonts/span;
   the system-clipboard (external) form is plain content with no styling.**
3. Checklist external form — `- [ ]` checkboxes or plain bullets?
4. Paste multi-line text into Notes — checklist or text note?
5. Paste image into Notes — import to media, or image note?
6. Studio-native payload mechanism — Option A (sidecar file) or B (HTML flavor)?
7. File drop targets — Notes / Workspace / Projects behaviors (9.1)?
8. Non-image file drops — ignore or import as generic media?
9. Context-aware drop overlay — yes/no?
10. Media/Projects internal reorder — allow or not?
11. Drag+selection rule (9.3) — confirm.
