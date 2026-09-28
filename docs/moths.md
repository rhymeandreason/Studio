# Moths

Procedural butterflies and moths, drawn as flat vector SVG in the spirit of
natural-history plates. There are two parts:

- **`src/moths/moths.js`**: the generator. It has no DOM dependency and
  returns SVG strings, so any Studio page (Slides, Video, Diagrams, a sidecar
  script) can import it and draw specimens directly.
- **`src/tools/moths.html`**: the Moths tool (listed as **Lepidoptera** in the Tools menu). It shows a specimen plate you
  can shuffle, pin and edit, and saves PNGs into the active project's `media/`.

## Using the generator from another app

```js
import { specimen, specimenSVG, describe } from "../moths/moths.js";

const spec = specimen({ seed: 42 });            // resolve every field
const svg  = specimenSVG(spec);                 // tight crop, transparent
const tile = specimenSVG(spec, { fit: "plate" }); // fixed box, sizes comparable
const { name, latin } = describe(spec);         // "Coral-banded Carpet", "Geometra zonata"
```

`specimenSVG(spec, { fit, background, padding, className })`
- `fit: "tight"` (default) crops to the specimen plus `padding`.
- `fit: "plate"` uses a fixed `PLATE` box (220×185 units), so a small white
  butterfly stays small next to a big silk moth. Tiles should use that aspect.
- Each call uses unique clip-path ids, so many specimens can share one page.
- Wings are in `<g class="side">` groups, one per side and each pivoting at
  the body. The tool flaps the selected specimen with a CSS `scaleX` keyframe
  on `.side`; `transform-box: fill-box; transform-origin: 0% 50%` hinges it at
  the body.

## The spec (store this, not the SVG)

```json
{
  "seed": 1234567, "family": "silk", "recipe": "eyed", "palette": "sorbet",
  "colors": { "ground": "#9fd8cf", "ground2": "#f4a3a8", "accent": "#e8506a",
              "accent2": "#f7c9b6", "dark": "#2f4b4f", "light": "#fff4ec", "body": "#2f4b4f" },
  "shapeSeed": 1, "patternSeed": 2, "colorSeed": 3, "size": 0.97
}
```

Pass any subset to `specimen()` and the rest is derived from `seed`, so the
same input always resolves to the same specimen. Shape, pattern and colors
each use their own seed, which is why changing the family keeps the colors
and re-rolling the pattern keeps the silhouette. `palette: "custom"` marks
hand-edited colors. Names aren't stored: `describe()` derives them, so they
follow color edits ("Mint Emperor" turns into "Coral Emperor").

## How a wing is drawn

Each wing is a **fan** out from its root at the body. A margin function
`r(t)` gives the outer edge for `t ∈ [0,1]`, running from the apex to the
tornus. It has a bulge, a falcate (hooked) apex, a scalloped edge, and tails
as lobes. The apex and tornus corners are then rounded with a real
radius (`tip` / `heel`, as a fraction of wing length, set per family). The
references have soft, rounded tips, and smoothing alone leaves them sharp. `fan(t, f)` maps a position along the margin and a fraction out from
the root to a point. Every pattern layer is written in those coordinates and
clipped to the wing, so any pattern fits any silhouette:

| layer | in fan coords |
|---|---|
| veins | lines of constant `t`, starting at the discal cell |
| bands / borders | regions between two `f` values (wavy, zigzag, scalloped) |
| margin dots, chevrons | points at a fixed `f` along `t` |
| eyespots, discal marks | concentric ellipses at one `(t, f)` |
| spots, blotches | rejection-sampled scatter |
| dashes, rays, squiggles | strokes/wedges along or across the fan |

Right wings are drawn once and mirrored. Hindwings are drawn under the
forewings.

- **`FAMILIES`** (silhouettes): brush-foot, swallowtail, morpho, white &
  sulphur, silk moth, moon moth (tails), tiger moth (delta rest pose),
  hawk-moth (swept), geometer. Each one sets `[min,max]` ranges for its wing
  params, a body preset (clubbed vs. feathered antennae, fuzzy moth thorax),
  weighted recipes, and name vocabulary.
- **`RECIPES`** (pattern stacks): Veined (monarch-like), Eyespot, Bordered,
  Two-tone, Banded, Spotted, Tipped, Shining, Blotched, Speckled, Scribbled,
  Streaked, Rayed. `prefs` nudge the color roles a recipe needs, e.g. Speckled
  wants a light ground and Blotched wants a vivid hindwing.
- **`PALETTES`**: curated 6-color sets. `assignColors` sorts by luminance and
  assigns roles, picking the accent for contrast plus hue distance from the
  ground. Each wing also gets a derived `ink` and `pale` against its own
  ground, so line work stays legible when colors are edited.

To add a family, recipe or palette, add an entry to the table. The tool builds
its menus from these tables.

## The tool

- The plate is a flex-wrap grid of pixel-sized tiles (not grid +
  aspect-ratio; see the WKWebView note in tools.md). The whole plate (specs,
  pins, background, count) persists in `localStorage` (`studio.moths`).
- **Space** shuffles the plate; pinned specimens stay. **Arrows** move the
  selection, **P** pins, **⌘C** copies a PNG, **⌘S** saves.
- **Save** writes a ~1400px transparent PNG to `<project>/media/` through
  `write_image` (it creates `media/` if it's missing). The filename is the
  slugged common name plus a hash of the spec, so saving an unchanged specimen
  again overwrites its own file. **SVG** goes through `save_tool_export`
  (`designs/`). **Save plate** renders the whole sheet with captions as one PNG.
- No Rust: the tool uses existing commands (`get_active_project`,
  `write_image`, `fs_new_folder`, `save_tool_export`).
