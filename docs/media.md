# Media + Image Editor

Image edits are **non-destructive**: stored in `<image>.studio.json` sidecars
next to each file, baked only on export.

## Where the editor lives

The edit surface (geometry/crop/tonal) plus the **Export**, **Remove background**,
and **Extend background** modals are a reusable controller in
[`src/editor.js`](../src/editor.js), shared by two hosts:

- the **media panel's lightbox** (`media.js` handles the grid, selection, and
  the open/close transitions, then drives `editor.js`), and
- the standalone **Image Editor tool** ([`src/tools/image-editor.html`](../src/tools/image-editor.html)) —
  open any image via the picker; edits persist to the same sidecar.

`editor.js` keeps using `document.getElementById` because the two hosts are
separate documents (each just needs the editor + modal markup with matching
ids). Grid-specific behaviour (live tile thumbnails, grid reloads, thumb
invalidation) is injected via `setEditorHooks({ livePreview, optimisticThumb,
afterWrite, invalidateThumb })`; the tool leaves them as no-ops. The pure
geometry helpers live in `imageutil.js`; the WebGL tonal pipeline in `gl.js`.
The tool reuses the app's `styles.css` for the editor/lightbox/modal styling.

### ⚠️ Duplicated markup — keep the two copies in sync

Only the **JS** (`editor.js`) is shared. The **HTML markup** the controller
drives is *duplicated* across both documents:

- media panel: [`src/index.html`](../src/index.html) — the `#lightbox` / `#editor`
  panel (`#crop`, rotate/flip/straighten, `#tonal-sliders`, Background buttons)
  plus the `#cutout`, `#extend`, and `#webexport` modals.
- tool: [`src/tools/image-editor.html`](../src/tools/image-editor.html) — its own
  copy of the same markup.

The contract: **both documents must contain the same element ids** that
`editor.js` looks up (`editor-canvas`, `crop`, `ed-rotl`/`ed-rotr`/`ed-fliph`/
`ed-flipv`, `ed-straighten`, `[data-aspect]`, `tonal-sliders`, `lb-export`/
`lb-replace`/`lb-webexport`, `ed-removebg`/`ed-extendbg`/`ed-photos`, the
`#cutout`/`#extend`/`#webexport` modal internals, `edit-status`,
`lightbox-name`). Add/rename/remove any of these → **update both HTML files**,
or the host missing the id silently breaks (or throws on a null lookup).

CSS is *not* duplicated — both pull from `styles.css`.

If this drift risk becomes annoying, the de-dup move is to generate the markup
from a `buildEditorDOM()` in `editor.js` (or a small template module) that both
hosts inject, so structure lives in one place. Not done yet — two inline copies
were the lighter v1.

Editor: geometry (crop/rotate/straighten) + 7 tonal sliders via a **WebGL
shader**; thumbnails for edited images are baked + disk-cached
(`$APPCACHE/edited-thumbs`), unedited use QuickLook.

FSEvents (`notify`) emits `fs-changed`; the grid **reconciles** on this event
— don't rebuild it from scratch, that previously caused duplicated tiles.

## Editor sidebar

Toolbar toggle (tune icon), off by default. `editorSidebarEnabled` is mirrored
onto `state.editorSidebarEnabled` so `main.js` can gate the tab-switch restore.
`⌘C` copies the image when sidebar is off, adjustments when on. `⌘⇧C` always
copies the image.

## Crop

Aspect row starts with **None** (default; hides the overlay). **Free** initialises
to full image bounds if no crop is set.

**Asset protocol:** images display via `convertFileSrc()`. The scope in
`tauri.conf.json` (`assetProtocol.scope`) must list paths — note that the
glob `**` does **not** match leading-dot files, so dotfiles (e.g.
`.studio-icon.png`) need an explicit scope entry.

## Drag-out

Plain-drag a tile to hand the real file(s) to macOS via `tauri-plugin-drag` —
`startNativeFileDrag`/`makeDragIcon`. Option-drag copies instead of moving,
matching the File Directory. The **internal** gesture — reorder within the grid,
and dropping an image tile onto the Notes tab to make an image note — is on
**⌘-drag**, since dragging out is much the more common intent.

**Never call `window.__TAURI__.drag.startDrag`.** The plugin's global wrapper
ships its own inlined `Channel` that expects a `{message, id}` envelope this
Tauri version no longer sends, so its drop callback throws `undefined is not an
object (evaluating 'o.toString')` at the end of every drag. Invoke the command
directly with Tauri's own `Channel` instead — all three drag-out surfaces
(media, notes, `dragFilesOut` in `kit/app.js`) do:

```js
const onEvent = new window.__TAURI__.core.Channel();
onEvent.onmessage = (e) => { if (e.result === "Dropped") … };
await invoke("plugin:drag|start_drag", { item: paths, image: iconDataUrl, options: { mode: "move" }, onEvent });
```

Note the key names differ from the wrapper's: `image`, not `icon`, and `mode`
nested under `options`.

**Dropping into Finder moves the file out of `media/`**, and Studio has to do
that itself. `mode: "move"` only sets the drag session's *source* mask; macOS
gives the destination the final say and Finder answers cross-app file drags with
Copy regardless, so the mode flag alone can never move anything.

So the drag's `onEvent` callback calls `finish_drag_out` (lib.rs) on drop — the
shared command, also used by `dragFilesOut` in `kit/app.js`:

1. It samples **which app is under the cursor** — the `winowner` Swift helper
   (`CGWindowListCopyWindowInfo` + live `NSEvent.mouseLocation`, reporting
   "Finder" for the bare Desktop). Sampled first, before any waiting, because
   the cursor wanders off the destination almost immediately.
2. Only if that's Finder does it remove the source, after a ~900ms grace period
   so Finder's copy has read the bytes first. Everywhere else — a web upload
   zone, a file picker — the source is left alone, because deleting it there
   would be real data loss.
3. Either way the hidden edits sidecar goes with the file, and removals go to
   the **Trash**, so a misfire is recoverable.

If anything left, the grid reloads.
