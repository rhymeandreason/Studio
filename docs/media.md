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
