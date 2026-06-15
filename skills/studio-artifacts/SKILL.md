---
name: studio-artifacts
description: Create or edit Studio design artifacts — brand kits (font pairings + color palettes), and other design specs stored as JSON under a project's artifacts/ folder. Use when asked to generate, brainstorm, or modify brand kits, palettes, or design directions for a Studio project.
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
- **Schema:** [`schemas/brand-kit.schema.json`](schemas/brand-kit.schema.json) —
  follow it exactly.

Example:

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
- Each font is `{ "family": <Google Fonts family>, "weight": <100–900> }` —
  `family` must be a **real Google Fonts family name** (so previews render).
  Pick weights that suit the pairing (e.g. heading 600–700, body 400).
- 5–6 colors, each `{ "name": <role>, "value": <#rrggbb> }`.
- `savedAt` = current ISO 8601 timestamp; `version` = 1.

### Making a *set* (the common request)
When asked for N kits, make each one **genuinely distinct and deliberately
non-generic** — vary the mood (editorial, warm/organic, brutalist, playful,
refined-luxury…), the type personality, and the color temperature. Avoid default
SaaS/AI looks. Briefly note the intent behind each.
