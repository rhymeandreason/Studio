# Plan

A skinny vertical planner: the project's next weeks, top to bottom, with short
notes under each week. `src/tools/plan.html` — one file, kit-styled, custom
chrome. It's both the **Plan tab** in the main window (`data-tab="plan"`,
embedded as an iframe like File Directory) and a standalone tool window
(Option-click the tab, or the wrench menu → Plan).

## Data — `plan.json` per project

```json
{
  "version": 1,
  "start": "2026-08-10",
  "end": "2026-10-12",
  "notes": [{ "id": "p-…", "week": "2026-08-10", "text": "Ship the dock", "done": false }]
}
```

`week` is **always the ISO date of that week's Monday** — the only field tying
a note to a row, so a drag between weeks is a one-field write. `start`/`end`
are Mondays too; whatever is on disk is normalized through `monday()` on load,
so a hand-edited `plan.json` with any day of the week still lands correctly.
Read/written by `read_plan` / `save_plan` in `src-tauri/src/lib.rs` (mirrors
`read_notes` / `save_notes`); saves are debounced 400ms.

Notes are kept even when their week falls outside the visible range — a footer
line counts them rather than deleting or clamping them.

## Behaviour

- **Weeks** run Monday–Sunday, labelled `Aug 31 – Sep 6`. The current week is
  accented; the `today` button scrolls to it.
- **Today marker** — a hairline accent track under the current week's header,
  filled to this moment's fraction of the Mon→Sun span with a dot at the head
  (Friday noon ≈ 64%) and "Aug 14" printed under the marker — centered on it,
  except within 6% of either end, where it anchors to that edge instead of
  spilling out of the column. A one-minute tick moves it, and re-renders outright when
  the current Monday changes, so a plan left open overnight re-dates its rows
  and the marker lands on the next week instead of pinning at 100%.
- **Nothing live in the title bar.** `window-chrome.js` deletes
  `[data-window-bar]` when the page is embedded as the panel iframe, so the
  `today` button and the date fields all live in the row *below* it — the first
  version put `today` in the bar and the whole script died on a null lookup,
  leaving the panel blank.
- **Range** defaults to this Monday + 8 weeks (~2 months) and is customized by
  the two date fields under the bar. Either input snaps to its Monday, and
  moving one end past the other pushes the opposite end 8 weeks along rather
  than leaving an empty range.
- **Add** via the `+` that appears on week hover; the new note opens straight
  into edit mode and an empty commit deletes it. Double-click to re-edit;
  Enter commits, Shift+Enter newlines, Escape reverts.
- **Done** is the dot on the left; right-click gives Edit / Done / Delete
  (`kit/context-menu.js`).
- **Events.** A note whose text contains a date renders that substring — and a
  time, if it has one — as chips: `Demo Day 10/5` → `Demo Day [Oct 5]`. Nothing
  is stored on the note; the chips are a *rendering* of ranges `parseEvent()`
  found in `note.text`, which stays the source of truth. Clicking a chip drops
  the row back to the raw text with the caret at the end of the match.
  Recognized: `10/5`, `10/5/26`, `Oct 5` / `Oct 5th` / `5 Oct`, and times
  `3pm` / `10:30am` / `15:00` (a time only chips inside a dated note — a bare
  `10:30` elsewhere is more likely a score than a meeting). A bare M/D takes
  the nearest year, tolerating a month in the past before it rolls forward.
- **The date files the note.** Typing a date moves the note to that date's
  week, on commit and on load — so a hand-written `plan.json` doesn't have to
  compute Mondays. Dated notes head each week in date order, undated ones
  follow in insertion order. Dragging a dated note to another week **rewrites
  its date** (same weekday, shifted by the weeks travelled) in the format it
  was typed in — `9/21` stays slashed, `5 Sep` stays a name.
- **Drag between weeks** uses pointer events, not HTML5 drag (Tauri's file-drop
  swallows `dragstart` — same reason as notes reorder). A 4px threshold
  distinguishes a drag from a click, a `#ghost` follows the pointer, the week
  under it highlights, and the column auto-scrolls near its top/bottom edge.

Notes are plain text today; lists and per-note dates are the obvious next step
and fit the schema without a migration (new optional fields on a note).

## Wiring

- Tab + panel: `src/index.html` (`#plan-btn`, `#plan-frame`), lazy-loaded in
  `selectTab()` in `main.js`.
- Pop-out: `initTabPopOut("plan-btn", "plan.html")` in `workspace.js`, capture
  phase so Option-click beats the generic tab handler.
- Window style: the `"plan.html"` row in `tool_style()` — 350×760, project tint.
- Listed in `Tools.json`.
