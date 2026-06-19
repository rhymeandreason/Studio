# Design System

**Runes** — warm paper, Futura, hairline surfaces. Three layers:

1. **`src/tokens.css`** — CSS custom properties (colors, type, spacing, motion). Single source of truth; imported by `styles.css` and linked by tool windows.
2. **`src/kit/kit.css`** — Component classes built on tokens. No JS. Link after `tokens.css`.
3. **`src/kit/components.js`** — `<studio-*>` Web Components for widgets that need JS behavior. Each exposes `.value` + emits `input`/`change` like a native form control.

**When to add a component vs. a class:** CSS class if it's purely visual; Web Component only if it needs encapsulated JS behavior.

Current components: `<studio-color>`, `<studio-swatch>`. Full attribute/event docs are in [`kit-gallery.html`](../src/tools/kit-gallery.html) (Tools → Design System) next to each component demo.

**Radius scale:** `--radius-sm` (6px) · `--radius` (10px) · `--radius-lg` (12px). Use these — don't hardcode px values.

**Text utilities** (in `kit.css`): `.text-body`, `.text-muted`, `.text-xs`, `.text-mono` — cover the four most common text patterns. `.label` and `.eyebrow` are also in kit for structural labels.

**`src/tools/kit-gallery.html`** (Tools → Design System) is the living reference for every token and class. Items with a ✓ are available as kit classes.

## Adding to the kit

**New CSS class** (purely visual):
1. Add it to `src/kit/kit.css` with a comment header matching the existing section style.
2. Add a demo to `kit-gallery.html` — use `class="comp-name in-kit"` on the label so the ✓ badge appears.
3. If it's main-app-only (not needed by tools), put it in `src/styles.css` instead.

**New Web Component** (needs JS behavior):
1. Add the class to `src/kit/components.js` and register it with `customElements.define("studio-*", ...)`.
2. Expose `.value` getter/setter and emit `input`/`change` events so it behaves like a native form control.
3. Add a demo to `kit-gallery.html` and document it here in `DESIGN.md`.

No build step — just edit the files and reload.

## Promoting an existing pattern to a kit component

When the same DOM structure is being built by hand in multiple tools, move it into the kit:

1. **Audit call sites** — find every place that builds the pattern (`grep` for the class name). Note what varies between them (attributes, behaviors, event wiring).
2. **Consolidate CSS into `kit.css`** — move any styles that lived in local `<style>` blocks into `kit.css`. Remove the local copies.
3. **Write the Web Component in `components.js`** — light DOM, using the same CSS classes from kit.css. Accept the variations as attributes (`deletable`, `picker="below"`, etc.). Emit named events (`input`, `change`, `delete`, `nameinput`) rather than accepting callbacks.
4. **Replace call sites** — swap the manual DOM construction for `document.createElement("studio-*")` + `setAttribute` + `addEventListener`. Each call site should shrink significantly.
5. **Remove dead code** — delete any helper functions that existed only to build the old pattern (e.g. `initColoris()` after Coloris init moved into `connectedCallback`).
6. **Update `kit-gallery.html`** — replace the hand-built demo with the new element.
7. **Document in `DESIGN.md`** — add the component to the current components list with its attributes and events.

## Tool usage

```html
<link rel="stylesheet" href="../tokens.css" />
<link rel="stylesheet" href="../kit/kit.css" />
<script type="module" src="../kit/components.js"></script>
```

Tool-specific overrides go in a local `<style>` — don't add one-off styles back into `kit.css`.
