# Window layouts — concept

> **Status: we've done most of this idea in the Mode Switcher
concept / not built.** This captures the direction for what the
> Workspace tab is *really* for. Today's Workspace (a card grid + a Launch
> button that opens apps without placing them) is a degenerate first draft of
> the idea below. Nothing here is implemented yet.

## The reframe

Workspace was never meant to be a bookmark launcher. The actual want is a
**window choreographer**: switch between projects and work modes and have every
application window land where it belongs — and *stop the jumble* that macOS
creates when a display is plugged or unplugged.

So an "app" in a project isn't a shortcut. It's a **window with a remembered
place**. "Launch" isn't "open everything" — it's "restore this arrangement."

## The core trick: memory keyed on screen geometry

The naive version tries to be smart — reflow a big-monitor layout down to fit a
laptop screen. That path is always slightly wrong and infuriating. We don't do
that.

Instead, a layout is a pure function of **(project × mode × which screens are
attached)**. Studio doesn't *resize* anything intelligently; it *remembers a
different arrangement you authored for each world* and replays it. No
intelligence, just lookup.

There are exactly **two worlds** (the author uses one Apple Studio Display plus
the laptop screen — a binary, so no combinatorial explosion):

- **Studio Display attached** — *spatial*. Everything visible at once, tiled;
  you glance across the screen. **This doc scopes this world only.**
- **Bare laptop** — *focus*. You can't see everything on 13", so the "layout" is
  really a subset of apps foregrounded with the rest out of the way, and you
  switch between them. This is a **significantly different feature** (different
  mechanism, harder on macOS) and is **deferred** — see "Why the laptop is
  separate" below.

## Work modes = named layouts

The "chunks of work" in a project — **Code** (Claude + Git), **Planning**,
**Documenting** — are not new content surfaces. They're **named window
arrangements**. "Code mode" might be *editor left, terminal right, Git window in
the corner, Figma on the second half*. "Documenting" is *docs editor here, repo
there* — not a new editor Studio has to build.

This is the key economy: modes mostly cost a saved layout, not a new tool. It
also keeps Planning/Documenting from re-implementing Notes/Media.

## Authoring: capture by example

Studio is a **tape recorder, not a layout editor.** You do **not** describe
positions in a form. You:

1. Arrange your app windows by hand on the Studio Display, the way you want them
   for this project + mode.
2. Hit **Capture**.
3. Studio records every relevant window's frame (app, position, size) for the
   current display signature.

**Replay** = read those frames back and set them. Authoring is by demonstration;
the machine just plays back the tape.

## How it works on macOS (Studio Display world)

Moving and sizing *other apps'* windows is the macOS **Accessibility API**
(`AXUIElement`): with Accessibility permission granted, you can read a window's
frame (`AXPosition` / `AXSize`) and write it back — for any app, no SIP changes
required. This fits Studio's existing pattern of **native Swift helpers compiled
by `build.rs` and called as subprocesses** (`bgremove`, `qlthumb`, `pbimage`):

- A new helper — call it `winlayout` — that can:
  - **capture**: enumerate visible windows of running apps and emit
    `{ app, title, x, y, w, h }` for the current screen.
  - **apply**: take a saved list and set each window's position/size.
- Studio's own windows (Claude, Git, the main window) it already places
  directly via Tauri — those can be part of a layout without the helper, or be
  driven the same way for uniformity.

Display-change detection (which world are we in?) comes from the screen
configuration — Studio watches for display reconfiguration and reads the set of
attached screens to pick the matching layout. For the Studio Display world the
signature is simply "the Studio Display is present."

## Data model (sketch)

Per project (in `workspace.json`, or a sibling `layouts.json`):

```
layouts: {
  "<mode>": {                     // "code", "planning", "documenting", …
    "studio-display": [           // the display signature
      { app: "Zed",    x, y, w, h },
      { app: "Figma",  x, y, w, h },
      { app: "Terminal", x, y, w, h },
      …
    ]
    // "laptop": …  (deferred)
  }
}
```

- A **mode** is a named arrangement.
- Each mode holds one arrangement **per display signature**.
- Windows are matched to apps by bundle id / app name (title optionally, for
  multi-window apps — an open question, see below).

## Recover vs. switch

Two uses share the same machinery; both are in scope for the Studio Display
world:

- **Recover** — "re-tidy what's already open." The painkiller: you unplug/replug
  or things drift, you summon the layout, windows snap back. This is the one the
  unplug-jumble story is really about.
- **Switch** — "swap the whole window set for project/mode B." The vitamin: nice
  for moving between contexts.

Recovery is the higher-value half and the one to validate first.

## Automatic vs. summoned

Start **summoned**: you hit a key or click a mode, and the layout applies.
**Automatic** re-layout on display change is the dream but will enrage the one
time it fires mid-drag — earn that with trust later, behind an explicit opt-in.

## Build vs. delegate

Open question. Existing tools (yabai, Moom) already move windows; Studio could
be the **per-project brain** on top of one of them rather than reimplementing a
window manager. The Swift `AXUIElement` helper above is the "build it" path and
keeps Studio self-contained (and avoids yabai's SIP requirements), at the cost
of inheriting macOS window-management edge cases. Lean build for the
Studio-Display-only frame-setting case (it's the tractable part); revisit before
the laptop world.

## Why the laptop is separate (deferred)

The laptop world is **not** "the same layout, smaller." It's *subset + focus*:
which apps are even present/foreground, with the rest hidden, and a way to
switch. That maps onto **macOS Spaces and app-hiding** — the part macOS
deliberately won't let you automate cleanly (no public Spaces API; yabai leans
on disabling parts of SIP; fullscreen/hide via AX is janky). So despite being
"fewer windows," it's the *harder, different* mechanism: managing
focus/visibility, not setting frames. The honest version is likely a **"focus
mode"** (fullscreen/foreground the mode's primary app, hide what doesn't belong)
rather than restoring a Spaces arrangement. Decide its real shape only after the
Studio Display world proves out.

## Open questions

- **Multi-window apps** (browsers, editors with several windows): match by
  title? by order? Just the frontmost? This is the messiest matching problem.
- **App not running at replay time**: launch it first, then place once its
  window appears (needs a wait/retry), or skip it?
- **Capture granularity**: every running app, or only the apps already on the
  project's card list?
- **Where layouts live**: inside `workspace.json` vs. a dedicated store.
- **Does a "mode" replace the current Workspace card lists**, or sit alongside
  them? (Likely: modes *are* the new Workspace; the app/file/url cards become
  the membership list a layout draws from.)
