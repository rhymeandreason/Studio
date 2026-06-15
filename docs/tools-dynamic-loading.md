# Tools: dynamic loading & categories (design notes)

Status: **design discussion, not yet implemented.** Captures the thinking on
adding tools without an app rebuild, and on giving tools explicit categories.
See [docs/tools.md](tools.md) for how tools work today.

## The problem

Adding or editing a tool currently requires a rebuild/restart of Studio. We want
to drop in a tool and have it appear and work without that. Some tools also need
project data or the ability to save, which shapes what "dynamic" can mean for
each one.

## Why a rebuild is needed today — two separate mechanisms

"Add a tool" couples two things that don't have to be coupled:

1. **Serving the file.** Tool windows load `tauri://localhost/tools/<file>`. That
   protocol only serves what's baked into `frontendDist` (`../src`) at build
   time. *But* in `npm run tauri dev`, `frontendDist` points straight at `src/`,
   so editing an **existing** tool's HTML is already live, and new files are
   serveable live too.
2. **Listing the file** (the tray menu). `scan_tools` reads `resource_dir()/tools`
   — the *bundled copy*, refreshed only at startup — and the Tools submenu is
   built once during `setup`. So a new file doesn't *appear* until restart, even
   though it would be serveable.

So "rebuild required" is really "the menu is scanned once, from the bundled
copy." That listing half is the easier and higher-value half to fix.

## Categories of tools

### By capability (what a tool needs from the host)

| Category | Needs | Hot-loadable? |
|---|---|---|
| **Static** | nothing (unit converter, color picker) | ✅ trivially |
| **Save-enabled** | `save_tool_export` → IPC → real origin + `tool-*` capability | ✅ |
| **Project-aware** | read project data (notes, media, active path) — *no command exists yet* | ✅ once read commands exist |
| **System/native** | memory stats, tray label, background loop, dedicated tray icon (RAM, Daily Notes) | ❌ must ship with the app |

The first three differ only in *which IPC commands they may call* — all served
the same way. The fourth is wired into Rust + tray setup.

**"Native" is smaller than it looks.** Only two things make RAM / Daily-Notes
genuinely un-dynamic: the **dedicated tray icon** and the **background refresh
thread** (the live "X.X GB" label). The underlying data (`get_memory_stats`)
could be exposed to any tool window over IPC. So the native category really
collapses to "needs a tray presence or a background loop"; everything else can be
a dropped-in file given the right command grants.

### By data binding (the more useful axis for us)

Capability matters for *permissions*, but the sharper distinction for how a tool
behaves is **what data it's bound to**:

- **Ephemeral** — operates on nothing, or on what you paste in. Output via
  download or `save_tool_export`.
- **Project-scoped** — reads/writes a *specific project's* data (media, notes,
  designs).

Project-scoped tools raise a real design question (see below): which project, and
does the tool follow the active project or pin one?

### Making categories first-class: a `needs` declaration

Let each tool declare its category in `Tools.json`:

```json
{ "file": "palette.html", "name": "Palette", "needs": ["project", "save"] }
```

The declaration gates which IPC commands the tool's window may call, and makes
"this is a native tool, it ships with the app" explicit rather than implicit
(`"needs": ["memory", "tray"]`). It also lets the host decide at scan time whether
a dropped-in (user-dir) tool is even allowed to request a given capability.

## How a project-scoped tool gets its project

No project-read command exists yet (`save_tool_export` only *writes*, reading the
active project server-side from `AppState`). A project-aware tool needs the
project pushed to it. Two clean options:

- **Pin at open** — pass `?project=…&name=…` in the window URL, exactly how the
  Claude companion now scopes itself. Simple and predictable: the window is "the
  Palette tool *for Yuniku*." Matches the side-by-side, one-window-per-thing model.
- **Follow active** — push the active project to tool windows via an event (like
  the old `claude-jump`) so the tool re-scopes when you switch projects.

**Recommendation: pin at open.** It's consistent with the companion model and
avoids surprising re-scopes; a tool that genuinely needs to follow the active
project is the rarer case and can opt in later.

## Recommended mechanism (the no-rebuild path)

The docs already sketch this as a future `tool://` scheme; fleshed out:

1. **User tools dir** — `~/Library/Application Support/com.studio.app/tools/`,
   writable, scanned *in addition to* the bundled ones. Scanning a user dir works
   **identically in dev and prod**, unlike the repo-dir trick (which is dev-only,
   since a shipped app has no `src/`). This is why "full" isn't much more than
   "partial" and is more uniform.
2. **`tool://` custom scheme** — `register_uri_scheme_protocol("tool", …)` serves
   files from that dir with a real origin, so IPC / `save_tool_export` keep
   working. User-tool windows load `tool://localhost/<file>`; the existing
   `tool-*` capability covers them by window label.
   - **Guard path traversal** in the handler (no `../`), and namespace window
     labels so a user tool and a bundled tool with the same filename stem don't
     collide on the `tool-<stem>` label.
3. **FSEvents watch** on the user dir (reuse the `start_watching` pattern used for
   `~/Projects`) → rebuild the Tools submenu on change (`tray_by_id` + a fresh
   submenu build). This is what removes the restart for *listing*.
4. **Project-read commands** (for the project-aware category) — a small set
   (`get_active_project`, list notes/media) granted to `tool-*`. Additive; does
   not depend on the dynamic-loading work.

### Trust

`tool://` + IPC means any HTML dropped into the user dir can call
`save_tool_export` and (later) project-read commands — i.e. **installing a tool =
running its code with your project access.** Fine for single-user v0.1, but worth
being deliberate about: path-traversal guard in the scheme handler, and the
`needs` declaration as the place where a tool's granted surface is visible.

## Design system

As tools multiply, they need a shared UI language rather than each re-inventing
buttons, fields, and colors. The good news: the "Runes" design system already
exists as the token block in `styles.css`, and tools already reach shared `src/`
files over the same `tauri://` origin (all three currently `import
"../devinspect.js"`). So same-origin sharing is proven — a tool can `<link>` a
shared stylesheet today with no build step.

This intersects the dynamic-loading work at exactly one point: **where the shared
style assets live and which origins can reach them.**

### Layering

- **`tokens.css` (foundation)** — variables only (Runes palette, type stacks),
  the Material Symbols `.mi` setup, and the minimal reset. Single source of truth.
  *Done (Phase 0):* extracted from `styles.css`, which now `@import`s it; the
  three existing tools `<link>` it (placed before their own `<style>`, so each
  tool's own `:root` still wins where it differs — appearance unchanged, shared
  tokens now available).
- **`kit.css` (components)** — base element styling + a handful of component
  classes (`.btn`, `.field`, `.card`, the title-strip convention) so tools look
  consistent without re-styling primitives. *Not yet built.*
- **Web-component primitives** (`<studio-field>`, …) — only if shared widgets
  outgrow CSS classes. Later/optional.

### Where it collides with dynamic loading

Bundled tools resolve `../tokens.css` fine (same `tauri://` origin). But
`tool://` user-dir tools have a *different origin*, so `../tokens.css` won't
resolve. The loading design must therefore serve the kit at a **stable,
origin-independent URL** — e.g. the `tool://` handler also serves a reserved
`/_kit/…` path from the bundled kit. This is the one new requirement the design
system adds to the dynamic-loading plan.

### Make it the default, not opt-in

Consistency should be guaranteed, not hoped for. Two levers:

- **Host-injected kit** — `open_tool_window_near` uses `.initialization_script()`
  (or injects a `<link>`) so *every* tool window gets tokens + base styling
  automatically, even tools that forgot. Tools opt into component classes for the
  richer bits.
- **A starter template** — a "new tool" scaffold that already links the kit and
  uses the title-strip convention. Since tools are largely Claude-generated,
  telling Claude "tools link `/_kit/kit.css`, use `.btn`/`.field`/`.card`" makes
  every generated tool consistent for free — probably the single biggest
  consistency win for a designer-who-builds-with-Claude.

### The tension

A design system slightly erodes the "fully self-contained single file" property —
a tool now depends on the kit being reachable. Keep the cost low: one small
*additive* stylesheet, tools degrade to readable browser defaults if it's missing,
and they stay single-file HTML (they just `<link>` one thing, or get it injected).

## Suggested implementation order

Lowest-risk, highest-value first:

0. **Extract `tokens.css`** — shared foundation for app + tools. ✅ *Done.*
1. **`kit.css` + starter template** — component classes and a scaffold so new
   (especially Claude-generated) tools are consistent by default.
2. **Live-list + watch** the user tools dir and rebuild the Tools submenu — kills
   the restart for the listing half. (Works for static/save tools immediately.)
3. **`tool://` scheme** so user-dir tools load with IPC/save intact — and serve
   the design kit at a stable `/_kit/…` URL reachable from that origin.
4. **`needs` declaration** in `Tools.json` to make categories first-class and gate
   command access.
5. **Project-read commands + pin-at-open** (`?project=…`) for the project-scoped
   category.

Native tools (tray icon / background loop) stay bundled throughout.

## Open questions

1. **Provenance** — are tools always Claude-generated into this repo, or do you
   want to drop in ones from outside? (Decides whether the repo-dir shortcut is
   enough, or the user-dir + `tool://` work is needed. User-dir is more uniform.)
2. **Project binding** — pin-at-open (recommended) vs follow-active?
3. **Concrete driver** — is there a specific tool being added right now that's
   pushing this? A real example would sharpen all of the above.
