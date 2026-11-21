# Deadlines

One global list of opportunities — grants, open calls, residencies,
fellowships — each with a due date and a link. Before this they lived as text
notes scattered across projects ("Mozilla AI Fellowship — LOI deadline Dec 17"
+ a link) and were hard to find again.

- **Store:** `~/Projects/deadlines.json` via the `deadlines` store
  (`read_store` / `save_store`; lib.rs `store_spec`). In the Projects root, next
  to `today.json`, so Claude finds and edits it. Shape documented in
  `skills/studio-tasks/SKILL.md` — change the shape → update the skill.
- **Shared module:** `src/deadlines.js` — load/save/add, `parseDue()` (pulls a
  date out of free text: "Nov 20", "Apply by Jan 31", "1/20/2027"; a year-less
  date is the next occurrence after the note was *written*, so old notes keep
  their old year; a date next to a cue word like "deadline" wins), and
  `deadlineFromNote()`.
- **Surface:** the Tasks window (calendar tray icon) has a Deadlines column on
  the right (stacks on top when the window is narrow). Upcoming sorted by date
  with a countdown (rose ≤3 days, accent ≤14), then *No date yet*, then folded
  *Passed* and *Done*. Click a row to edit inline; the hover checkbox marks it
  done (applied). `+` adds one by hand. Live: re-reads on `fs-changed` + focus.
- **Capture from anywhere:** right-click a note in any project → *Add to
  Deadlines* (`addNoteToDeadlines` in main.js). Title, first link and parsed
  date come from the note; `project` + `noteId` point back at it. Capturing the
  same note again updates instead of duplicating.

Deadlines don't fire notifications (Tasks do). If that's wanted later, the
natural hook is the existing Task watcher — e.g. a manual Task N days before
`due`.
