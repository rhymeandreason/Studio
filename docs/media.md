# Media + Image Editor

Image edits are **non-destructive**: stored in `<image>.studio.json` sidecars
next to each file, baked only on export.

Editor: geometry (crop/rotate/straighten) + 7 tonal sliders via a **WebGL
shader**; thumbnails for edited images are baked + disk-cached
(`$APPCACHE/edited-thumbs`), unedited use QuickLook.

FSEvents (`notify`) emits `fs-changed`; the grid **reconciles** on this event
— don't rebuild it from scratch, that previously caused duplicated tiles.

**Asset protocol:** images display via `convertFileSrc()`. The scope in
`tauri.conf.json` (`assetProtocol.scope`) must list paths — note that the
glob `**` does **not** match leading-dot files, so dotfiles (e.g.
`.studio-icon.png`) need an explicit scope entry.
