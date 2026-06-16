# Artifacts

Studio's design files: JSON under `<project>/artifacts/<kind>/<name>.json` that
capture design decisions (brand kits, palettes, …). **Claude writes them, tools
edit them, the Artifacts panel shows them.**

Status: MVP built (brand-kit, end to end); the variant gallery and
promote-to-canonical are still ahead. Related: [tools.md](tools.md),
[tools-dynamic-loading.md](tools-dynamic-loading.md),
[claude-window.md](claude-window.md).

## Why

Design is moving to **generate-then-edit**: Claude generates a first version, the
designer edits from there. Leverage shifts from *executing* a design to
**directing the generator** — chiefly keeping output from going generic. Artifacts
are how you steer: the value isn't an asset to copy, it's a **spec that biases the
next generation**. Tune a token, and you tune everything Claude makes after.

**Key fact: Claude and the tools meet at the artifact, not the GUI.** "Claude
makes 5 brand variants" = Claude *writes five brand-kit JSON files in the format
the Brand Explorer reads* — not clicking a UI. The shared format is the integration:

- **Claude** authors them (runs in the project folder via the companion, knows the
  format from the `studio-artifacts` skill).
- **Tools** edit them (open-on-artifact, save back).
- **Studio** watches the folder, previews them, launches the editor.

A rare tool needing real computation (e.g. extract-palette-from-image) could
expose a headless core later; read/write is enough so far.

## Model

- One file per artifact: `artifacts/<kind>/<name>.json`, each carrying a `kind`
  (and usually `name`, `version`, `savedAt`). The panel groups by `kind`.
- **Format, not schema.** Each kind's shape is documented *by example* in the
  `studio-artifacts` skill (`skills/studio-artifacts/SKILL.md`, symlinked into
  `~/.claude/skills/`) — so Claude knows it with nothing pasted, one source across
  all projects. No formal JSON Schema or validation: these are local design files,
  producers are trusted, consumers read leniently. **Change a saved shape → update
  the skill.**
- A **set of variants** = multiple files of one kind. One can later be **promoted
  to canonical** (the project's active kit, recorded in `workspace.json`) — what
  generation reads. *(Not built yet.)*
- "Designs" are a subset; the model is general (palettes, type scales, motion
  signatures, written directions, …).

## Built

- **Commands** (`src-tauri/src/lib.rs`): `list_artifacts` / `read_artifact` /
  `save_artifact`, and `open_tool` (opens a tool window, optionally pinned to an
  artifact via `?artifact=<path>`).
- **Artifacts panel** — project tab (`src/artifacts.js`; markup in `index.html`,
  CSS in `styles.css`): lists by kind, renders a preview per artifact
  (`brandKitPreview()`), opens it in the editor tool. **Live** — re-renders on the
  recursive watcher's `fs-changed` when active (+ Refresh / tab-open fallbacks).
- **brand-kit kind** — the Brand Explorer (`src/tools/brand-explorer.html`)
  creates, opens-on-artifact, and saves named kits. Shape:
  `{ kind, version, name, fonts: { heading|body: {family, weight} }, colors: [{name, value}], savedAt }`.
- **Studio Claude Artifacts/Code toggle** — picks Claude's cwd (project folder vs
  git repo); defaults to the project folder so artifacts land where the panel
  reads them. See [claude-window.md](claude-window.md).

## Workflow (the vision)

| Stage | Driver | Artifact |
|---|---|---|
| **Direction** — the stance, incl. what to avoid | you + Claude | `design-direction` |
| **Diverge** — N options | Claude | `brand-kit/variant-*` |
| **Curate + tune** | you, in tools | edited kit, scale, motion |
| **Promote** | you | canonical ref in `workspace.json` |
| **Generate** — reads artifacts as steering input | Claude | the site |
| **Edit** | you | systemic edits flow *back* (frontier) |

**A new artifact kind** = a documented format in the skill + a tool that
opens-on-artifact and saves it + a preview renderer for the panel.

## Next / open

- **Variant-set gallery** — compare N of a kind side by side.
- **Promote-to-canonical** — `workspace.json` ref for generation to read.
- **`design-direction` kind** (the anti-generic stance) + more editors.
- Whether `designs/` (raw PNG exports from `save_tool_export`) folds under
  `artifacts/`.
- Round-trip: a systemic edit on generated output updating the artifact (v2).
