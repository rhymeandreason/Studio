# Media + Image Editor

Image edits are **non-destructive**: stored in `<image>.studio.json` sidecars
next to each file, baked only on export.

Editor: geometry (crop/rotate/straighten) + 7 tonal sliders via a **WebGL
shader**; thumbnails for edited images are baked + disk-cached
(`$APPCACHE/edited-thumbs`), unedited use QuickLook.

FSEvents (`notify`) emits `fs-changed`; the grid **reconciles** on this event
— don't rebuild it from scratch, that previously caused duplicated tiles.

## Editor sidebar toggle

A **tune** icon button in the media toolbar (right of the sort filters)
shows/hides the editor sidebar. Off by default — selecting an image no
longer auto-opens the panel.

`editorSidebarEnabled` is a module-local `let` mirrored onto `state.editorSidebarEnabled`
so `selectTab` in `main.js` can gate the sidebar restore on tab switch.

**Keyboard:** when the sidebar is **off**, `⌘C` copies the high-res image
bitmap. When **on**, `⌘C` copies adjustments (existing behaviour).
`⌘⇧C` always copies the image regardless of sidebar state.

## Crop

The crop aspect row now starts with a **None** button (default, selected
when `editState.crop === null`). The crop overlay is hidden while None is
active. Clicking **Free** with no prior crop initialises to full image
bounds.

**Asset protocol:** images display via `convertFileSrc()`. The scope in
`tauri.conf.json` (`assetProtocol.scope`) must list paths — note that the
glob `**` does **not** match leading-dot files, so dotfiles (e.g.
`.studio-icon.png`) need an explicit scope entry.
