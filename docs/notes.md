# Notes

`notes.json` per project; `state.notesData` in memory, `renderNotes()` fully re-renders. Kinds: `text` / `checklist` / `table` / `image`.

**Images:** Image notes use `note.src`; text notes can have one optional `note.image` (both project-relative `notes/<id>.<ext>`, never base64). `note.imageW`/`imageH` reserve aspect ratio. Paste (Cmd+V) into a focused text note textarea to attach above the body; hover to reveal ×. Deletion cleans up the asset.

**Styling:** Per-note theme/font/span as scoped CSS variables on the card; project-wide font via `--notes-font`/`--notes-font-size` on `#notes-list`. `notesData.viewMode` (`"bento"` or `"days"`) is persisted.

**Layout:** `layoutBento()` measures card heights and sets row-spans — re-pack on any height change, and after the panel becomes visible (hidden elements measure 0).

**Copy/paste:** Studio-native payload via app-cache sidecar (`set_note_clipboard`/`get_note_clipboard`) keyed to clipboard text — WebKit strips custom HTML flavors.
