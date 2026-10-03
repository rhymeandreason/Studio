# Enclosure

Parametric 3D-printable cases for electronics (Raspberry Pi, Arduino, custom
boards). Pick a board, set the walls and the lid, then place slots and holes on
each face. You get a base and a lid as STL files.

- Tool: `src/tools/enclosure.html` (Tools → Enclosure; also Artifacts panel → + → Enclosure)
- Artifact: `artifacts/enclosure/<name>.json`. The format is documented for Claude in
  `skills/studio-artifacts/SKILL.md`; change the saved shape → update the skill.
- Export: `models/<name>-base.stl` + `models/<name>-lid.stl` in the project
  (binary STL, already oriented for printing).

## Modules (`src/enclosure/`)

| File | What | Depends on |
|---|---|---|
| `boards.js` | Board presets: size, mounting holes, connectors (data only) | — |
| `model.js` | Doc defaults + `normalize`, `layout()` (outer size, board placement, screw bosses), face frames, port → face mapping, `resolveCutouts()`, cutout outlines as polygons | boards |
| `geometry.js` | manifold-3d CSG → base + lid meshes, `lidForPrint`, `toSTL` | model, `vendor/manifold` |
| `preview.js` | Static SVG thumbnail for the Artifacts panel (plan + front elevation) | model |

The tool page is only UI: the 2D face editor (SVG), the 3D preview (three.js),
the inspector, undo, and save/export. Geometry rules live in `geometry.js`; every
number comes from `layout()`, so the 2D view, the 3D view and the STL all agree.

## Coordinates

- **World:** X = width, Y = depth (front = −Y), Z = up, origin at the outer
  bottom-front-left corner.
- **Faces:** every face is drawn **as seen from outside**, with u to the right,
  v up, and the origin at the face's bottom-left outer corner. Top and bottom are
  both drawn as seen from above, so they line up with the board drawing.
  `faceBasis()` gives `O + u·U + v·V + n·N` with `N = U × V`. Every basis is
  right-handed, so warping an extruded cutter onto a face never turns it
  inside out (`out` says whether N points out of or into the box).
- **Cutout x/y are centres** in face coordinates. Port-linked cutouts
  (`{ port }`) store only `dx`/`dy` offsets and optional size overrides, so they
  follow the board when the standoff height, clearance or wall changes.

## Geometry rules

- Interior = board + connector overhang on each side + clearance. With
  `lid.style = "screw"`, the clearance is raised automatically until the four
  corner bosses clear the board and any connector near a corner. The inspector
  says when this happens.
- Base = rounded outer prism − inner prism, + standoffs (with pilot holes).
  Then per lid style: screw = corner bosses with pilot holes, plus a lid with
  clearance holes, optional countersinks and a short locating lip that skips the
  bosses; slide = grooves in three walls, the front wall opened above the
  groove, and a lid whose front cap is the pull; lip = press-fit skirt.
- Side cutouts cut the base and the lid (as assembled); top cutouts cut only the
  lid; bottom cutouts cut only the floor.
- The circle resolution is set once in `loadManifold()` (5°, 0.4 mm edges).
  WASM objects are freed after every build (`trash` in `buildParts`).

## UX

- The face tabs show a cutout count. Clicking a tab also turns the 3D camera
  toward that face. Clicking the 3D model selects the nearest face and any
  cutout under the pointer.
- Drag to move (snaps to 0.5 mm, the face centre, this face's connectors and the
  other cutouts' centres). Drag the corners to resize. Option = no snapping.
  Double-click empty face = add a Ø6 round hole. Arrow keys nudge (Shift = 5 mm),
  R rotates 90° (swaps W/H), ⌘D duplicates, ⌫ deletes, ⌘Z / ⇧⌘Z undo/redo.
- Selection dimensions (distance from the left and bottom edges) are drawn in
  the 2D view; exact numbers are in the footer fields.
- Autosaves to the artifact after the first edit; reloads live when Claude edits the file
  (unless there are unsaved local edits), like the Diagram tool.

## Vendored

- `src/vendor/three/`: three.js r186 (`three.module.js` + `three.core.js` +
  `OrbitControls.js`, unmodified). OrbitControls imports bare `"three"`, so the
  page maps it with an `<script type="importmap">` placed before every module script.
- `src/vendor/manifold/`: manifold-3d 3.5.4 (`manifold.js` + `manifold.wasm`).
  It finds the wasm file through `import.meta.url`.

## Caveats / next

- Preset connector positions are rounded from the vendors' drawings. Tell the
  user to measure before a tight print. Pi 5 extras (power button, fan, PCIe FPC) aren't modelled.
- Not built yet: 3MF export, embossed text, a hole grid (only slot vents exist), heat-set insert sizing,
  per-side clearance, wall-mount ears.
