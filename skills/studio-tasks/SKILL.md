---
name: studio-tasks
description: Create, edit, or enrich Studio Tasks — calendar-driven or manual meeting/reminder notifications that pop a persistent card at a lead time and open links/apps/tools. Use when asked to add a Task, change a notification lead time, attach links or context to a meeting, set up a "leave now" alert for an in-person event, or otherwise manage Studio's Tasks.
---

# Studio Tasks

Studio (a macOS menu-bar design app) has a **Tasks** subsystem: each Task pops a
persistent, always-on-top notification **card** at `start − leadMinutes`, and its
**Join/Open** button runs the Task's actions (open a Meet/Zoom link, launch an
app, open a Studio tool). Tasks are most often **calendar meetings**, but can be
hand-authored. See `docs/tasks.md` in the Studio repo for the full design.

Tasks are **global, not project-scoped**. Each Task is one JSON file:

```
~/Library/Application Support/com.studio.app/tasks/<id>.json
```

Write/edit these files **directly** (absolute path above — you are usually *not*
cwd'd there). Studio's background watcher (every 30s) and the Tasks tool window
read the same files live; no rebuild or restart needed for a Task change.

## Task shape

```json
{
  "id": "man-2026-07-02-standup",
  "source": "manual",
  "title": "Standup",
  "start": "2026-07-02T16:30:00Z",
  "end": "2026-07-02T16:45:00Z",
  "location": "",
  "actions": [
    { "kind": "url",  "target": "https://meet.google.com/abc-defg-hij" },
    { "kind": "url",  "target": "https://docs.google.com/…agenda" },
    { "kind": "tool", "target": "daily-notes.html" },
    { "kind": "app",  "target": "Figma" }
  ],
  "online": true,
  "inPerson": false,
  "notify": { "leadMinutes": 2, "reason": "" }
}
```

Fields:
- **`id`** — also the filename (`<id>.json`). Must be a slug: ASCII letters,
  digits, `-`, `_` only. For hand-made Tasks prefix `man-`. Never reuse a
  `cal-…` id (those are owned by the calendar sync — see below).
- **`source`** — `"manual"` for ones you author, `"calendar"` for sync-derived.
- **`title`** — shown on the card.
- **`start`** / **`end`** — ISO-8601 with timezone (UTC `…Z` is fine). `start` is
  when the Task is *for*; the card fires `leadMinutes` before it. `end` (optional)
  sets the stale cutoff — after it, a missed card won't pop. Defaults to
  `start + 15m` if omitted.
- **`actions`** — ordered list run on Join/Open. `kind`:
  - `"url"` → opened in the default browser (Meet/Zoom links, docs).
  - `"app"` → `target` is an app name (`open -a "<name>"`), e.g. `"Figma"`.
  - `"tool"` → `target` is a Studio tool filename (as in `Tools.json`), e.g.
    `"daily-notes.html"`, `"daily-briefing.html"`.
- **`online`** — `true` if it has a join link (card says "Join"). **`inPerson`** —
  `true` for a physical-location event (card says "Leave now"). Set one, not both.
- **`location`** — physical address for in-person Tasks (also shown on the card).
- **`notify.leadMinutes`** — minutes before `start` to fire the card. Online
  default 2; in-person should be **transit time + a buffer** (see below).
- **`notify.reason`** — optional human note shown on the card (e.g.
  `"28 min drive + 5 buffer"`). For in-person it replaces the card's eyebrow.
- **`notify.leadEdited`** — set `true` when you (or the user) deliberately choose a
  lead time on a **calendar** Task, so the calendar sync preserves it instead of
  resetting to the default.

## Calendar Tasks vs manual — don't fight the sync

`source:"calendar"` Tasks are **regenerated from the calendar** by Studio on every
sync (id = `cal-<sanitized eventId>`). If you edit one:
- **Safe to change:** `notify.leadMinutes` (also set `notify.leadEdited: true`),
  and **adding** `actions` (extra docs/links) — these survive a resync.
- **Don't** change `title`/`start`/`end` on a calendar Task — the sync overwrites
  them from the event. To add a meeting the calendar doesn't have, make a
  **`source:"manual"`** Task instead.

## Enriching a meeting (the common ask)

When the user asks you to "set up" or "get ready for" a meeting:
1. Read its Task file (or the user's description) — note online vs in-person.
2. **Online:** add the relevant working links to `actions` (the agenda doc, the
   Figma file, a Studio tool like `notes.html`). Keep the existing join link.
3. **In-person:** Studio auto-fills travel time from the user's configured origin
   (set in the Tasks tool's transit settings) — it sets `notify.leadMinutes =
   ETA + buffer`, a `notify.reason` like `"28 min driving + 5 min buffer"`, and
   `notify.transitKey` (the origin/mode it was computed for). To **override**
   (different start point, extra padding, a stop on the way), set your own
   `notify.leadMinutes` **and** `notify.leadEdited: true` so the auto-transit pass
   leaves it alone. If the user gives you an address Studio can't resolve, ask
   for a nearby landmark or their own time estimate and state your assumption.

After writing a file, the change is picked up automatically — tell the user it's
set and when the card will fire.
