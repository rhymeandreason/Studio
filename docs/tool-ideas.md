# Tool ideas

Brainstorm of tools to fill out Studio into a creative suite. Not scheduled —
this is a menu to pick from. See [tools.md](tools.md) for how tools are built and
[tools-dynamic-loading.md](tools-dynamic-loading.md) for the kit/design-system
direction. Actionable, committed follow-ups live in [BACKLOG.md](../BACKLOG.md).

**Guiding principle:** the best tools *close loops* with capabilities Studio
already has — the kit (`src/kit/`, tokens, `<studio-*>`, Motion One, Coloris),
`brand-kit.json` (from the Brand Explorer), the media editor (WebGL tonal, Vision
background removal, SD generate, webp/heic in Rust), `save_tool_export` →
project `designs/`, and the Claude subprocess. Reusing those beats net-new
infrastructure.

Existing tools: `bento-grid`, `daily-notes`, `ram-overview`, `kit-gallery`,
`brand-explorer`.

## Cluster: brand-kit hub (color & type)
Turn `brand-kit.json` into the center of a mini design-system suite — these read
and/or write it:
- **Contrast / a11y checker** — WCAG AA/AAA on every pair in the palette. Tiny,
  high value, reads the kit directly.
- **Palette generator** — harmonies (complementary / analogous / triadic) +
  **extract-from-image** (pull a palette from a project image; reuses media).
- **Type scale generator** — modular scale (ratio → sizes) → CSS tokens; pairs
  the kit's chosen fonts with a scale.
- **Gradient / mesh maker** and **shadow / elevation designer** — both →
  copyable CSS built on kit tokens.
- **Token exporter** — `brand-kit.json` → `:root` CSS / Tailwind config / Style
  Dictionary JSON. The dev-handoff payoff for the whole cluster.

## Cluster: asset prep & export
Reuse the native image stack (WebGL tonal, Vision, SD, webp/heic in Rust):
- **Favicon / app-icon generator** — drop an image → full size set + `.ico` /
  apple-touch into the project. Reuses the Rust encoders.
- **Screenshot framer / device mockup** — drop a screenshot → frame + shadow +
  background, export PNG. Same canvas approach as `bento-grid`.
- **Social / OG card generator** — templated 1200×630, pulls fonts + colors from
  the kit, exports PNG to the project.
- **Image optimizer / converter** — batch resize + webp/heic via existing Rust
  commands.
- **SVG cleaner** — paste SVG → optimized + copyable (client-side).

## Cluster: motion
Close the loop on the vendored Motion One (only the gallery uses it so far):
- **Easing curve editor** — cubic-bezier visualizer → token, live preview.
- **Spring playground** — tweak Motion's spring params, see the curve, copy values.
- **Keyframe previewer** — → export CSS `@keyframes`.

## Cluster: dev handoff & utilities
- **Color format converter** (hex / rgb / hsl / oklch) and **unit converter**
  (px / rem / em) — classic always-open widgets.
- **Markdown / README previewer** — `marked` is already vendored.
- **Regex tester / JSON formatter** — cheap dev-side utilities.
- **Placeholder generator** — lorem text + placeholder images into the project.

## Cluster: AI-assisted
Leverage the Claude subprocess plumbing already in the app:
- **Copywriter / microcopy** — headlines, button text, taglines in the project's
  voice.
- **Alt-text generator** — Vision OCR + Claude over project media (also closes
  the backlogged "Copy text from image" idea).
- **Name / brand brainstorm** — pairs with the Brand Explorer.

## Suggested first wave
Spans the whole pipeline (color → handoff → asset → motion → export) while
leaning on what's already built:
1. **Contrast checker** — trivial, immediately useful; proves the
   brand-kit-as-hub pattern.
2. **Token exporter** — makes the brand kit actually usable in code; the handoff
   payoff.
3. **Screenshot framer** — high daily value, pure canvas, no new backend.
4. **Easing curve editor** — closes the Motion loop, shows off the kit.
5. **Favicon / app-icon generator** — flagship reuse of the native image stack.
