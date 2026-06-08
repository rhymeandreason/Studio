# Interaction Spec — Selection & Keyboard

Goal: one selection model and one keyboard model shared across all four areas
(Projects, Workspace, Media, Notes), so behavior is consistent and multi-window
stays clean. Most choices are settled; remaining open questions are collected in
§11.

---

## 1. Principles

1. **One selection primitive.** Every panel uses the same `Selection` object;
   only its mode (single/multi) and its action callbacks differ.
2. **One keyboard dispatcher.** A single `document` keydown listener gates once
   (editable field? modal open?) and routes to the active panel's keymap.
3. **Shared action names.** `Delete`, `Enter`, `Escape`, arrows mean the same
   verb everywhere; only the implementation differs per panel.
4. **No behavior depends on which window you're in.** A panel behaves
   identically in any window.

---

## 2. Current state (what we're replacing)

| Area | Selection today | Keyboard today |
|---|---|---|
| Projects | none — click opens, trash button deletes | none |
| Workspace | none (form inputs) | local Enter/Esc per input |
| Media | `mediaSelection: Set<path>`; click replaces, Cmd/Ctrl-click toggles; selbar shows count | global keydown: Esc, Mod+C/V (copy/paste edits), Delete |
| Notes | `selectedNoteId` (card) + `selectedCol` + `selectedRow` (table) | global keydown: Arrows reorder card, Delete removes card/col/row |

Two separate global `keydown` listeners exist (one for Media, one for Notes),
each re-deriving "is editable / is modal open / which tab". We collapse these.

---

## 3. Selection model

### 3.1 The `Selection` primitive

```js
const sel = createSelection({
  mode: "single" | "multi",
  onChange: () => repaint(),   // panel repaints is-selected from sel state
});
```

| Method | Behavior |
|---|---|
| `has(id)` | is id selected |
| `get()` | array of selected ids (insertion order) |
| `size()` | count |
| `set(id)` | replace selection with just `id` |
| `add(id)` / `delete(id)` | multi-mode primitives |
| `toggle(id, additive)` | see rules below |
| `clear()` | empty it |
| `anchor` | last single-set id, used as the range-select pivot |

`toggle(id, additive)` rules:
- **single mode:** ignores `additive`; clicking the selected item again
  **deselects** it.
- **multi mode, `additive=false`:** replace selection with `id`.
- **multi mode, `additive=true`** (Cmd/Ctrl-click): flip `id` in/out of the set.

`onChange` fires after every mutation; the panel's repaint toggles the
`is-selected` class. The primitive does **not** touch the DOM itself.

### 3.2 What "id" is, per panel

| Panel | id | mode |
|---|---|---|
| Projects | project path | multi |
| Media | media path | multi |
| Notes (cards) | note id | multi |
| Notes (table col/row) | see 3.3 | single, separate |
| Workspace | row index / field id | multi |

### 3.3 Notes' nested selection

Notes has three selection scopes (today the independent globals
`selectedNoteId`, `selectedCol`, `selectedRow`):

- One **card** Selection at the panel level.
- Table col/row selection is a **sub-selection local to the focused table
  note**, mutually exclusive with each other.
- Selecting a card clears any table sub-selection, and vice versa.

### 3.4 Click semantics (consistent across panels)

| Gesture | Result |
|---|---|
| Click item | `sel.set(id)` (replace) |
| Cmd/Ctrl-click | `sel.toggle(id, additive=true)` |
| Shift-click | range select from `anchor` (all grids) |
| Click empty space in panel | `sel.clear()` |
| Double-click | panel open/activate action: Projects → open project; Media → open lightbox; Notes → open in modal; Workspace → launch item |

**Projects behavior change:** single-click now *selects* (was: opens);
double-click or `Enter` opens.

---

## 4. Keyboard model

### 4.1 The dispatcher

```js
document.addEventListener("keydown", (e) => {
  if (anyModalOpen()) { modalKeymap(e); return; }      // modals win
  if (isEditableTarget(e.target)) return;              // typing → let it through
  const key = keyName(e);
  // Panel map first, then global fallback.
  const handler = panelKeymaps[activePanel]?.[key] ?? globalKeymap[key];
  if (handler) { e.preventDefault(); handler(e); }
});
```

- `activePanel`: `projects | workspace | media | notes`, set by `selectTab()`
  and by entering/leaving the overview.
- `isEditableTarget(el)`: INPUT / TEXTAREA / SELECT / contentEditable — the
  single source of truth (replaces today's duplicated checks).
- `anyModalOpen()`: generate / extend / new-project modal. The lightbox is **not**
  a modal — it's Media's own mode (§4.3).
- `keyName(e)`: normalizes to `"Delete"`, `"Enter"`, `"Escape"`, `"ArrowLeft"`,
  `"Mod+c"`, `"Mod+v"`, `"Shift+Mod+c"`, etc. `Mod` = Cmd on mac, Ctrl elsewhere.
  **`Space` normalizes to `Enter`** (Enter handlers also fire on Space).
- **Resolution order:** panel keymap → global keymap. Global is the *fallback*,
  so a panel can always override a global key (e.g. `Mod+n`).

### 4.2 Keymap registration

```js
panelKeymaps.notes = {
  "Delete":     () => deleteSelectedNotes(),
  "Backspace":  () => deleteSelectedNotes(),
  "ArrowLeft":  () => moveSelectedNote(-1),
  "ArrowRight": () => moveSelectedNote(+1),
  "Escape":     () => notesSelection.clear(),
};
```

### 4.3 Keymaps

**Global (fallback — fires only if the active panel didn't claim the key).**
More combos for project/window browsing to come later.
| Key | Action |
|---|---|
| `Mod+n` | New project (Notes overrides → new text note) |
| `Escape` | clear selection in the active panel |

**Projects**
| Key | Action |
|---|---|
| `Enter` | open selected project (single) |
| `Delete` / `Backspace` | trash selected project(s) — with confirm dialog |
| `Arrow*` | move selection across grid |
| `Mod+v` | paste clipboard image → set icon of selected project (§10) |
| `Escape` | clear selection |

**Workspace**
| Key | Action |
|---|---|
| `Enter` | launch app / open link (single) |
| `Delete` / `Backspace` | delete selected item(s) |
| `Arrow*` | move selection across grid |
| `Escape` | clear selection |

**Media**
| Key | Action |
|---|---|
| `Delete` / `Backspace` | trash selected media |
| `Mod+c` | copy adjustments (§7.1) |
| `Mod+v` | paste adjustments to selection; else import clipboard image (§7.1) |
| `Shift+Mod+c` | copy image — baked (orig fallback); bitmap if single, file refs if multi (§7.1) |
| `Enter` | open lightbox for selected (= double-click) |
| `Arrow*` | move selection across grid |
| `Escape` | close lightbox; else clear selection |

**Notes**
| Key | Action |
|---|---|
| `Delete` / `Backspace` | delete selected card(s), or selected table col/row |
| `ArrowLeft/Right` | reorder selected card — only when exactly one card is selected (multi-select reorder disabled) |
| `ArrowUp/Down` | none |
| `Mod+c` | copy selected note(s) (§7.2) |
| `Mod+v` | paste into notes (§7.2) |
| `Escape` | clear card / table selection |

### 4.4 Modal keymap

While a modal is open, only its keys fire (everything else swallowed):
| Key | Action |
|---|---|
| `Escape` | close modal |
| `Enter` | confirm (e.g. create project) |
| `ArrowLeft/Right` | browse to next item |

---

## 5. Edge cases & rules

- **Typing focus wins:** if focus is in an editable field, panel keymaps don't
  fire (dispatcher returns early). Field-local handlers (Enter to commit a
  rename, Esc to cancel) live on the field, not the dispatcher.
- **Selection survives re-render:** panels rebuild DOM often (`renderNotes`,
  `loadMedia`); selection is keyed by stable id, repaint reads `sel.has(id)`.
- **After delete:** selection clears.
- **On tab switch:** `activePanel` changes; each panel's selection is preserved.
- **Click-after-drag:** Notes already suppresses the click that follows a drag
  (300ms guard) — keep this in the click→select path.

---

## 6. Multi-window

- **One window per project**, keyed by project path (Tauri window label = path).
  Opening an already-open project focuses its window.
- Each window has its own `activePanel` and per-panel Selections — no
  cross-window selection sharing.
- One project = at most one window, so two windows never edit the same
  `notes.json` / `workspace.json` → no write-conflict handling needed.
- The selection/keyboard layer therefore needs **no** window awareness; it's
  purely per-document state.

---

## 7. Copy / Paste

### 7.0 Clipboard constraint (current reality)

No Tauri clipboard plugin today. Clipboard is:
- **Text:** `navigator.clipboard.readText/writeText` + macOS `pbpaste` via the
  `read_clipboard_text` command.
- **Image:** `paste_image` command (macOS) reads a clipboard image into `media/`.

So the system clipboard carries **plain text or an image**, macOS-only. Richer
flavors need the mechanism in §7.3.

### 7.1 Model + Media

Copy/Paste act on the **active panel's selection**; each panel defines `copy()`
and `paste()`, routed from `Mod+c` / `Mod+v`.

| Panel | `Mod+c` | `Mod+v` |
|---|---|---|
| Media | copy adjustments | paste adjustments (priority), else import clipboard image |
| Notes | copy selected note(s), Studio-native (§7.2) | paste → new note(s) (§7.2) |
| Projects | — | set icon of selected project (§10) |
| Workspace | copy selected field value | — |

**Media adjustments-first (keep current):**
- `Mod+c` copies the image **adjustments** into in-memory `copiedEdits` (never
  the file/path).
- `Mod+v`: if `copiedEdits` exists → paste adjustments onto selected tiles; only
  with no copied adjustments does it fall back to importing a clipboard image.

**Media `Shift+Mod+c` — copy the actual image:**
- **Pixels:** the **baked (edited) result**, falling back to the original when
  unedited. Reuses the existing bake path (HEIC → JPEG via `heic_preview`).
- **Form by selection size:**
  - **single** → write the **bitmap** (pastes into image editors, and into Notes
    as an image note via `Mod+v`).
  - **multiple** → write **file references**, Finder-style.
- **Cross-feature flow:** `Shift+Mod+c` (single) in Media → Notes → `Mod+v` →
  image note. This is the "send media to Notes" path.

**What needs native code:**
- **Single bitmap → pure JS.** Write the baked PNG from the editor canvas via
  `navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])`. The
  keydown is a valid user gesture. (Verify in the Tauri WKWebView — see §7.3.)
- **Multi-select file references → native command, Finder-style.** Place **file
  URLs on `NSPasteboard`** (`public.file-url` / `NSFilenamesPboardType`) so
  Finder, Mail, etc. paste them as real files. The web Clipboard API can't carry
  file references, so this needs `copy_files_to_clipboard(paths)` (clipboard
  crate or Cocoa). Which files: **edited images bake to a temp dir** (app cache)
  and those URLs are referenced; **unedited images reference the original** in
  place. The command receives the mixed path list.

### 7.2 Notes copy/paste

**Copy writes two payloads; only the Studio one carries styling.**
- **In Studio (incl. cross-project, cross-window):** the Studio-native payload
  preserves note **type** (text / checklist / table), content, and **styling —
  theme, fonts, span.** Paste recreates the card exactly.
- **Outside Studio:** the system clipboard carries only degraded **plain content
  — no theme/fonts/span.** Degradation:
  - text note → its body text
  - checklist → one item per line, with checkbox state (`- [ ]` / `- [x]`)
  - table → TSV (header + rows, tab-separated)
  - multiple notes → concatenated, blank line between

**Paste into Notes:**
- Studio-native payload present (§7.3) → reconstruct note(s) with full fidelity.
- Else parse system text (extends today's `pasteIntoNotes`):
  - contains tabs → table note
  - multiple lines → checklist
  - single line → text note
  - clipboard image → image note (§9)

**Textarea selection still copies plain text.** When editing inside a textarea,
the dispatcher gates out (`isEditableTarget`), so `Mod+c` is the browser's native
plain-text copy. Studio's rich card-copy runs only when a card is selected and
you're *not* editing.

### 7.3 Studio-native payload — HTML flavor

Write **two flavors** on copy via the async Clipboard API (no Rust plugin if the
webview cooperates):

```js
navigator.clipboard.write([ new ClipboardItem({
  "text/html":  new Blob([richHtml], { type: "text/html" }),  // embeds note JSON
  "text/plain": new Blob([degraded], { type: "text/plain" }), // §7.2 degraded form
})]);
```

- The note JSON (type + content + theme/fonts/span) is embedded in the
  `text/html` flavor (e.g. a `<script type="application/studio-notes">` blob or
  `data-studio` attribute) alongside human-readable HTML.
- **Studio paste** reads `text/html`, finds the JSON → reconstructs notes.
  External apps get rich text (HTML) or plain text. Plain-text-only sources fall
  through to the §7.2 text-parsing path.
- **Risk:** verify `navigator.clipboard.read()` returns `text/html` (and that
  `write` accepts `image/png`) in the Tauri WKWebView — there's history of
  `readText()` being finicky (hence the `pbpaste` workaround). If read fails, add
  a Rust read-path command; write stays in JS.
- For image notes, the embedded JSON references an asset; cross-project paste
  must materialize the file into the destination's `notes/` (§9.5).

---

## 8. Drag & Drop

### 8.0 Constraint

Tauri's native file-drop (`dragDropEnabled: true`) **swallows HTML5
`dragover`/`drop`** in the webview. Rules:
- **External file drops** use the Tauri `drag-enter/over/leave/drop` events.
- **Internal reordering** uses **pointer events** (as Notes card reorder does) —
  never HTML5 DnD.
- An internal pointer-drag sets a flag (`internalDragActive`) that **suppresses
  the external file-drop overlay**.

### 8.1 External file drop (OS files → app)

Behavior is driven by **what is dropped**, not which panel it lands on. The only
context split is overview vs an open project.

**In an open project window** (drop anywhere):
| Dropped | Behavior |
|---|---|
| Image file | move into project `media/` (any panel). Image notes are made via paste / internal drag only (§9.4), never by external file drop. |
| Non-image file | move into the project folder |
| Folder | add a **folder entry to the Workspace** with an **Open-in-Finder** action; references the path, doesn't move/copy it |

**On the Projects overview** (no project open):
| Dropped | Behavior |
|---|---|
| Folder | add as a project, referencing the folder in place |
| File | ignore |

**New Workspace list type:** add `folders` to `LIST_META` (icon `folder_open`,
label "Folder") holding folder paths; row action opens in Finder
(`reveal_in_finder` / `open_path`). This is the file-vs-folder differentiation:
files move in, folders get referenced + an open action.

**Overlay:** keep the single dropzone overlay, labeled by what's dropped / where
("Move image to Media", "Add folder to Workspace", "Add project"). The handler
classifies each path (image-file / other-file / folder) and routes.

### 8.2 Internal drag (pointer-based)

| Panel | Internal drag |
|---|---|
| Notes | reorder cards (done; horizontal indicator between column items) |
| Media | manual reorder; add sort-toggle buttons (default sort + manual override) |
| Projects | reorder tiles |
| Cross-panel | drag a media tile into the Notes tab → create an image note (references the `media/` file in place, §9.1) |

### 8.3 Drag + selection interplay

When a drag starts on an item:
- if the item **is** in the current selection → drag the **whole selection**;
- if it's **not** selected → `sel.set(item)` first, then drag just it.

---

## 9. Image notes (data model)

Store the image as a **file** (never inline base64), in a dedicated `notes/`
folder, separate from `media/` so note images don't appear in the Media tab.

### 9.1 Project layout

```
<project>/
  media/                 # Media-tab images (unchanged)
  notes/                 # image-note asset files
    <noteId>.<ext>
  notes.json             # at project root; references files
  .<file>.studio.json    # edit sidecars (media only)
```

`notes.json` holds a **reference**, never bytes. `src` may point into **either**
`notes/` (note-owned) **or** an existing `media/` file:

```jsonc
{
  "kind": "image",
  "id": "n…",
  "src": "notes/n….png",   // project-relative; may also be "media/foo.png"
  "w": 1200, "h": 800,      // natural size (bento row-span sizing)
  "caption": "",
  "theme": "…", "span": 1
}
```

**Don't duplicate files already in the project.** An image already in the project
(e.g. a `media/` file) is referenced **in place** — no copy. Only images from
*outside* the project (clipboard, external file) are written into `notes/`.

### 9.2 Display

- Render via `convertFileSrc(<project>/<src>)` directly — image notes are shown,
  not edited, so they skip the Media WebGL/thumbnail pipeline.
- `w`/`h` feed bento row-span sizing so the card reserves height before load.
- (Later, optional) bake a perf thumbnail if needed.

### 9.3 Rust commands + lifecycle

- `import_note_image(project_path, file) -> src` — copy an **external** file into
  `notes/`; if the file is already inside the project, just reference it.
- `paste_note_image(project_path) -> src` — write a clipboard image into `notes/`
  (mirrors `paste_image`, different dir).
- **Deletion is path-scoped:** deleting an image note removes its asset **only if
  `src` is under `notes/`**. A `media/` reference is left alone (owned by Media).
  Ownership is decided by folder — no reference-counting.

### 9.4 Creation paths

- **Paste** a clipboard image in Notes → `paste_note_image` → image note.
- **Internal drag** of a media tile into the Notes tab → image note referencing
  the `media/` file in place (§8.2).
- **External image-file drop does NOT create an image note** — it goes to
  `media/` (§8.1).
- No toolbar "Image" add-button (paste / drag only).

### 9.5 Copy/paste of image notes

- **In Studio:** the Studio-native payload references the asset. Same-project
  paste reuses the file in place (`notes/…` or `media/…`). **Cross-project** paste
  copies the file into the destination's `notes/` and rewrites `src` — regardless
  of source folder (the dest may lack that media file). "Copy carries a file."
- **Outside Studio:** degrade to the raw image on the system clipboard (no
  theme/caption).

---

## 10. Project icons

Lightweight, convention-file based — no metadata store, no `list_projects` change.

- **Storage:** a hidden file `<project>/.studio-icon.png`. Dot-prefixed → already
  skipped by `scan_projects`, and it travels with the folder.
- **Display:** the overview card renders
  `<img src=convertFileSrc(<project>/.studio-icon.png)>` with `onerror` → fall
  back to the letter/initial avatar. The load failure *is* the existence check,
  so display needs no Rust change. (Later, optional: bake a ~256px square via
  `quicklook_thumb` for large grids.)
- **Setting:** select a project, then `Mod+v` with a clipboard image → new Rust
  command `set_project_icon(project_path)` writes `.studio-icon.png` and repaints
  the card. No-op if no clipboard image / no single project selected.

---

## 11. Open items

Genuinely undecided, plus implementation risks to verify.

**Decisions still open**
1. Media `Shift+Mod+v` = force-import clipboard image? (`Mod+v` is shadowed by
   adjustments-paste while `copiedEdits` is held.) (§7.1)
2. Confirm external copy of an image note = raw image on clipboard (not a file
   reference). (§9.5)
3. Image-note caption — show/edit UI now, or schema-only for later? (§9)
4. Image-note filename in `notes/` — `<noteId>.<ext>` (recommended: collision-free,
   trivial orphan cleanup) vs original name. (§9.1)
5. Media sort-toggle — which sorts (date / name / …) and the default? (§8.2)
6. Project icon: a reset/remove action to delete `.studio-icon.png`? (§10)
7. Project icon: non-square images — center-crop to square on set, or letterbox
   in the card? (§10)

**Implementation risks to verify (not decisions)**
- WKWebView async Clipboard API: `write` with `image/png`, and `read` of
  `text/html`. Rust fallback for whichever direction fails. (§7.1, §7.3)
