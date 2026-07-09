# Mycelium — personal social graph + contact intake

A personal contact list stored as a **local social graph**. The main UI is an
open-canvas node graph: **trees** (hubs — an event, place, company, or a group
like "long-time friends") with **people** attached as nodes. Mycelium stores each
person's *preferred* contact info so it's easy to remember and keep in touch.

At events you share a **QR code / link**; the person opens a mobile page ("Hi,
nice to meet you"), sees *your* card, and fills in *their* contact info. Those
submissions land in a hosted inbox you can watch live on your phone, then **pull**
into the local graph under the right tree.

## Views & vocabulary

Two surfaces — the **Studio app** (desktop, yours) and the **web** (phone, mostly
guests). These are the canonical names for each view; use them in code, commits,
and docs.

### Studio (desktop — you)

| View | Name | What it is |
|---|---|---|
| The node graph | **Canvas** | the open, pannable/zoomable graph of everything |
| The hubs | **Trees** | a group: event · place · company · group |
| The dots under a tree | **People** (each a **Contact**) | one person node |
| The right-hand panel | **Inspector** | edits the selected Tree or Contact |
| Your own info editor | **My Card** | your contact card, shown to guests on Intake |

### Web (phone)

| View | Name | File | Who sees it |
|---|---|---|---|
| "Hi, nice to meet you" form | **Intake** | `public/index.html` (`/?t=<treeId>`) | guests |
| Full-screen QR you hold up | **Presenter** | `public/show.html` (`/show.html?t=…&name=…`) | you, at the event |
| Live feed of arrivals | **Inbox** | `public/inbox.html` (`/inbox.html?t=<treeId>`) | you |

### Shared terms

- **Submission** — one guest's send from Intake (stored on the server until pulled).
- **Sync** — the pull-and-clear that drains Submissions from the server into the
  Canvas as People.
- **Handoff QR** — the small QR in the Inspector that opens **Presenter** on your
  own phone (a QR of the Presenter URL, via `/api/qr?url=…`), as distinct from the
  **intake QR** guests scan (`/api/qr?t=…`).

## Architecture — two halves

Mycelium is deliberately split so PII exposure stays minimal:

- **Studio tool** (`src/tools/mycelium.html`) — the **source of truth for the
  graph**. Trees, people, edges, node positions, your notes. Stored locally in the
  app config dir as `mycelium.json` (Rust `read_mycelium` / `save_mycelium`, same
  global-store pattern as Daily Notes). Fully offline; the canvas is the point.
- **Vercel service** (`mycelium-web/`) — owns **only the intake pipeline**: the
  public intake page, the QR, and fresh submissions in a store (Upstash Redis)
  until you pull them. The public-facing pages (`/?t=<treeId>` intake, `/inbox`,
  `/api/qr`) live here. See `mycelium-web/README.md` for deploy + env.

**Sync is one-directional and pull-and-clear:** Vercel → Studio. A submission is
raw intake; pulling it into Studio turns it into a Person and marks it consumed on
the server. The relationship data (the graph) never leaves your Mac.

```
 phone (stranger)                 Vercel                    your Mac
 ┌──────────────┐  POST /api/submit ┌─────────┐  GET /api/pull ┌──────────────┐
 │ intake page  │ ────────────────▶ │ Upstash │ ◀───────────── │ Studio tool  │
 │ ?t=<treeId>  │                   │  (subs) │   (+ consume)  │ mycelium.json│
 └──────────────┘                   └─────────┘                └──────────────┘
        ▲                                │
   QR /api/qr?t=…                   /inbox (you watch live on your phone)
```

## Data model (the contract both halves build against)

### Local store — `mycelium.json`

```json
{
  "version": 1,
  "serverUrl": "https://mycelium-xxx.vercel.app",
  "me": {
    "name": "Mary Huang",
    "contacts": [
      { "type": "email",     "value": "me@example.com" },
      { "type": "instagram", "value": "@mary" }
    ]
  },
  "trees": [
    {
      "id": "tree_a1b2c3",
      "name": "Design Meetup — July",
      "kind": "event",          // event | place | company | group
      "date": "2026-07-10",     // optional, events
      "color": "#7a5cff",
      "x": 0, "y": 0,           // hub position on the canvas
      "createdAt": "2026-07-07T…Z"
    }
  ],
  "people": [
    {
      "id": "person_d4e5f6",
      "name": "Alex Rivera",
      "contacts": [
        { "type": "phone", "value": "+1 555 0100" },
        { "type": "linkedin", "value": "in/alexr" }
      ],
      "treeIds": ["tree_a1b2c3"],   // a person can belong to several trees
      "note": "met by the coffee table",
      "x": 120, "y": -40,           // position relative to primary hub (optional)
      "createdAt": "2026-07-07T…Z",
      "sourceSubmissionId": "sub_990011"  // null if added by hand
    }
  ]
}
```

### Submission — what the intake page produces, Vercel stores

```json
{
  "id": "sub_990011",
  "treeId": "tree_a1b2c3",       // baked into the QR link
  "createdAt": "2026-07-07T…Z",
  "name": "Alex Rivera",
  "contacts": [
    { "type": "phone", "value": "+1 555 0100" },
    { "type": "instagram", "value": "@alexr" }
  ],
  "note": "",                    // optional "where we met" from the visitor
  "consumed": false              // set true once pulled into Studio
}
```

### Contact `type` vocabulary

`phone` · `email` · `linkedin` · `instagram` · `x` · `website` · `other`
(`other` carries a freeform `label`). Consumers read leniently — unknown types
render as generic rows.

### QR / link shape

`https://<app>.vercel.app/?t=<treeId>` — the intake page reads `?t` to tag the
submission with its tree. `/api/qr?t=<treeId>` returns an SVG QR of that URL for
the Studio tool to display.

## Canvas interaction

- **Trees and people are draggable** (`wireNode()` in `mycelium.html`). Node
  elements are created once and updated in place across renders — never
  torn down/rebuilt — because removing a pointer-captured element from the
  DOM mid-drag silently ends its capture (WebKit/spec behavior) and kills
  the gesture after one move.
- **Person can belong to several trees** (`treeIds: []`), edited via a
  chip-list in the person Inspector (connect/disconnect), not a single-select.
- **Collision avoidance**: `resolveCollisions()` runs synchronously on every
  `render()` and nudges any two overlapping nodes apart — deterministic and
  timer-independent, so a node is correctly placed the instant it's created
  or moved, with no dependency on animation frames actually running (matters
  for a backgrounded/unfocused window).
- **Force-directed physics** (vendored `d3-force`, `src/vendor/d3-force.mjs`):
  a live `forceSimulation` spins up for two kinds of moments — a held-hot
  session while a node is being dragged (its edge-connected neighbors react
  elastically via `forceLink`/`forceCollide` instead of moving in rigid
  lockstep), and a one-shot "settle" for events that used to just teleport
  via `resolveCollisions()` (a tree getting selected, a person getting
  added). The two collision systems are complementary, not redundant: the
  manual resolver guarantees synchronous idle-state correctness; d3-force
  only runs for these specific, bounded, animated moments — it is
  deliberately **not** run continuously, to avoid the whole graph drifting/
  rearranging on its own or burning CPU at rest.
- **Add a person from the canvas**: selecting a tree shows a "+" node next
  to it (`updateAddPersonAffordance()`); clicking it reveals an inline name
  field — Enter creates the person and keeps the field open/focused for
  adding several in a row, Escape cancels. The open (or closed) field is
  itself treated as a pinned physics obstacle so new people don't spawn
  behind/under it.
- **Node centering**: `.node`'s `left`/`top` anchor is centered via a
  `.node-inner` wrapper's `transform: translate(-50%,-50%)` — never put that
  transform directly on `.node` itself, since `enter()`/`pop()` (kit motion)
  set an inline `transform` on whatever element they're given, which would
  silently clobber it and visually detach the node from its edge line.
- **Inspector panel is off by default** — toggled via the info (`ⓘ`) button
  in the top bar (`inspectorOn`); selecting a node still works normally
  underneath (drag, add-person, etc.) whether or not the panel is showing.

## Status

Phase 1 (this branch): local graph tool + data model + Vercel intake scaffold.
The Vercel half needs the user's account + Upstash creds to go live — see
`mycelium-web/README.md`. Phase 2 ideas: person↔person edges, avatars/photo
upload, "haven't talked to X in N months" nudges, calendar → auto-create a tree.
