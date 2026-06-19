# Notes

Stored in `notes.json` per project; `state.notesData` is the in-memory store,
`renderNotes()` fully re-renders the bento grid from it. Note kinds: `text` /
`checklist` / `table` / `image`.

Image notes store a project-relative `src` (`notes/<id>.<ext>` for note-owned
assets, or `media/…` referenced in place) — never inline base64.

Text notes can have one optional attached image stored as `note.image`
(project-relative path, same `notes/<id>.<ext>` convention). `note.imageW` /
`note.imageH` hold the natural pixel size for aspect-ratio reservation.
Paste an image while the note's textarea is focused (Cmd+V) to attach it;
it appears above the body text. Hover the image to reveal an × remove button.
Deleting the note also deletes the asset via `delete_note_asset`.

Per-note styling (theme/fonts/span) is applied as scoped CSS variables on the
card; the project-wide font preference is `notesData.font`/`fontSize` via
`--notes-font`/`--notes-font-size` on `#notes-list`.

`notesData.viewMode` (`"bento"` or `"days"`) is also persisted per project —
toggled via the `#notes-view-toggle` buttons.

The grid is a **bento layout** — `layoutBento()` measures card heights and
sets row-spans, so re-pack on any height change (and after a panel becomes
visible — hidden elements measure as 0).

**Copy/paste:** Notes copy/paste carries a Studio-native payload via an
**app-cache sidecar file** (`set_note_clipboard`/`get_note_clipboard`) keyed
to the degraded clipboard text — WebKit strips custom HTML on clipboard
write, so an HTML flavor can't carry it.
