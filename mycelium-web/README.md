# mycelium-web

The public intake half of **Mycelium** (see `../docs/mycelium.md`). A tiny Vercel
app: strangers open the intake page from your QR, share their contact info, and it
lands in a store the Studio Mycelium tool pulls from. You own all the infra — no
third-party form service.

## What's here

| Path | Purpose |
|---|---|
| `public/index.html` | Intake page — `/?t=<treeId>`. Shows your card, collects theirs. |
| `public/show.html`   | Presenter page — `/show.html?t=<treeId>&name=<label>`. Full-screen QR you hold up for guests; keeps the screen awake. |
| `public/inbox.html`  | Live inbox — `/inbox.html?t=<treeId>`. Watch contacts arrive on your phone. |
| `public/me.json`     | **Your** card shown on the intake page. Edit this. |
| `api/submit.js`      | `POST /api/submit` — stores a submission. |
| `api/pull.js`        | `GET /api/pull?tree=…` — returns + consumes (clears). `&peek=1` to read without clearing. |
| `api/qr.js`          | `GET /api/qr?t=…` (intake QR) or `?url=…` (handoff QR) — SVG. |
| `api/vcard.js`       | `GET /api/vcard` — your card (from `me.json`) as a `.vcf`; the Intake "Save my contact" button opens the guest's native Add-Contact screen. |
| `lib/store.js`       | Upstash Redis, keyed per tree. |

## Deploy (once)

1. **Create the store.** In the Vercel dashboard → Storage → add **Upstash Redis**
   (free tier) and connect it to this project. That injects
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` automatically.
2. **Deploy.** From this folder: `npx vercel` (link/create the project), then
   `npx vercel --prod`. Or push to a GitHub repo and import it in Vercel with the
   **root directory** set to `mycelium-web`.
3. **Set your card.** Edit `public/me.json` with your name + contacts and redeploy.
4. **Point Studio at it.** Copy the deployment URL (e.g.
   `https://mycelium-xxx.vercel.app`) into the Mycelium tool → **Settings → server URL**.

## Flow

- In Studio, make a tree → its inspector shows the intake QR plus a **"Show on
  your phone"** handoff QR. Scan that with your own phone to open `show.html` —
  a full-screen QR you hold up for guests.
- Someone scans it → intake page tagged with that tree → they submit.
- Open `/inbox.html?t=<treeId>` on your phone to watch them arrive live.
- Back in Studio, the tree's **Pull new contacts** button drains the store into
  the local graph as person nodes (deduped by submission id).

## Notes

- `pull` **consumes** by default (clears after returning) so contacts can't be
  double-imported; the live inbox uses `peek=1` so it never drains the store.
- PII lives only in your Upstash instance, transiently, until you pull. The graph
  itself never leaves your Mac.
- Local dev: `npx vercel dev` (needs the Upstash env vars in `.env` or linked).
