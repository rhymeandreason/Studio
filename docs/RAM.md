## Memory display

- **Memory** — total system memory in use vs. installed, in GB (from
  `vm_stat` active+wired+compressed pages / `sysctl hw.memsize`).
- **Studio app** — Studio's own RSS via `ps -o rss=`.
- **Swap used** — current swap usage in MB, from `sysctl vm.swapusage` (no
  "total" — swap's total is a dynamic file size, not a meaningful ceiling).
  This is the "should I quit something?" signal — macOS keeps memory busy with
  disk cache even under no pressure, so memory-used alone is a poor proxy.
  Rising swap usage means real pressure.
- **Dev server** — RSS of the `tauri dev` watcher process (via `pgrep -f
  "tauri dev"`), hidden when not running (e.g. in a production build). There's
  no separate Vite/localhost server in this app — Tauri serves `frontendDist`
  directly.

Clicking the memory block opens `#memory-modal`, which re-fetches
`get_memory_stats` plus `get_top_processes` — the top 10 **apps** by summed
RSS (via `ps -axo rss=,comm=`, grouped by `.app` bundle so e.g. all of Chrome's
helper/renderer/GPU processes collapse into one "Google Chrome (12)" entry).
This is meant to surface background apps/processes the user might not realize
are running.
