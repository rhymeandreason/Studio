# Studio features

A quick tour of what Studio can do.

## Projects
- Manage multiple projects, each with its own workspace, notes, and media.
- Click a project card to open it; the selected card is highlighted.

## Workspace tab
- A per-project launchpad: links to the repo, Figma file, apps, files,
  folders, and URLs.
- One-click **Launch** opens everything at once (repo in your chosen editor,
  Figma, apps, files, folders, URLs).
- Pin a tab (Workspace / Media / Notes) to open automatically for a project.
- **Modes**: record the current window layout (which apps are open and where),
  then replay it later with one click. Play reopens anything that's closed and
  hides everything else, so you can snap back into a saved setup instantly.
  Modes can be renamed and show when they were last saved.

## Notes
- A bento-grid corkboard of notes: text, checklists, tables, and images.
- Resize notes (small/medium/large) and drag to reorder.
- Per-note color themes and custom title/body fonts.
- Toggle between **Bento** view (variable-size grid) and **Days** view
  (square cards grouped by date) — remembered per project.
- Links typed or pasted into notes/captions become clickable pill buttons.
- Copy/paste notes between projects.

## Media
- Browse images in your project's media folders with thumbnails.
- Built-in **non-destructive image editor**: crop, rotate, straighten, and
  tonal adjustments — originals are untouched until you export.

## Artifacts
- A per-project gallery of **design artifacts** — reusable design decisions like
  **brand kits** (a font pairing with weights + a color palette).
- Build one yourself in the **Brand Explorer** tool (browse Google Fonts, pick a
  palette), or ask **Studio Claude** to generate a batch of distinct directions —
  they show up in the panel live as it writes them.
- Click an artifact to open it in its editor and tweak it.

## Claude (Studio Claude)
- Run Claude Code sessions in a dedicated chat window, scoped to your project.
  Launch it from the **Claude** button in the project header.
- It's a standalone app, so it survives Studio rebuilds — and you can have **one
  window per project open side by side**.
- Choose where Claude works per session: **Artifacts** (the project folder, for
  design/brand work) or **Code** (the project's git repo).
- Multiple sessions as browser-style tabs; rename, delete, and resume past
  sessions (including ones started outside Studio).
- Pick the model (Sonnet/Opus/Fable/Haiku) and permission mode
  (Ask/Accept edits/Plan/Bypass) per session.
- Live progress while Claude works, with a stop button to interrupt.
- Usage meters: context window for the current session, plus your account's
  5-hour and 7-day quota.
- Select and copy text from the chat transcript.

## Tools
- A dedicated wrench-icon tray dropdown of small single-purpose utilities,
  each in its own window — Brand Explorer, the Design System styleguide,
  Bento Grid, Daily Notes, File Directory, and the RAM overview.
- **File Directory**: a vertical file tree for the active project. Opens code
  files in the Code Editor, design artifacts in their matching Studio tool,
  and plain HTML files in the browser; remembers which folders you had open.
- They share Studio's look (the "Runes" design kit) and work fully offline.
- Exports and artifacts save straight into your active project's folder.
- **Spotlight launcher**: press **Option+Space** anywhere to bring up a
  floating, transparent search palette listing every tool and project.
  Type to filter, arrow keys + Enter (or click) to open; Escape or clicking
  away dismisses it.
- **Mode switcher**: press **Ctrl+Space** anywhere for a giant-text,
  full-screen list of the active project's Workspace Modes. Arrow keys +
  Enter (or click) applies a mode's window layout; it opens on the mode you
  used last. Press **Tab** on a highlighted mode to reveal a **Record**
  button — Enter then snapshots your current windows into that mode (same as
  the Workspace tab's record), without capturing the Spotlight/switcher
  overlays themselves. If no project is active, it shows the project list to
  pick one first. Escape or clicking away dismisses it.

## Scheduled tasks
- Schedule Claude Code tasks to run automatically, grouped into two shared time
  slots; each task picks the project it runs in (or "Global"). Open it from the
  wrench-icon tray dropdown or the Schedules button.
- Saving the schedule wakes the Mac ahead of upcoming runs (one admin-password
  prompt) so they fire even while it's asleep.

## System info
- Live memory, swap, and dev-server usage in the project header, with a
  detailed modal showing top processes.

## Daily journal
- Ask Claude to write a concise end-of-day summary of the day's work.
