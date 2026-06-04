# Studio — Backlog

Deferred ideas and follow-ups, captured during the build. Not scheduled.

## UI / polish
- **Vendor Material Symbols locally.** Icons currently load from Google Fonts
  (Material Symbols Rounded), so they need network — offline they degrade to
  ligature text. Bundle the icon font (woff2) into `src/vendor/` and serve it
  locally so the UI works fully offline. Same applies to confirming Futura is
  always available vs. shipping a fallback.
