# File Directory

`src/tools/file-directory.html` — the project's file tree, with Finder's
interaction model. Lazy `list_dir` expansion; expanded folders persist per
project in `localStorage`. Mutations live in `src-tauri/src/files.rs`
(`fs_move` / `fs_rename` / `fs_trash` / `fs_duplicate` / `fs_new_folder`) —
deliberately path-based and project-unaware, so any tool can reuse them.

## Interactions

| Gesture | Result |
| --- | --- |
| Click | Select (Cmd-click toggles, Shift-click ranges) |
| Double-click | Open — artifact editor, Code Editor, or Reveal in Finder |
| Click twirl | Expand/collapse (still single-click) |
| Drag | Out to Finder **moves** the file(s) out of the project; Option-drag copies. To a file picker or web drop zone it's always a copy |
| Drop | Moves the dropped paths into the folder under the cursor |
| Right-click | Open · Reveal · Rename · Duplicate · New Folder · Copy Path · Trash |
| Enter | Inline rename (stem selected, extension left alone) |
| ↑ ↓ | Move selection · → ← expand/collapse |
| Cmd+Z | Undo the last move |
| Cmd+Delete | Move to Trash · Cmd+Shift+N New Folder · Cmd+Opt+C copy path |

## Drag and drop

There is **one** drop path. A drag started in the tree leaves the window as a
real macOS drag session (`tauri-plugin-drag` via `dragFilesOut`) and re-enters
as an OS drop, so internal moves and drops from Finder are the same code:
`tauri://drag-over` hit-tests `elementFromPoint` to highlight the destination
folder, and `tauri://drag-drop` calls `fs_move`.

**Coordinate gotcha:** Tauri types the drag payload's `position` as
`PhysicalPosition`, but on macOS wry hands through AppKit points
(`convertPoint:fromView:nil`) — they are *already* CSS pixels. Dividing by
`devicePixelRatio` puts the hit-test half a window too high.

Hovering a closed folder for 700ms spring-loads it open, so you can drill down
mid-drag.

Dragging **out** to Finder removes the source, which Studio has to do itself —
`dragFilesOut(paths, { move: true })` in `kit/app.js` waits on the drop and calls
`finish_drag_out`, which only removes when the drop actually landed in Finder.
See the drag-out section of [media.md](media.md) for why the OS can't be asked
to do it.

### Embedded as the Files tab

The same page runs as an `<iframe>` in the main window, which breaks drag two
ways — both fixed, both easy to re-break:

- **Plugin globals are main-frame only.** Tauri injects `window.__TAURI__.drag`
  (and every other plugin's global) into the top-level webview *only*, so an
  embedded tool must borrow its parent's — that's what `findTauri()` in
  `src/kit/app.js` is for. Never reach for `window.__TAURI__.<plugin>` directly
  in a tool; use the `kit/app.js` helpers.
- **Drop positions are window-relative.** Subtract `window.frameElement`'s
  bounding rect before `elementFromPoint`, or every drop hit-tests the wrong row
  (on top of the CSS-pixel gotcha above).

While the Files tab is open, `media.js`'s project-wide drop routing stands down
(`blocked()` checks `state.activePanel === "files"`) so the two don't both act
on one drop.

## Notes

- Selection is a `Set` of **paths**, not elements: `fs-changed` tears the tree
  down and rebuilds it wholesale, so element identity doesn't survive.
- Undo is just the inverse move — `fs_move` returns `{from, to}` per item and
  the frontend replays it backwards. Nothing is stored in Rust.
- Deletes always go to the system Trash, never `remove_*`.
- `fs_move` refuses to move a folder into its own descendant, and skips items
  already living in the destination (so a stray drop is a no-op, not a
  rename to `name-1`).
