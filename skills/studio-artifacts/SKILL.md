---
name: studio-artifacts
description: Create or edit Studio design artifacts — brand kits (font pairings + color palettes), slide decks/presentations, and other design specs stored as JSON under a project's artifacts/ folder. Use when asked to generate, brainstorm, or modify brand kits, palettes, presentations/slides, or design directions for a Studio project.
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
    { "layout": "title-body", "title": "Highlights", "body": "- Shipped **v2**\n- 3× signups" },
    { "layout": "two-col", "title": "Wins vs risks", "left": "**Wins**\n- A\n- B", "right": "**Risks**\n- C" },
    { "layout": "quote", "quote": "Make the obvious thing easy.", "attribution": "Design principle" },
    { "layout": "image-full", "image": "media/chart.png", "caption": "Signups over time" },
    { "layout": "image-text", "title": "The new flow", "image": "media/flow.png", "body": "Three steps, no signup wall." }
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
  - `title-body` → `title`, `body` (optional `columns`: `1` (default) or `2` —
    flows the single body into that many columns via CSS column-count)
  - `two-col` → `title`, `left`, `right`
  - `three-col` → `title`, `left`, `middle`, `right`
  - `quote` → `quote`, `attribution`
  - `image-full` → `image`, `caption`
  - `image-text` → `title`, `image`, `body`
- Body-type slots (`body`, `left`, `middle`, `right`) accept **Markdown** (bold,
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
