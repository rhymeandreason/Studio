# Diagrams

A concept-diagram maker for slides and webpages, built on the **artifact**
model (see [artifacts.md](artifacts.md)). A diagram is a `diagram` artifact
(`artifacts/diagram/<slug>.json`): Claude authors it, the **Diagram** tool
edits it, the Artifacts panel previews it live, and Slides can embed it.

Pieces: shared renderer `src/diagram/render.js` · editor
`src/tools/diagram.html` · panel registration in `src/artifacts.js` · slide
embedding in `slides.html` + `src/deck/render.js`. No Rust — reuses the
artifact commands and `save_tool_export`.

## Format

`{ kind, version, name, title?, template, theme, colorScheme?, transparentBg?,
data, offsets?, savedAt }` — six templates (flow, compare, matrix, venn,
timeline, hierarchy), each with its own `data` shape. **The field-by-field
contract lives in `skills/studio-artifacts/SKILL.md`** (starter shapes:
`TEMPLATE_DEFAULTS` in render.js) — change a saved shape → update the skill.
`theme` is the deck-theme shape; `colorScheme` the same light/soft/dark/accent
derivation slides use.

**`offsets` is the hybrid-editing half**: per-element pixel nudges
(`{dx,dy}` keyed by element id — `n:<nodeId>`, `c:<i>`, `e:<i>`, `s:<i>`,
`h:<path>`). Templates compute base positions; offsets displace them, and
connectors track the displaced positions. Exception: dragging a matrix pill
edits its semantic `x`/`y`, not an offset. "Reset layout" clears all nudges.

## Renderer (`src/diagram/render.js`)

`renderDiagram(diagram, opts)` → `<svg>`. Pure, no I/O; viewBox but **no
width/height**, so it scales to any container (`diagramSvgText()` adds
dimensions + a font `@import` for standalone export).

- `opts.theme` / `opts.scheme` override the embedded ones — how slide embeds
  re-theme to the deck. `opts.transparent` skips the bg rect.
- Text uses `<foreignObject>` (HTML wrapping): fine in every browser context,
  invisible in native SVG apps (Keynote, Figma import). Browser-first, like
  the Slides export story.
- Marker ids are uniqued per render so multiple inline diagrams on one page
  don't collide.

**Changing how a template draws** → its `render*` function here, not the tool.

## Editing UX (`diagram.html`)

Canvas: click selects, drag nudges (or places, for matrix pills), double-click
renames in place, Backspace deletes (flow nodes take their arrows with them;
the hierarchy root is undeletable). Inspector: template grid, scheme chips,
per-template content forms (hierarchy edits as an indented-text tree), nudge
count + reset. Switching templates parks the outgoing template's data in
memory — only the active template is saved. Auto-save + fs-changed live-reload
follow the Slides pattern.

## Output

- **SVG export** → `designs/<slug>.svg`; **Copy SVG** → clipboard; optional
  transparent background.
- **Slide embed** — any image slot accepts `artifacts/diagram/<slug>.json`
  (the Slides media picker lists project diagrams). slides.html renders the
  ref **with the deck's theme** (cached; invalidated on theme change and
  fs-changed); deck/render.js inlines SVG-markup resolutions instead of
  `<img>` so fonts inherit and web exports carry the diagram verbatim. SVG
  media defaults to `contain` — diagrams shouldn't crop. Editing a diagram
  updates open decks live.
