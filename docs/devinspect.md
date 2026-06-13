# Dev inspector: click-to-Zed

Cmd+Option+Click any element (while `npm run tauri dev` is running) jumps Zed
straight to the CSS rule styling it. Hold Cmd+Option to see a highlight
outline follow the cursor; click to jump.

Implemented in `src/devinspect.js` (`initDevInspect()`), called from every
window's entry point: `main.js`, `claude/claude.js`,
`schedules/schedules.js`, `git/index.html`, and each `tools/*.html`.

## How it works

1. On click, walks `document.styleSheets` and finds the last rule whose
   selector matches the clicked element (via `el.matches(selectorText)`).
2. Maps the matched stylesheet to a source file:
   - External stylesheets (`styles.css`, `claude/claude.css`,
     `schedules/schedules.css`) via `FILE_MAP`.
   - Inline `<style>` blocks (`sheet.href === null` — the git window and
     Tools windows) resolve to the current page's own `.html` file under
     `src/`, via `location.pathname`.
3. Fetches that file's text and finds the line number of the matched
   selector text.
4. Calls the `open_in_zed(file, line)` Tauri command (`src-tauri/src/lib.rs`),
   which runs `/Applications/Zed.app/Contents/MacOS/cli <repo>/<file>:<line>`
   — the `zed` CLI isn't on PATH by default, so the bundled binary is called
   directly.

## Limitations

- Dev-only: `open_in_zed` resolves paths via `CARGO_MANIFEST_DIR`, which
  doesn't exist in a packaged build, and assumes Zed is installed at the
  default `/Applications` path.
- Picks the *last* matching rule across all stylesheets as a heuristic for
  "what's likely winning" — not full specificity/cascade resolution.

## Adding it to a new window

Every new window (companion window or Tools widget) needs to wire this in
itself — it isn't automatic:

- **ES module entry** (e.g. a new companion window's `*.js`, like
  `claude.js`/`schedules.js`): add
  `import { initDevInspect } from "../devinspect.js";` and call
  `initDevInspect()` once at startup (alongside the other init calls).
- **Self-contained `.html`** (git window, Tools widgets): add before
  `</body>`:
  ```html
  <script type="module">
    import { initDevInspect } from "../devinspect.js";
    initDevInspect();
  </script>
  ```
- If the window uses a **new external `.css` file** (not an inline
  `<style>` block), add its filename → repo-relative path to `FILE_MAP` in
  `src/devinspect.js`. Inline `<style>` blocks need no mapping — they
  resolve to the window's own `.html` file automatically.
