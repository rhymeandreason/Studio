# Slides

A presentation builder, built as Studio tools on top of the **artifact** model
(see [artifacts.md](artifacts.md)). A deck is a `presentation` artifact;
Claude authors it, the **Slides** tool edits it, the Artifacts panel previews it.
Themes are their own reusable artifact kind with a dedicated editor.

Pieces:
- **Shared renderer** — `src/deck/render.js` + `render.css`. One source of truth
  for turning a slide + theme into a 1280×720 `.slide` element.
- **Slides** tool — `src/tools/slides.html`. The deck editor.
- **Theme editor** — `src/tools/theme-editor.html`. Edits `theme` artifacts.
- **Presets** — `src/deck/themes/*.json` (+ `index.json`), the built-in themes.
- **Artifacts panel** — `src/artifacts.js` registers both kinds (preview cards,
  toolbar buttons, editor mapping).

## Shared renderer (`src/deck/`)

`render.js` exports a **pure** `renderSlide(slide, theme, resolved)` → DOM
element. It's pure in the sense that images come from a `resolved` map
(`{ ref → url }`) the caller supplies — no I/O. It also exports `colorScheme`,
`SCHEMES`, `HEADING_DEFAULT`, the size-scale multipliers (`HEADING_SCALES` /
`BODY_SCALES` — **tune these to retune every slide's S/M/L/XL**), `PREVIEW_SLIDES`
(one sample slide per layout, for theme previews), and `loadPresets()`.

`render.css` holds the `.slide` / `.l-*` styles, scoped under `.slide` so they
serialize into web exports verbatim. Per-slide CSS vars (`--deck-bg`,
`--deck-heading`, `--body-scale`, …) are set inline by `renderSlide`; the
stylesheet reads them.

Consumers must load `window.marked` (vendored) and link `render.css`. Three use
it today: the Slides editor, the Theme editor, and `artifacts.js`'s deck preview
(the panel approximates a first-slide preview without linking render.css, so it
re-derives the scheme palette in `deckSchemePalette`).

**Changing how slides render** → edit `render.js`/`render.css`, not the tools.

## Data model

### `presentation` artifact (`artifacts/presentation/<slug>.json`)
```
{ kind, version, name, theme, slides: [ {layout, ...slots} ], savedAt }
```
- **`theme`** — `{ fonts:{heading,body:{family,weight}}, colors:{bg,surface,text,
  muted,accent,accent2}, headingSize, bodySize }`. Embedded inline (decks don't
  link to a theme artifact — applying a theme copies it in).
- **`slides[]`** — each has a `layout` plus that layout's slots, and optional
  per-slide modifiers.

### Layouts and slots
Defined across a few coordinated places in `slides.html` (the `LAYOUTS` map,
`renderSlide`'s switch in `render.js`, the `.l-*` CSS, `layoutIcon`,
`SLIDE_DEFAULTS`, `PRIMARY_BODY`). Current set:

| layout | slots |
|---|---|
| `title` | `title`, `subtitle` |
| `section` | `title`, optional `image` (full-bleed bg), optional `caption` |
| `title-body` | `title`, `body` (+ `columns`: 1/2) |
| `two-col` | `title`, `left`, `right` |
| `three-col` | `title`, `left`, `middle`, `right` |
| `quote` | `quote`, `attribution` |
| `image-full` | `image`, optional `caption` |
| `image-text` | `title`, `image`, `body`, optional `caption` |

Body-type slots (`body`/`left`/`middle`/`right`) are **Markdown** (bold, lists,
links, `##`/`###`, blockquote, `code`, `---`; `**bold**` → accent color). `image`
slots are **project-relative paths** (e.g. `media/x.png`) — or a **diagram
artifact ref** (`artifacts/diagram/x.json`), which renders live re-themed to
the deck and inlines as SVG in exports (see [diagrams.md](diagrams.md)).

### Per-slide modifiers
- **`colorScheme`** — `light` (default) / `soft` / `dark` / `accent` / `accent2`.
  Each derives a full palette from the theme's 6 colors (`colorScheme()` in
  render.js); `section` defaults to `accent`.
- **`headingSize`** `s`/`m`/`l`/`xl` and **`bodySize`** `s`/`m`/`l` — scale from
  the theme's `headingSize`/`bodySize` base; each layout sets a default heading
  level (`HEADING_DEFAULT`).
- **`imageFit`** `cover`/`contain`, **`listStyle`** `bullets`/`cards`,
  **`columns`** 1/2 (title-body).

The format is mirrored for Claude in `skills/studio-artifacts/SKILL.md` — **change
a saved shape → update the skill.**

## Themes

A `theme` artifact (`artifacts/theme/<slug>.json`) is the deck's `theme` block
saved on its own so it's reusable. Same shape (plus `kind`/`name`/`savedAt`).

- **Presets** are files in `src/deck/themes/` listed by `index.json`, loaded via
  `loadPresets()`. **Add a preset** = drop a `*.json` there and add it to
  `index.json`. (Author one in the Theme editor → "Save as new theme" → move the
  file from the project's `artifacts/theme/` into `src/deck/themes/`.)
- The Slides **Theme tab** lists project theme artifacts (each with an Edit
  button) + the presets; picking one copies it onto the deck. **Edit theme**
  opens the editor seeded with the deck's current theme (via a `theme=<json>`
  query param); **New theme** opens it empty.
- Exactly one card is marked active — the exact card you picked (`appliedThemeKey`,
  `markActiveThemeCards`), so a project theme that shares a preset's name doesn't
  steal the highlight.

### Theme editor (`theme-editor.html`)
Brand-Explorer-style font browser on the left (search + category chips + Head/Body
assign); a controls bar (name, weights, the six colors, H/B base sizes) over a
live **multi-layout preview grid** rendering `PREVIEW_SLIDES` with the current
theme. Save overwrites the open artifact (or creates one); Save as new always
creates. No auto-save.

## Editing UX (`slides.html`)

- **Three panes** — slide reel (left), scaled canvas (center), inspector (right;
  Slide / Theme tabs).
- **Click-to-edit on the canvas** — text regions carry `data-slot`; clicking
  edits in place. Markdown slots show raw source while focused and re-render on
  blur (read via `innerText` so line breaks survive). Click off to commit;
  regions are non-selectable until focused so dragging doesn't select text. The
  highlight ring uses `currentColor` (visible on dark slides).
- **Reel** — multi-select (click / cmd-toggle / shift-range) and pointer-based
  drag reorder with a drop indicator (HTML5 drag is swallowed in Tauri windows).
  Backspace/Delete removes the selection (keeps ≥1 slide).
- **Stage control bar** (above the canvas) — image (picker + drop/paste + fit +
  caption), heading/body size, columns, list style — only the controls the
  current layout uses.
- **Images** — Browse opens a grid of the project's `media/`; drop a file or
  paste imports into `media/` (reuses `list_media` / `import_media` /
  `paste_image`). Stored project-relative; resolved to data URLs via
  `read_image_data`.
- **Overflow** — content that exceeds the slide spills below the edge in the
  editor (dimmed by a veil); the export still clips.
- **Auto-save** — debounced, content-fingerprinted (navigation doesn't churn the
  file); creates the artifact on first edit. **Live-reload** — listens for
  Studio's `fs-changed` to pick up Claude's external edits (guarded against its
  own writes and unsaved local edits) and to refresh the Theme tab.

## Export

Web export (`save_export_dir`) writes `designs/<deck>/index.html` + an `assets/`
folder of copied images. The HTML is self-contained: arrow-key/space navigation,
the theme's page background, a nav pill, and `@page` print CSS (one slide per
page) so the browser's Save-as-PDF works on it. The slide CSS is fetched from
`render.css` at export time. PDF is intentionally browser-print only (no in-tool
button).

## Files
- `src/deck/render.js`, `render.css`, `themes/*.json` + `index.json`
- `src/tools/slides.html`, `src/tools/theme-editor.html`
- `src/artifacts.js` (panel registration + preview cards)
- `skills/studio-artifacts/SKILL.md` (format docs for Claude)
- Rust: reuses `save_export_dir`, `save_artifact` / `overwrite_artifact` /
  `read_artifact` / `list_artifacts`, `list_media` / `import_media` /
  `paste_image` / `read_image_data` (`src-tauri/src/lib.rs`).
