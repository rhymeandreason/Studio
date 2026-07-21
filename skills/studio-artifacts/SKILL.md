---
name: studio-artifacts
description: Create or edit Studio design artifacts — brand kits (font pairings + color palettes), slide decks/presentations, diagrams (flow, compare, 2x2 matrix, venn, timeline, hierarchy), and other design specs stored as JSON under a project's artifacts/ folder. Use when asked to generate, brainstorm, or modify brand kits, palettes, presentations/slides, diagrams, or design directions for a Studio project.
---

# Studio design artifacts

Studio (a macOS design app) stores design decisions as JSON **artifacts** under
`artifacts/<kind>/<name>.json` in the current project. Studio's Artifacts panel
shows them live and opens each in its editor tool. When asked to create or
brainstorm artifacts, **write the files directly** into `artifacts/<kind>/` —
no need to ask where.

You are typically running in the project folder (Studio Claude's "Artifacts"
mode), so `artifacts/…` is relative to the current directory.

## Kinds

### brand-kit — font pairing + color palette
- **Path:** `artifacts/brand-kit/<slug>.json`

Example (follow this shape):

```json
{
  "kind": "brand-kit",
  "version": 1,
  "name": "Editorial Mono",
  "fonts": {
    "heading": { "family": "Fraunces", "weight": 600 },
    "body": { "family": "Newsreader", "weight": 400 }
  },
  "colors": [
    { "name": "Primary",    "value": "#2a2a28" },
    { "name": "Accent",     "value": "#a85a4a" },
    { "name": "Background", "value": "#f7f5f0" },
    { "name": "Surface",    "value": "#efece5" },
    { "name": "Text",       "value": "#2a2a28" }
  ],
  "savedAt": "2026-06-15T18:00:00Z"
}
```

Rules:
- `kind` must be exactly `brand-kit`.
- Each font **must** be `{ "family": <string>, "weight": <number> }` — never a
  bare string. `family` must be a real Google Fonts family name (so previews
  render); `weight` is a number 100–900. Pick weights that suit the pairing
  (e.g. heading 600–700, body 400).
- 5–6 colors, each `{ "name": <role>, "value": <#rrggbb> }`.
- `savedAt` = current ISO 8601 timestamp; `version` = 1.

### Making a *set* (the common request for brand kit)
When asked for N kits, make each one **genuinely distinct and deliberately
non-generic** — vary the mood (editorial, warm/organic, brutalist, playful,
refined-luxury…), the type personality, and the color temperature. Avoid default
SaaS/AI looks. Briefly note the intent behind each.


### presentation — a slide deck
- **Path:** `artifacts/presentation/<slug>.json`

Edited in the **Slides** tool; the Artifacts panel previews it. Shape:

```json
{
  "kind": "presentation",
  "version": 1,
  "name": "Q3 Review",
  "theme": {
    "fonts": {
      "heading": { "family": "Fraunces", "weight": 600 },
      "body": { "family": "Newsreader", "weight": 400 }
    },
    "colors": { "bg": "#f7f5f0", "surface": "#efece5", "text": "#2a2a28", "muted": "#6e6154", "accent": "#a85a4a", "accent2": "#3f5e5a" }
  },
  "slides": [
    { "layout": "title", "title": "Q3 Review", "subtitle": "Product & growth" },
    { "layout": "section", "title": "Where we are" },
    { "layout": "title-body", "title": "Highlights", "i1": "- Shipped **v2**\n- 3× signups" },
    { "layout": "two-col", "title": "Wins vs risks", "i1": "**Wins**\n- A\n- B", "i2": "**Risks**\n- C" },
    { "layout": "quote", "quote": "Make the obvious thing easy.", "attribution": "Design principle" },
    { "layout": "image-full", "image": "media/chart.png", "caption": "Signups over time" },
    { "layout": "image-text", "title": "The new flow", "image": "media/flow.png", "i1": "Three steps, no signup wall." }
  ],
  "savedAt": "2026-06-16T18:00:00Z"
}
```

Rules:
- `kind` must be exactly `presentation`.
- `theme.fonts.heading|body` are `{ family, weight }` (real Google Fonts family,
  weight 100–900), same contract as brand-kit fonts. `theme.colors` =
  `{ bg, surface, text, muted, accent, accent2 }` hex values — `surface` is a
  subtle panel background, `muted` is secondary text (subtitles, captions),
  `accent`/`accent2` are two accent colors (each usable as a full-slide
  background). A per-slide `colorScheme` derives the palette from these.
  `theme.bodySize` (px, default 24) is the base body-text size (= Medium); a
  per-slide `bodySize` of `"s"`/`"m"`/`"l"` scales from it. `theme.headingSize`
  (px, default 56) is the base heading size; a per-slide `headingSize` of
  `"s"`/`"m"`/`"l"`/`"xl"` scales from it (each layout sets its own default —
  e.g. Title slides default Large, Title+Body Medium).
- Each slide has a `layout` plus the slots that layout uses. Valid layouts and
  their slots:
  - `title` → `title`, `subtitle`
  - `section` → `title`, optional `image` (full-bleed background, darkened so
    the heading stays legible in white)
  - `title-body` → `title`, `i1` (the body; optional `columns`: `1` (default) or
    `2` — flows the single body into that many columns via CSS column-count)
  - `two-col` → `title`, `i1` (left), `i2` (right)
  - `three-col` → `title`, `i1` (left), `i2` (middle), `i3` (right)
  - `title-grid` → `title`, `subtitle`, and four grid items `i1`–`i4` (a 2×2
    grid on the right, title + subtitle in a left column)
  - `title-grid-6` → same as `title-grid` but a 3×2 grid of six items `i1`–`i6`
  - `stats` → `title`, `subtitle`, and stat cards `i1`–`i4` (`i4` optional; a
    row of big-figure cards). Author each stat as Markdown with a leading
    `## value` (rendered as the large figure) then `**label**` and description,
    e.g. `"## 70%\n\n**Growth**\n\nYear over year."`
  - `steps` → `title` and numbered items `i1`–`i4` (`i4` optional). Each item's
    `01`/`02`… number is generated automatically from its position — don't type
    it into the text.
  - `quote` → `quote`, `attribution`
  - `image-full` → `image`, optional `caption`
  - `image-text` → `title`, `image`, `i1` (the body), optional second `image2`
    (stacks below `image` in the media column; a single image fills/centers the
    column), optional `caption`
  - Any image layout (`image-full`, `image-text`, `section`) accepts an optional
    `caption` that renders only when it has text.
  - **`i1`–`i6` are one shared "content region" family** used by every
    text layout above, so switching a slide's layout keeps its content
    (position-for-position). `quote` maps its `quote` to/from `i1`.
- Body-type slots (`i1`–`i6`) accept **Markdown** (bold,
  lists, links, `##`/`###` headings, blockquotes, `code`, `---`). `**bold**`
  renders in the accent color.
- Optional `listStyle` on a slide: `"bullets"` (default) or `"cards"` — renders
  top-level list items as surface-colored cards (good for key-point slides).
- `image` slots are **project-relative paths** (e.g. `media/chart.png`) — point
  at files already in the project's `media/` folder.
- Optional `imageFit` on an image slide controls how the image sits in its
  frame: `"cover"` (default, fills and crops) or `"contain"` (fits the whole
  image, letterboxed).
- Optional `colorScheme` on any slide: `"light"` (default), `"soft"` (the
  `surface` color as background), `"dark"`, `"accent"`, or `"accent2"` — each
  derives a full palette from the theme's 6 colors. `section` slides default to
  `"accent"`.
- `savedAt` = current ISO 8601 timestamp; `version` = 1.

### theme — a reusable presentation theme
- **Path:** `artifacts/theme/<slug>.json`

A presentation's `theme` block, saved on its own so it can be reused across
decks. Edited in the **Theme editor** (live multi-layout preview); the Slides
tool's Theme tab lists saved themes alongside the built-in presets. Shape:

```json
{
  "kind": "theme",
  "version": 1,
  "name": "Editorial Warm",
  "fonts": {
    "heading": { "family": "Fraunces", "weight": 600 },
    "body": { "family": "Newsreader", "weight": 400 }
  },
  "colors": { "bg": "#f7f5f0", "surface": "#efece5", "text": "#2a2a28", "muted": "#6e6154", "accent": "#a85a4a", "accent2": "#3f5e5a" },
  "headingSize": 56,
  "bodySize": 24,
  "savedAt": "2026-06-17T18:00:00Z"
}
```

Same shape as a presentation's `theme` (minus `kind`/`name`/`savedAt`), so a
theme file's fields can be copied straight into a deck's `theme`. Make a set of
themes genuinely distinct (mood, type personality, color temperature).

### diagram — a concept diagram (flow, compare, matrix, venn, timeline, hierarchy)
- **Path:** `artifacts/diagram/<slug>.json`

Edited in the **Diagram** tool; the Artifacts panel previews it live. A diagram
renders as a themed 1200×675 SVG. It can also be placed on a slide: set any
image slot to the diagram's project-relative path
(e.g. `"image": "artifacts/diagram/design-process.json"`) — the Slides tool
renders it live and **re-themes it with the deck's theme** so it always matches.

```json
{
  "kind": "diagram",
  "version": 1,
  "name": "Design process",
  "title": "The double diamond",
  "template": "flow",
  "theme": {
    "fonts": {
      "heading": { "family": "Fraunces", "weight": 600 },
      "body": { "family": "Newsreader", "weight": 400 }
    },
    "colors": { "bg": "#f7f5f0", "surface": "#efece5", "text": "#2a2a28", "muted": "#6e6154", "accent": "#a85a4a", "accent2": "#3f5e5a" }
  },
  "colorScheme": "light",
  "data": {
    "direction": "right",
    "nodes": [
      { "id": "a", "label": "Research", "detail": "Interviews, field notes" },
      { "id": "b", "label": "Synthesize", "detail": "Patterns & insights" },
      { "id": "c", "label": "Prototype" }
    ],
    "links": [
      { "from": "a", "to": "b" },
      { "from": "b", "to": "c" },
      { "from": "c", "to": "b", "label": "iterate" }
    ]
  },
  "savedAt": "2026-07-02T18:00:00Z"
}
```

Rules:
- `kind` must be exactly `diagram`. `theme` has the same contract as a
  presentation's theme (fonts + 6 colors). `title` is an optional heading drawn
  on the canvas; `colorScheme` is the same `light`/`soft`/`dark`/`accent`/
  `accent2` derivation slides use.
- `template` picks the layout, and `data` holds that template's content:
  - `flow` → `data.direction` (`"right"` default or `"down"`),
    `data.nodes: [{ id, label, detail? }]`,
    `data.links: [{ from, to, label? }]` (node ids; back-links draw as return
    arrows — good for "iterate" loops). Layout is automatic (layered by links).
  - `compare` → `data.items: [{ title, points: [strings] }]` — 2–4 panels;
    exactly 2 gets a "vs" badge.
  - `matrix` → `data.x: { low, high }`, `data.y: { low, high }` (axis end
    labels), `data.items: [{ label, x, y }]` with `x`/`y` as 0–1 fractions
    (0,0 = bottom-left).
  - `venn` → `data.sets: [{ label }]` (2 or 3), optional `data.overlapLabel`.
  - `timeline` → `data.events: [{ time?, label, detail? }]`, drawn left to
    right, labels alternating above/below the line.
  - `hierarchy` → `data.root: { label, children: [{ label, children? }] }` —
    a tree, root on top.
- Optional `offsets` maps element ids to `{ dx, dy }` pixel nudges the designer
  made by dragging — **preserve it when editing**, don't generate it yourself.
- Keep labels short (2–4 words) and put elaboration in `detail`/`points`;
  diagrams are for slides and should read at a glance.
- `savedAt` = current ISO 8601 timestamp; `version` = 1.
