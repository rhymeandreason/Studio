// Bridge client — how the chat runs when embedded as a panel in Studio.
//
// Embedded, this page lives in Studio's process, but Studio Claude (companion/)
// owns the `claude` processes and the session store. So instead of Tauri's
// invoke/listen, the page talks to Studio Claude over its local WebSocket
// bridge (companion/src-tauri/src/bridge.rs): same commands, same events.
//
// The port + token come from Studio Claude's `bridge.json`, read through the
// host window's Tauri (Studio's `read_text_file`). If Studio Claude isn't
// running (or the file is stale), we start it in the background via Studio's
// `launch_claude_app { background: true }` and keep retrying.

const BRIDGE_FILE = "Library/Application Support/com.studio.claude/bridge.json";

/**
 * @param {{ project: string, onStatus: (status: "connecting"|"connected"|"reconnected"|"disconnected") => void }} opts
 * @returns {{ invoke: (cmd: string, args?: object) => Promise<any>, listen: (event: string, fn: Function) => Promise<() => void> }}
 */
export function createBridgeClient({ project, onStatus }) {
    // Tauri is injected into the top-level frame only; borrow Studio's.
    const host = window.parent.__TAURI__;
    let ws = null;
    let seq = 0;
    let everConnected = false;
    const pending = new Map(); // id -> { resolve, reject }
    const outbox = []; // requests made while disconnected
    const handlers = new Map(); // event name -> Set<fn>

    async function readInfo() {
        const home = await host.path.homeDir();
        const text = await host.core.invoke("read_text_file", { path: `${home}/${BRIDGE_FILE}` });
        return JSON.parse(text);
    }

    function open({ port, token }) {
        return new Promise((resolve) => {
            const sock = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
            let opened = false;
            sock.onopen = () => {
                opened = true;
                ws = sock;
                onStatus(everConnected ? "reconnected" : "connected");
                everConnected = true;
                while (outbox.length) sock.send(outbox.shift());
                resolve(true);
            };
            sock.onmessage = (e) => {
                let msg;
                try {
                    msg = JSON.parse(e.data);
                } catch {
                    return;
                }
                if (msg.event) {
                    for (const fn of handlers.get(msg.event) || []) fn({ event: msg.event, payload: msg.payload });
                    return;
                }
                const p = pending.get(msg.id);
                if (!p) return;
                pending.delete(msg.id);
                if (msg.ok) p.resolve(msg.result);
                else p.reject(msg.error);
            };
            sock.onclose = () => {
                if (!opened) return resolve(false);
                ws = null;
                for (const p of pending.values()) p.reject("Lost connection to Studio Claude");
                pending.clear();
                onStatus("disconnected");
                connect(1);
            };
        });
    }

    let connecting = false;
    async function connect(attempt = 0) {
        if (connecting || ws) return;
        connecting = true;
        if (attempt === 0) onStatus("connecting");
        let ok = false;
        try {
            ok = await open(await readInfo());
        } catch {
            ok = false;
        }
        connecting = false;
        if (ok) return;
        // Not running (or a stale bridge.json from a previous run): start it
        // without a window, then retry. Ask right away on a fresh connect, on
        // the third try after a drop-out (a quick restart needs no help), and
        // now and then after that.
        if (attempt === 0 || attempt === 2 || attempt % 8 === 0) {
            host.core.invoke("launch_claude_app", { projectPath: project, background: true }).catch(() => {});
        }
        setTimeout(() => connect(attempt + 1), Math.min(400 * (attempt + 1), 3000));
    }

    function invoke(cmd, args = {}) {
        return new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            const frame = JSON.stringify({ id, cmd, args });
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
            else outbox.push(frame);
        });
    }

    function listen(event, fn) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
        return Promise.resolve(() => handlers.get(event)?.delete(fn));
    }

    connect();
    return { invoke, listen };
}
