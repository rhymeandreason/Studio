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
| `Mod+v` | paste clipboard image → set icon of selected project (§11) |
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
| `Shift+Mod+c` | copy image — baked result (orig fallback); bitmap if single, file refs if multi (§8.1) |
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

**Media `Shift+Mod+c` — copy the actual image (decided):**
- **Which pixels:** the **edited (baked) result**, falling back to the original
  file when the image has no edits. (Reuses the existing bake path; HEIC bakes
  to JPEG via `heic_preview`.)
- **Clipboard form by selection size:**
  - **single** image selected → put the **bitmap** on the clipboard (pastes into
    image editors, and into Notes as an **image note** via `Mod+v` — see the
    cross-feature flow below).
  - **multiple** selected → put **file reference(s)** on the clipboard (pastes
    into Finder/Mail; bitmap-of-many isn't meaningful).
- **Cross-feature flow (intended):** `Shift+Mod+c` in Media (single) → switch to
  Notes → `Mod+v` → image note. This is the "send media to Notes" path; no
  dedicated action needed.
- **[DECIDE: `Shift+Mod+v` = paste/import image?]** Since `Mod+v` is shadowed by
  adjustments-paste whenever `copiedEdits` is held, a just-copied image can't be
  re-imported via `Mod+v`. `Shift+Mod+v` would force "import clipboard image".
- Needs a Rust command to place a baked image / file list on the macOS
  pasteboard (no existing command does the *write* direction).

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
  - checklist → bulleted list, one item per line **[DECIDED: include checkbox
    state]**
  - table → **TSV** (header row + rows, tab-separated)
  - multiple notes → concatenated, blank line between.

Paste **into** Notes:
- If the clipboard holds a Studio-native payload (8.3) → reconstruct the
  note(s) with type preserved.
- Else parse the system text (existing `pasteIntoNotes` logic):
  - contains tabs → table note
  - multiple lines → **[DECIDED: checklist]** (today: text)
  - single line / plain → text note
  - clipboard image → **[DECIDED: image notes]**

### 8.3 How to carry the Studio-native payload — **[DECIDED: Option B — HTML flavor]**

Write **two clipboard flavors** on copy via the async Clipboard API (no Rust
plugin needed if the webview cooperates):

```js
navigator.clipboard.write([ new ClipboardItem({
  "text/html":  new Blob([richHtml], { type: "text/html" }),  // embeds note JSON
  "text/plain": new Blob([degraded], { type: "text/plain" }), // 8.2 degraded form
})]);
```

- The note JSON (type + content + theme/fonts/span) is embedded in the
  `text/html` flavor — e.g. inside a `<script type="application/studio-notes">`
  blob or a `data-studio` attribute, alongside human-readable HTML.
- **Studio paste** reads `text/html`, finds the embedded JSON → reconstructs
  notes with full fidelity. External apps get rich text (HTML) or plain text.
- **Plain-text-only sources** (and the textarea case below) → no embedded JSON →
  fall through to the §8.2 text-parsing path.

**Implementation notes / risk:**
- Verify `navigator.clipboard.read()` returns the `text/html` flavor in the
  Tauri WKWebView (history of `readText()` being finicky there — see the
  existing `read_clipboard_text`/`pbpaste` workaround). If read fails, add a
  Rust clipboard-crate command for the **read** path only; write stays in JS.
- Image notes (§10.5): the embedded JSON references an asset; paste must
  materialize the file into the destination project's `notes/`.

**Textarea selection still copies plain text.** When focus is inside a textarea
(editing), the keyboard dispatcher gates out (`isEditableTarget`, §4.1), so
`Mod+c` is the browser's native copy of the selected text — plain text only,
Studio does not intercept. Studio's rich card-copy only runs when a card is
selected and you're *not* editing.

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

Behavior is driven by **what is dropped**, not which panel it lands on (drop
anywhere in the window). The only context split is overview vs an open project.

**In an open project window** (drop anywhere in the window):
| Dropped item | Behavior |
|---|---|
| Image file | **Move into project `media/`** (keep current behavior). Always → media, regardless of panel. Image *notes* are made via paste only (§10.4), never by drop. |
| Non-image file | Move the file into the project folder. |
| **Folder** | **Add a folder entry to the Workspace**, with an **"Open in Finder"** action. Does **not** move/copy the folder; stores its path. (Needs a new Workspace list type — see below.) |

**On the Projects overview** (no project open):
| Dropped item | Behavior |
|---|---|
| Folder | Add as a project, referencing the folder in place (don't move it into `/Projects`). |
| File | **[DECIDED: ignore]** |

**New Workspace list type for dropped folders:** add a `folders` entry to
`LIST_META` (icon `folder_open`, label "Folder"), holding folder paths. Its row
action opens the folder in Finder (`reveal_in_finder` / `open_path`). This is
also the differentiation the user asked for: **files move in, folders get
referenced + an open-in-Finder action.**

Overlay: keep the single global dropzone overlay, but **label it by what's being
dropped / where** — e.g. "Move image to Media", "Add folder to Workspace", "Add
project" on the overview. The drop handler classifies each path
(image-file / other-file / folder) and routes accordingly.

### 9.2 Internal drag (within the app, pointer-based)

| Panel | Internal drag |
|---|---|
| Notes | reorder cards (done; horizontal drop indicator between column items) |
| Media | **[DECIDED: manual reorder, add sort toggle buttons]** |
| Projects | **[DECIDED: reorder tiles]** |
| Cross-panel | **[DECIDED: drag a media tile into Notes Tab to create an image note]** |

### 9.3 Drag + selection interplay — **[DECIDED: yes]**

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
4. Paste multi-line text into Notes — **DECIDED: checklist.**
5. Paste image into Notes — **DECIDED: image note** (see §10).
6. Studio-native payload mechanism — **DECIDED: Option B (HTML flavor via
   `ClipboardItem`).** Verify WKWebView `read()` of `text/html`; Rust read
   fallback if needed.
7. File drop targets — **DECIDED (§9.1):** image file → `media/` (any panel);
   folder → Workspace folder entry + Open-in-Finder; non-image file → moved into
   project folder; folder on overview → add as project.
8. Non-image file drops — **DECIDED: move into the project folder.**
9. Context-aware drop overlay — **DECIDED: keep single overlay, labeled by what's
   dropped / where.**
10. Media/Projects internal reorder — **DECIDED: allow**
11. Drag+selection rule (9.3) —  **DECIDED: yes**

---

## 10. Image notes (data model)

**Decision: store the image as a file (not inline base64), in a dedicated
`notes/` folder in the project. Separate from `media/` (Option B), so note
images don't appear in the Media tab.**

### 10.1 Project layout

```
<project>/
  media/                 # Media-tab images (unchanged)
  notes/                 # NEW: image-note asset files live here
    <noteId>.<ext>
  notes.json             # stays at project root; references notes/ files
  .<file>.studio.json    # edit sidecars (media only)
```

`notes.json` holds only a **reference**, never image bytes. The `src` may point
into **either** `notes/` (note-owned asset) **or** an existing `media/` file:

```jsonc
{
  "kind": "image",
  "id": "n…",
  "src": "notes/n….png",   // project-relative; may also be "media/foo.png"
  "w": 1200, "h": 800,      // natural pixel size (for layout / bento sizing)
  "caption": "",            // optional
  "theme": "…", "span": 1   // same styling fields as other notes
}
```

**Don't duplicate files already in the project.** If the image being turned into
a note already lives in the project (e.g. it's a `media/` file), the note just
**references that path in place** — no copy into `notes/`. Only images coming
from *outside* the project (clipboard paste, external file) get written into
`notes/`. So `src` is `notes/…` for note-owned imports and `media/…` for images
already present.

### 10.2 Display

- Render via `convertFileSrc(<project>/notes/<file>)` directly — image notes are
  shown, not edited, so they do **not** need the Media WebGL/thumbnail pipeline.
  (If we later want editing or perf thumbnails, revisit.)
- `w`/`h` feed bento row-span sizing so the card reserves correct height before
  the image loads.

### 10.3 Rust commands (new, parallel to media but simpler)

- `import_note_image(project_path, file) -> src` — copy an **external** file
  into `notes/`, return the project-relative path. (Skip the copy and just
  reference the path if the file is already inside the project.)
- `paste_note_image(project_path) -> src` — write a clipboard image into
  `notes/` (mirrors `paste_image`, different target dir).
- **Deletion is path-scoped:** removing an image note deletes its asset **only
  if `src` is under `notes/`** (note-owned). If `src` points into `media/`, the
  file is shared with the Media tab — leave it; just remove the note. No
  reference-counting needed: ownership is decided by which folder the file is in.

### 10.4 Creation paths

- **Paste** a clipboard image while in Notes → `paste_note_image` → new image
  note (per §8.2 decision). **This is the only drag/drop/paste route to an image
  note.**
- **Drag-dropping an image file does NOT create an image note** — image-file
  drops always go to `media/` (§9.1). So image notes come from paste (or the
  optional toolbar button below) only.
- **[DECIDED: no toolbar "Image" button]

### 10.5 Copy/paste of image notes (ties to §8)

- **Within Studio:** the Studio-native payload references the asset. Pasting in
  the **same** project reuses the file in place (whether `src` is `notes/…` or
  `media/…`). Pasting into a **different** project must **copy the file into the
  destination's `notes/`** and rewrite `src` to that new path — regardless of
  whether the source was `notes/` or `media/` (the dest may not have that media
  file). So "copy carries a file" is required for image notes.
- **Outside Studio:** degrade to the **image on the system clipboard** (no
  theme/caption). **[DECIDE: confirm external paste = raw image, not a file
  reference.]**

### 10.6 Open decisions (image notes)

1. Toolbar "Image" add-button, or paste/drop only? (10.4)
2. External copy of an image note → raw image on clipboard? (10.5)
3. Caption — show/edit UI now, or schema-only for later?
4. Filename in `notes/` — `<noteId>.<ext>` (proposed) vs original name? Using the
   note id avoids collisions and makes orphan cleanup trivial.

---

## 11. Project icons

**Lightweight, convention-file based — no metadata store, no `list_projects`
change.**

### 11.1 Storage

- The icon is a fixed hidden file in the project folder: **`.studio-icon.png`**.
- Dot-prefixed → already skipped by `scan_projects` (ignores dotfiles), and it
  **travels with the folder** (copy/move the project, the icon comes along).

### 11.2 Display

- The overview card renders
  `<img src=convertFileSrc(<project>/.studio-icon.png)>` with an `onerror`
  handler that falls back to the current **letter/initial avatar**.
- The `img` failing to load *is* the existence check → **no Rust change needed
  to display** icons.
- Perf (later, optional): if grids get large, bake a ~256px square via
  `quicklook_thumb` so cards don't decode full-res photos.

### 11.3 Setting an icon — **paste onto the selected project**

- In the Projects overview, **select a project** (single), then **`Mod+v`** with
  a clipboard image → writes it to that project's `.studio-icon.png` and
  repaints the card.
- New Rust command `set_project_icon(project_path)` — write the clipboard image
  to `<project>/.studio-icon.png` (mirrors `paste_image`, fixed filename).
- This adds `Mod+v` to the **Projects keymap** (§4.3): "paste clipboard image →
  set icon of selected project". No-op if the clipboard has no image or no
  single project is selected.

### 11.4 Open decisions (project icons)

1. Remove/reset icon — a key or menu action to delete `.studio-icon.png`?
2. Non-square images — center-crop to square on set, or letterbox in the card?
