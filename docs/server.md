# Server tool

A per-project tool window that starts/stops the repo's dev server and shows an
oscilloscope waveform while it's running. Replaces the old inline Start/Stop
buttons on the Workspace repo card. Files: `src/tools/server.html` (the window),
plus the `server_status` / `dev_pid_alive` / `repo_dev_url` commands and the
`server.html` `tool_style` row in `src-tauri/src/lib.rs`.

## Opening it

The repo card's **Server** button (`src/workspace.js`) opens the tool via
`invoke("open_tool", { file: "server.html" })`. The button shows only when the
repo has a `dev-open.sh` or `dev-stop.sh` (checked via `repo_scripts`). The tool
also lives in the wrench-tray Tools menu (`Tools.json`).

It's a project-tinted Custom-chrome window (`Tint::Project`, 240×440) that
follows the **active project**: it listens for `project-activated` and re-reads
the repo, color, and dev URL, retinting live. The whole top bar (including the
port/name label) is draggable; the label is display-only.

## Start / stop (convention: `dev-open.sh` / `dev-stop.sh`)

No per-project Studio config — the tool drives the same repo-root scripts the
repo card used to:

- **Start** runs `dev-open.sh` (via `run_script`, which spawns the file directly
  so its shebang runs, cwd = repo root).
- **Stop** runs `dev-stop.sh`.

The scripts are detached, so **the server keeps running when you switch active
projects** (or close the tool, or restart Studio) — nothing ties it to the
project-activation lifecycle. Switching projects just points the tool at the new
project's server.

## Running detection (two modes)

The waveform and the play/stop glyph reflect whether the server is actually up,
polled every 2s. The tool auto-selects a mode when it loads the project:

- **`port` mode** — `repo_dev_url(repo)` parses a port out of `dev-open.sh`
  (`PORT=3000`, `--port 5173`, `--port=5173`, `-p 8080`, `localhost:3000` /
  `127.0.0.1:` / `0.0.0.0:`). `server_status(url)` then does a short-timeout TCP
  connect to that host:port. Zero extra setup for a web dev server; the title
  shows `host:port`. True regardless of who started the server.

- **`pid` mode** — used when `dev-open.sh` exposes no parseable port (e.g. a
  Tauri app's `npm run tauri dev`, which serves from `tauri://localhost`).
  `dev_pid_alive(repo)` reads the PID that `dev-open.sh` wrote to `<repo>/.dev.pid`
  and tests it with `kill -0`. The title shows the project name. This is
  per-project and unambiguous — deliberately *not* a `pgrep "tauri dev"` pattern,
  which can't tell two Tauri sessions apart (and would misread the running
  Studio itself). `.dev.pid` is gitignored.

### Writing scripts for a port-less (e.g. Tauri) project

`dev-open.sh` must record the launched PID so `pid` mode can track it:

```sh
#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
nohup npm run tauri dev >/tmp/myapp-dev.log 2>&1 &
echo $! > .dev.pid
```

`dev-stop.sh` kills it and clears the file:

```sh
#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
pkill -f "target/debug/myapp"   # scope to this app's binary
rm -f .dev.pid
```

`chmod +x` both. A project *with* an HTTP dev port needs neither the PID file nor
this ceremony — `port` mode reads the port from `dev-open.sh` and probes it.

> Note: this is impractical for Studio's *own* repo — you can't usefully
> start/stop the app you're working in, and its Stop would kill the running
> Studio. It's meant for other projects.
