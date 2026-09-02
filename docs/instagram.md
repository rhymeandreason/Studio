# Instagram Saved

A tool that pulls the signed-in Instagram account's **saved posts** (and the
collections they're filed under) into a local, offline-browsable grid.

Instagram has no public API for saved posts, so this replays the same
endpoints instagram.com's own JavaScript calls, authenticated with the cookies
from a login you do inside a native Studio webview. That is against
Instagram's terms of use; it's built for the one account of the one user of
this app, with pacing between requests so it doesn't look like a scraper
burst. If Instagram changes its web endpoints, `instagram.rs` is where to fix
it.

## Pieces

The split follows Studio's layer rule (CLAUDE.md → Conventions): Rust only
does what needs the OS; everything that can break against Instagram lives
in the page so a fix is a reload, not an app restart.

- `src-tauri/src/instagram.rs` — ~150 lines, rarely changes:
  - `instagram_open_login` / `instagram_close_login` — a plain
    `WebviewUrl::External` window (label `instagram-login`) at
    instagram.com's login page. No Tauri IPC is injected into it; its only
    job is to fill the cookie jar. WKWebView keeps cookies in the app-wide
    data store, so they persist across launches and are readable from any
    webview.
  - `instagram_session` — reads the instagram.com cookies and reports
    `logged_in` (`sessionid` + `ds_user_id` present) and whether the login
    window is open. Uses `Webview::cookies()` filtered by domain suffix, not
    `cookies_for_url` — wry matches the cookie domain against the host
    *exactly*, and the session lives on `.instagram.com`.
  - `instagram_fetch { path }` — GET `https://www.instagram.com<path>` with
    the session `Cookie`, `x-ig-app-id`, `x-csrftoken`, a Safari user agent;
    returns the raw body. (The page can't fetch instagram.com itself: it runs
    on a `tauri://` origin, so the browser blocks the cross-origin request
    and wouldn't attach the cookies.)
  - `instagram_download { url, dest }` — writes a CDN image/video to `dest`,
    creating parent dirs; a file already there is left alone (returns false).
  - `instagram_cache_dir` — `$APPCACHE/instagram-thumbs/`.
- `src/tools/instagram-saved.html` — everything else:
  - **Pull** (`pullBatch`) is **resumable, 100 posts per run** — a 1500-post
    library is pulled in sittings, and the grid fills in as it goes. The
    store carries a `cursor` `{ phase, max_id, col_index, col_max_id, seen,
    incremental }` and is saved after every page, so a restart loses nothing.
    Phases: `posts` — `/api/v1/feed/saved/posts/` (newest-saved first,
    `max_id` cursor, percent-encoded — it's base64 with `=`); then
    `collections` — `/api/v1/feed/collections/list/` and each collection's
    `/feed/collection/<id>/posts/` in turn, tagging items with names; then
    `done`. Each batch also caches a ~480px thumbnail per new post as
    `<cache>/<id>.jpg` (CDN URLs expire in days; the cache is what keeps the
    grid working later). Bar: **Pull next 100** (→ *Pull new* once done: a
    fresh walk from the top that stops at the first fully-known page),
    **Keep going** toggle (batches back to back until done, persisted in
    localStorage), **Stop** (after the current page), **Restart pull** (full
    re-walk; posts no longer saved drop out when it finishes). 450ms between
    pages.
  - **Store**: `instagram-saved` (`store_spec` in lib.rs →
    `~/Library/Application Support/com.studio.app/instagram-saved.json`),
    read/written with `read_store` / `save_store`:
    `{ version, pulled_at, username, items: [item], collections: [{ id, name, count }] }`.
    An item keeps id/code/url, `media_type` (1 photo · 2 video · 8
    carousel), caption, username, cached `thumb` path plus the (expiring)
    `thumb_url` / `image_url` / `video_url`, `like_count`, `collections`.
  - **UI**: sign-in card → login window (polls `instagram_session` every 1.5s
    until a session appears, closes the window, starts the first pull).
    Collection chips + caption/user search filter client-side. Click a post
    → **viewer modal**: shows the cached thumb at once, re-resolves the post
    via `/api/v1/media/<id>/info/` (fresh CDN URLs + carousel children),
    downloads the full-size frame(s) to `<cache>/<id>-full[-n].jpg` and swaps
    them in; ←/→ or arrows step a carousel, Esc / backdrop closes. Buttons:
    *Instagram* (`open_path` → default browser) and *Save* (full-size media
    into the active project's `media/instagram/` as `<code>[-n].jpg|mp4`;
    also on tile hover).
    A failed pull stays on the card in red (not just a toast).

## Requests

Every `/api/v1` call sends the session `Cookie`, `x-ig-app-id:
936619743392459` (instagram.com's web app id), `x-csrftoken` from the jar and
a Safari user agent. 401/403 → "sign in again"; 429 → rate-limited, try
later; an HTML body where JSON was expected → the page reports it as a
login/rate-limit page (Instagram serves those with 200).

## Not done / ideas

- No in-app sign-out; open the Instagram window and log out there.
- Collections are re-walked in full each pull (their membership changes);
  a big library with many collections is the slow case.
- Reels saved from the Reels tab show up in the same feed; nothing special
  is done for them beyond the play badge.
