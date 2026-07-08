# Mycelium — personal social graph + contact intake

A personal contact list stored as a **local social graph**. The main UI is an
open-canvas node graph: **trees** (hubs — an event, place, company, or a group
like "long-time friends") with **people** attached as nodes. Mycelium stores each
person's *preferred* contact info so it's easy to remember and keep in touch.

At events you share a **QR code / link**; the person opens a mobile page ("Hi,
nice to meet you"), sees *your* card, and fills in *their* contact info. Those
submissions land in a hosted inbox you can watch live on your phone, then **pull**
into the local graph under the right tree.

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

## Status

Phase 1 (this branch): local graph tool + data model + Vercel intake scaffold.
The Vercel half needs the user's account + Upstash creds to go live — see
`mycelium-web/README.md`. Phase 2 ideas: person↔person edges, avatars/photo
upload, "haven't talked to X in N months" nudges, calendar → auto-create a tree.
