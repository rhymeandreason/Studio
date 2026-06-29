# Tasks — concept

> **Status: not built. Direction doc.** Captures the design agreed in discussion
> so the spec is pinned before code. Sibling to [window-layouts.md](window-layouts.md).

## The reframe

**Modes** (today, in `workspace.js`) are per-project *window layouts* — record and
replay where windows sit. They are project-bound by construction.

A **Task** is the other thing people kept wanting to call a "mode" but isn't one:
a named **action bundle with a presence** that is *not* tied to a project. The
driving example is a **video meeting** — at the right moment a persistent
notification appears, you click it, and it opens the Meet/Zoom link plus any
related docs.

Tasks are a sibling concept to Modes, not a kind of Mode. Keep the names clean:

- **Mode** = a window arrangement (where things go).
- **Task** = an action bundle that fires at a moment (what happens).

They *can* compose later (a Task could end by applying a Mode), but they're
separate primitives.

## Not Schedules

Studio already has **Schedules** (`src/schedules/schedules.js`, global store at
`app_config_dir/schedules.json`). Schedules is for **background automation** —
cron-style time slots that fire headless work (`claude -p`) or open a tool. No
human in the loop at fire time.

Tasks are the opposite: **foreground and interrupting**. The whole point is the
surface — a notification that demands attention and launches things on click.
They also aren't triggered by Schedules' time slots; they're driven by the
**calendar**. So Tasks stay a separate subsystem with its own store and its own
trigger mechanism. Schedules stays as-is.

Two axes that were getting blurred, now separated:

| | Trigger | Presence at fire time |
|---|---|---|
| **Schedules** | time slots (cron) | none (headless / opens a tool) |
| **Tasks** | calendar event start (and manual) | a persistent notification |

## What a Task is

A Task is a small JSON file. It can be **auto-derived from a calendar event**, or
**hand-authored** (by the user in the Tasks window, or by Claude editing the
file).

```jsonc
{
  "id": "…",                       // stable id; for calendar Tasks, derived from eventId
  "source": "calendar",            // "calendar" | "manual"
  "eventId": "…",                  // calendar Tasks only — links back to the EKEvent, used for dedup
  "title": "Design review",
  "start": "2026-06-29T15:00:00",  // ISO; the moment the Task is "for"
  "location": "123 Main St",       // present → in-person (no join link)
  "actions": [                     // what fires on Join / launch
    { "kind": "url",  "target": "https://meet.google.com/…" },
    { "kind": "url",  "target": "https://docs.google.com/…agenda" },
    { "kind": "tool", "target": "notes" },
    { "kind": "app",  "target": "Figma" }
  ],
  "notify": {
    "leadMinutes": 2,              // fire the notification this many min before `start`
    "reason": ""                   // optional human note, e.g. "30 min transit + 5 buffer"
  }
}
```

- **Online meeting** → `actions` carries the join link, `leadMinutes` is a small
  fixed default (2).
- **In-person meeting** (`location` set, no join link) → `leadMinutes` is
  *transit + buffer*, the card says **"Leave now"**, `actions` may be empty. See
  "transit" below.

## Storage

Global, **not** project-bound — so it sits alongside Schedules:

- **`app_config_dir/tasks/<id>.json`** — one file per Task.

A directory of per-file Tasks (not one blob) because Claude is a first-class
author: it edits one Task in isolation without racing Studio's writes, and it's
diff-friendly. Mirrors how artifacts are discrete files Claude edits.

Backend commands parallel the Schedules ones: `list_tasks`, `read_task`,
`save_task`, `delete_task`.

**Disposability rule:** `source:"calendar"` Tasks are regenerated from the
calendar each poll and are disposable — a cancelled event removes its Task.
`source:"manual"` Tasks (user- or Claude-authored) persist and are never
clobbered by the calendar sync.

## Trigger: the calendar

macOS Calendar (which syncs the user's Google Calendar) via **EventKit**, read by
a native Swift helper compiled by `build.rs` and run as a subprocess — the
existing Studio pattern (`bgremove`, `winbounds`, `dayagenda`).

**Big head start:** `swift/dayagenda.swift` already reads EventKit and, crucially,
already handles the **macOS calendar-access permission prompt** (attributed to
Studio via Info.plist usage description) and the run-loop-pumping gotcha. The new
helper — call it **`calread`** — is `dayagenda` with richer output:

- emit `eventId` (for dedup), `start`/`end` as **ISO** (not just `HH:mm`),
  `notes`, and `url` in addition to `title`/`location`;
- window of the **next 7 days**, not just today (the user has few events/day, so a
  week is cheap to fetch and lets Tasks materialize well ahead of time).

Make it a *new* helper rather than editing `dayagenda`, so Daily Briefing's stable
output contract is untouched.

**Calendar scope:** all calendars (`calendars: nil`), filter later. A
calendar-selection setting is a future refinement, not v1.

**Poll cadence:** Studio polls `calread` every ~2–3 min; events in the next **7
days** get Tasks. Dedup by `eventId` — re-polling updates the existing Task rather
than spawning duplicates. (The notification still only *fires* at
`start − leadMinutes`; the week window is about how early the Task exists, not
when it interrupts you.)

### Join-link extraction

A meeting's join URL hides in `event.url`, `event.notes`, or `event.location`.
Regex for `meet.google.com`, `zoom.us/j/`, `teams.microsoft.com`. If found →
online Task with that link as the primary action. If only a physical
`location` → in-person Task.

## Surface: the persistent notification

The genuinely new UI: a small **always-on-top** window (built with the existing
`tool_style()` chrome system + `kit/window-chrome.js`) that appears at
`start − leadMinutes` and **persists** until acted on. Buttons:

- **Join / Go** — run the Task's `actions` (open URLs/apps/tools).
- **Snooze** — re-fire in 1 min.
- **Dismiss** — clear it.

For in-person Tasks the primary button is "Leave now" and the card shows the
transit reason.

## Claude as the Task brain

Native helpers provide **facts**; Claude provides **judgment**.

- **Facts:** `calread` (events), `transit` (ETA, below).
- **Judgment (Claude, editing Task files via a `studio-tasks` skill):**
  - interpret ambiguous events ("this 'sync' has a Zoom link in the notes →
    online Task"; "skip all-day events"),
  - attach related context the calendar entry lacks (the right Figma file, a
    project's docs, a Studio tool),
  - for in-person meetings, call `transit` and set `leadMinutes = ETA + buffer`
    with a human `reason`.

A **`studio-tasks` skill** (symlinked into `~/.claude/skills/`, like
`studio-artifacts`) documents the Task JSON shape and the `app_config_dir/tasks/`
path so Claude can author/edit Tasks directly. Changing the saved shape → update
the skill (same rule as artifacts).

Studio auto-creates *simple* online Tasks without Claude (so meetings still work
when Claude isn't running); Claude **enriches** (transit, related docs, buffers).

## Transit (in-person, deferred within this feature)

A Swift helper — **`transit`** — using **MapKit `MKDirections`** for a real ETA
(no API key, fits the `build.rs` subprocess pattern). Takes `from` / `to` /
`mode`, emits minutes. Claude orchestrates: detects an in-person event, asks for
ETA, writes `leadMinutes`. Native framework per the "prefer native macOS
frameworks" principle.

## UI surface

A **standalone tool window** under `src/tools/` (like Modes / Schedules) — lists
upcoming Tasks, supports add/edit and per-Task lead-time customization. Not a
main-window tab.

## Build order

1. ✅ **`calread` helper + Tasks store + tool window** — `swift/calread.swift`,
   `cal_read` + `list_tasks`/`save_task`/`delete_task`, `src/tools/tasks.html`.
   Auto-derives online/in-person Tasks, dedups by `eventId`, manual add.
2. ✅ **Persistent notification window** — `start_task_watcher`/`fire_due_tasks`
   (30s background thread) + `src/tools/task-notify.html`. Always-on-top card
   top-right; fires at `start − leadMinutes`; Join / Snooze / Dismiss.
3. ✅ **`studio-tasks` skill** — `skills/studio-tasks/SKILL.md`, symlinked into
   `~/.claude/skills/`. Documents the Task JSON shape + the
   `app_config_dir/tasks/` path so Claude can author/enrich Tasks directly.
4. ✅ **`transit` helper + in-person flow** — `swift/transit.swift` (CLGeocoder +
   MKDirections, driving/walking) + `transit_eta` command. Tasks tool stores a
   home origin/mode/buffer (`tasks-config.json`) and auto-computes in-person lead
   times during sync (cached via `notify.transitKey`); card shows "Leave now".

1–2 give the working meeting-notifier; 3–4 add the Claude brain and transit.

### Notification fire-state & lifecycle (built)

Fire-state lives in the Task file so it survives restarts and the 30s loop fires
each card exactly once:

- **Fires once** at `start − leadMinutes`; stamps `firedAt`. No re-nag.
- **Lingers** until the user acts — no auto-dismiss, even past `start`.
- **Snooze** sets `snoozeUntil` (+1 min); the watcher re-fires when it elapses,
  overriding the once-fired guard. Repeatable.
- **Stale cutoff:** won't pop a card after the meeting `end` (or `start + 15m`),
  so launching Studio late doesn't surface dead meetings.
- **Join** runs `actions` (`open_path` for URLs, `open_app`, `open_tool`) and
  closes; **Dismiss** just closes.

## Open questions

- **Manual vs calendar precedence** — if a manual Task and a calendar event
  describe the same meeting, do they merge or coexist? (Currently coexist.)
- **Multiple displays** — the card always opens on the primary monitor; should
  it follow the active/focused screen?
- **Card stacking** — each Task gets its own `tool-task-notify-<id>` window; if
  several fire at once they overlap at the top-right. Stack/offset them?
