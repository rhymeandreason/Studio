# Design System

**Runes** — warm paper, Futura, hairline surfaces. Three layers:

1. **`src/tokens.css`** — CSS custom properties (colors, type, spacing, motion). Single source of truth; imported by `styles.css` and linked by tool windows.
2. **`src/kit/kit.css`** — Component classes built on tokens. No JS. Link after `tokens.css`.
3. **`src/kit/components.js`** — `<studio-*>` Web Components for widgets that need JS behavior. Each exposes `.value` + emits `input`/`change` like a native form control.

**When to add a component vs. a class:** CSS class if it's purely visual; Web Component only if it needs encapsulated JS behavior.

Current component: `<studio-color>` — a Coloris-backed color picker. Light DOM (not Shadow DOM) because Coloris is document-global and binds via `[data-coloris]` delegation.

**`src/tools/kit-gallery.html`** (Tools → Design System) is the living reference for every token and class.

## Tool usage

```html
<link rel="stylesheet" href="../tokens.css" />
<link rel="stylesheet" href="../kit/kit.css" />
<script type="module" src="../kit/components.js"></script>
```

Tool-specific overrides go in a local `<style>` — don't add one-off styles back into `kit.css`.
