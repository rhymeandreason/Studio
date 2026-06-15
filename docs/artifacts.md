# Artifacts

Status: **MVP built; spec ahead of it.** The Artifacts panel, brand-kit previews,
open-in-tool, and the Brand Explorer's open/edit/save-as-artifact are implemented
(see "What's built" below). The variant gallery, live folder watch, and
promote-to-canonical are still spec. This defines the Artifacts model, the project
**Artifacts panel**, and the human↔Claude design workflow it enables. It's also
written to be the context Claude reads to play its part.

Related: [tools.md](tools.md), [tools-dynamic-loading.md](tools-dynamic-loading.md)
(the kit/design-system), [tool-ideas.md](tool-ideas.md).

## Why artifacts

Design is moving to a **generate-then-edit** paradigm: Claude generates a first
version (a website, a brand, a layout), and the designer edits from there. The
designer's leverage shifts from *executing* a design to **directing and tuning
the generator** — and the main job becomes making sure the generated result
isn't generic.

You steer the generator with **artifacts**: small, schema'd, Claude-legible
files that capture a design decision (a brand kit, a color palette, a type scale,
a motion signature, a written direction). Their output isn't an asset to copy —
it's a **spec that biases the next generation**. Tune a token in a tool, and you
tune everything Claude produces from then on.

**The key architectural fact: Claude and the tools meet at the artifact, not the
GUI.** "Claude uses the Brand Explorer to make 5 variants" means Claude *writes
five brand-kit files in the format the Brand Explorer reads and edits* — not
Claude clicking a UI. The shared schema **is** the integration:

- **Claude** authors artifacts (it has filesystem access to the project via the
  companion, knows the schemas, and is good at generating distinctive ones).
- **Tools** are the human's editor of the same artifacts (open-on-artifact, edit,
  save back).
- **Studio** is the surface that watches the project, displays artifacts, and
  launches tools.

Most "Claude uses a tool" cases reduce to "Claude reads/writes the artifact."
The rare exception is a tool with real computation (e.g. extract-palette-from-
image); those may later expose a headless core, but artifact read/write is enough
to start.

## What an artifact is

A file in the project that is:

- **Schema'd** — a documented shape (usually JSON; prose artifacts like a design
  direction may be Markdown with front-matter). Carries a `kind`.
- **Claude-legible** — Claude can generate and modify it from the schema alone.
- **Tool-editable** — a tool opens *on* it and saves back.
- **Previewable** — has a reusable renderer so it can be shown as a swatch/card
  without launching the full editor (for variant galleries).

Designs are a **subset** of artifacts; the model is general (palettes, scales,
motion, directions, and future kinds like content outlines, component specs,
moodboards).

### Initial kinds
- `brand-kit` — fonts + color palette (from the Brand Explorer). *Exists.*
- `design-direction` — the stance: adjectives, references, explicit do/don'ts
  (the anti-generic artifact). *New.*
- `palette` — a standalone color set.
- `type-scale` — modular scale + role sizes.
- `motion-signature` — easing/spring personality + duration tokens.

Kinds are **extensible** — adding one = a schema + a tool that edits it + a
preview renderer.

## Storage & conventions (to confirm)

Proposed: a per-project `artifacts/` folder, each file carrying a `kind` and the
panel grouping by it. A **set of variants** is multiple files of the same kind
(e.g. `artifacts/brand-kit/variant-1.json … variant-5.json`). One can be
**promoted to canonical** — the project's active artifact of that kind, recorded
in `workspace.json` (e.g. `"canonical": { "brand-kit": "…/variant-3.json" }`),
which is what Claude reads when generating.

Open: whether the existing `designs/` export folder (raw exported PNGs from
`save_tool_export`) folds under `artifacts/` as a category, or stays a sibling.

Every artifact file should carry, at minimum:
```json
{ "kind": "brand-kit", "version": 1, "name": "Variant 3", "savedAt": "…", "…": "…" }
```

## The Artifacts panel (new project tab)

A first-class panel under a project, alongside media / notes / workspace:

- **Lists artifacts grouped by kind**, each shown via its preview renderer (a
  brand-kit renders as a type+color sample; a palette as swatches; etc.).
- **Variant galleries** — a set of N variants shown side by side to compare and
  pick.
- **Open in tool** — opens the artifact's editor tool, pinned to that file.
- **Promote to canonical** — marks the project's active artifact of that kind.
- **Create new** — from a tool, or "ask Claude to generate variants."
- **Live** — watches the `artifacts/` folder (FSEvents, like the projects watch),
  so artifacts Claude writes appear immediately.

## The design workflow it enables

| Stage | Driver | Artifact |
|---|---|---|
| **Direction** — the stance, incl. what to avoid | you + Claude | `design-direction` |
| **Diverge** — range; N options | Claude generates | `brand-kit/variant-*` |
| **Curate + tune** — convergence | you, in tools | edited kit, type scale, motion |
| **Promote** | you | canonical ref in `workspace.json` |
| **Generate** — reads the artifacts as steering input | Claude | the site |
| **Edit** | you | systemic edits flow *back* to artifacts |

Worked example ("brainstorm 5 brand directions"):
1. You ask the companion to brainstorm brand directions.
2. Claude writes `artifacts/brand-kit/variant-1..5.json` — deliberately distinct,
   non-generic.
3. The Artifacts panel shows the five as a live variant gallery.
4. You open `variant-3` in the Brand Explorer, tweak, save.
5. You promote it to canonical.
6. You ask Claude to generate the site; it reads the canonical brand-kit (+ the
   design-direction) as steering input.

The last stage's reverse direction — a systemic edit on the *generated output*
updating the artifact so it re-steers — is the frontier (likely v2).

## Requirements this imposes on tools

Going forward, every artifact-editing tool should:
- **Open-on-artifact**, not just create-from-scratch (pinned via URL param, like
  the companion windows: `brand-explorer.html?artifact=…`).
- Use the **documented schema** for its kind (the Claude contract).
- Provide a **separable preview renderer** so galleries can show the artifact
  without the full editor.

## What's built (MVP)

Implemented; establishes the pattern every later tool follows:

- **Artifact storage + commands** — `<project>/artifacts/<kind>/<name>.json`;
  Rust `list_artifacts` / `read_artifact` / `save_artifact`, and `open_tool`
  (opens a tool window, optionally pinned to an artifact via `?artifact=<path>`,
  with its own window label per artifact). In `src-tauri/src/lib.rs`.
- **Artifacts panel** — a project tab (`src/artifacts.js`, markup in `index.html`,
  styles in `styles.css`) that lists artifacts grouped by kind, renders a preview
  per artifact, and opens them in their editor tool. **Live**: the recursive
  `~/Projects` watcher emits `fs-changed`, and the panel re-renders on it when
  it's the active view — so artifacts Claude writes appear without a manual
  Refresh (the Refresh button + tab-open re-list remain as fallbacks).
- **Brand Explorer: open-on-artifact** — loads/edits an existing kit
  (`?artifact=…`) and saves as a `brand-kit` artifact (named) via `save_artifact`.
- **Studio Claude working-directory toggle** — the chat bar has an
  **Artifacts / Code** dropdown (left of the model select) that picks the cwd
  Claude runs in: `project` (the project folder, where `artifacts/` lives —
  default) or `repo` (the workspace's git repo, for code). Per-session;
  threaded through `claude_send` + the session-history commands in both the
  companion and the in-Studio backend. See [claude-window.md](claude-window.md).
- **Reusable brand-kit preview** — `brandKitPreview()` in `src/artifacts.js`
  (font names + color swatches).
- **Format discoverability via a skill** — the artifact formats live in the
  `studio-artifacts` **Claude Code skill** (`skills/studio-artifacts/SKILL.md` in
  this repo), symlinked into `~/.claude/skills/`. Because Studio Claude runs in
  the project folder and skills load on demand by description, Claude knows the
  formats with nothing pasted — one source of truth across all projects, instead
  of a per-project CLAUDE.md block. The SKILL.md's example + rules are the spec;
  there's no formal JSON Schema (artifacts are local design files — producers are
  trusted and consumers read them leniently, so validation isn't worth it). Edit
  the skill in-repo; the symlink keeps it live.

### Still spec (next)
- **Variant-set gallery** — first-class "a set of N variants" comparison UI.
- **Promote-to-canonical** — mark the project's active artifact of a kind in
  `workspace.json` for generation to read.
- **`design-direction` kind** + more editors.

## Open decisions

1. Storage layout — `artifacts/<kind>/<file>` vs. flat `artifacts/` with a `kind`
   field; does `designs/` fold in?
2. Variant set representation — folder of files vs. one file with an array.
3. Canonical promotion — `workspace.json` reference (proposed) vs. naming/symlink.
4. Whether any tools need a **headless callable core** for Claude, or artifact
   read/write is sufficient (currently: sufficient).
5. Round-trip (edit → artifact) — scope for later.
