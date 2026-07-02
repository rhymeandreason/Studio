# Diagrams

A concept-diagram maker, built as a Studio tool on the **artifact** model (see
[artifacts.md](artifacts.md)) — for explaining ideas in slides and webpages.
A diagram is a `diagram` artifact; Claude authors it, the **Diagram** tool
edits it, the Artifacts panel previews it live, and the Slides tool can embed
it on any slide.

Pieces:
- **Shared renderer** — `src/diagram/render.js`. One pure function
  (`renderDiagram(diagram, opts)`) turning a diagram + theme into a 1200×675
  SVG. No CSS file — everything is baked into the SVG so it's portable.
- **Diagram** tool — `src/tools/diagram.html`. The editor.
- **Artifacts panel** — `src/artifacts.js` registers the kind (real-render
  preview card, toolbar button, editor mapping).
- **Slides embed** — diagram refs in image slots, resolved by `slides.html`,
  inlined by `src/deck/render.js`.

## Shared renderer (`src/diagram/render.js`)

`renderDiagram(diagram, opts)` → `<svg>` element. Pure, no I/O. The SVG has a
`viewBox` but **no width/height**, so it scales to whatever container it lands
in; `diagramSvgText()` adds explicit dimensions + a Google Fonts `@import` for
standalone `.svg` export. Also exports `TEMPLATES`, `TEMPLATE_DEFAULTS` (the
starter data per template — the shape contract), `contentRect` / `matrixInset`
(geometry helpers the tool uses for drag math), and `mix` (JS color-mix, since
SVG can't use CSS `color-mix()`).

- `opts.theme` overrides the diagram's embedded theme — this is how slide
  embeds re-theme to the deck. `opts.scheme` likewise; `opts.transparent`
  skips the background rect.
- Text is laid out with `<foreignObject>` (HTML wrapping). Fine everywhere we
  render (webviews, browsers, web exports); native SVG apps (Keynote, Figma
  import) won't show it — the export story is browser-first, same as Slides.
- Marker ids are uniqued per render (`ctx.uid`) so several inline diagrams on
  one page don't collide.

**Changing how a template draws** → edit its `render*` function here, not the
tool.

## Data model (`artifacts/diagram/<slug>.json`)

```
{ kind, version, name, title?, template, theme, colorScheme?, transparentBg?,
  data: {…template-specific…}, offsets?: { "<elemId>": {dx,dy} }, savedAt }
```

- **`theme`** — same shape as a presentation theme (fonts + 6 colors); the
  Theme tab applies theme artifacts/presets, Edit theme opens the Theme editor.
- **`template`** + **`data`** — `flow` (nodes + links, auto-layered layout,
  back-links bow around), `compare` (2–4 panels, "vs" badge at 2), `matrix`
  (axis labels + items at 0–1 fractions), `venn` (2–3 sets + overlap label),
  `timeline` (events alternating above/below), `hierarchy` (a `root` tree).
  Full field-by-field contract in `skills/studio-artifacts/SKILL.md` —
  **change a saved shape → update the skill.**
- **`offsets`** — the hybrid-editing half: per-element pixel nudges keyed by
  element id (`n:<nodeId>`, `c:<i>`, `e:<i>`, `s:<i>`, `h:<path>`). The
  template computes base positions; offsets displace them (links/connectors
  track the displaced positions). Matrix items are the exception — dragging a
  pill edits its semantic `x`/`y`, not an offset.

## Editing UX (`diagram.html`)

Two panes: stage (scaled canvas) + inspector (Design / Theme tabs). On the
canvas: **click** selects (dashed ring), **drag** nudges (or places, for
matrix pills), **double-click** renames in place, **Backspace** deletes the
element (flow nodes take their arrows with them; the hierarchy root can't be
deleted). The inspector has the template grid, color-scheme chips, the
per-template content form (steps/arrows, panels, axes, sets, events, or an
indented-text tree editor), and a Layout section with the nudge count + reset.
Switching templates parks the outgoing template's data in memory, so exploring
templates doesn't destroy work (only the active template is saved).

Auto-save + fs-changed live-reload follow the Slides pattern (debounced,
content-fingerprinted, external edits adopted only when there are no local
unsaved changes).

## Getting diagrams out

- **SVG export** — writes `designs/<slug>.svg` via `save_tool_export`
  (standalone: explicit size + font `@import`). **Copy SVG** puts the same
  markup on the clipboard for pasting into code. "Transparent background on
  export" drops the bg rect.
- **Slide embed** — set any image slot to the diagram's project-relative path
  (`artifacts/diagram/<slug>.json`); the Slides media picker lists project
  diagrams under the images. `slides.html` resolves such refs by reading the
  artifact and rendering **with the deck's theme** (cached; invalidated on
  theme change and fs-changed), and `deck/render.js` inlines SVG-markup
  resolutions instead of `<img>` so fonts inherit and web exports carry the
  diagram verbatim. Editing a diagram while a deck that embeds it is open
  updates the deck live.

## Files
- `src/diagram/render.js`
- `src/tools/diagram.html`
- `src/artifacts.js` (panel registration + `diagramPreview`)
- `src/deck/render.js` + `render.css` (inline `.svg-media` handling)
- `src/tools/slides.html` (diagram refs, picker section, export inlining)
- `skills/studio-artifacts/SKILL.md` (format docs for Claude)
- Rust: none — reuses `save_artifact` / `overwrite_artifact` / `read_artifact`
  / `list_artifacts` / `save_tool_export`.
