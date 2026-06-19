# Media + Image Editor

Image edits are **non-destructive**: stored in `<image>.studio.json` sidecars
next to each file, baked only on export.

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
