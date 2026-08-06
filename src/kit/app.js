// Studio kit — shared tool-page helpers (Tauri access, HTML escaping, toast).
//
// Import from a tool's module script:
//   import { invoke, listen, hasTauri, esc, toast } from "../kit/app.js";
//
// `invoke`/`listen` are the Tauri APIs when running inside Studio, and safe
// stand-ins in a plain browser preview (invoke rejects, listen never fires) —
// so tools don't each need their own `window.__TAURI__?.core?.invoke` shim.
// For "am I in Studio?" branching, test `hasTauri`, not `invoke` (which is
// always a function).

// Tauri injects `window.__TAURI__` into the top-level webview only, not into
// child frames. So a tool page embedded as a same-origin <iframe> (e.g. the
// Git panel's Pulse/Server cards) borrows its parent's Tauri instead. Guarded
// because a cross-origin parent would throw on access.
function findTauri() {
    if (window.__TAURI__) return window.__TAURI__;
    try {
        if (window.parent !== window && window.parent.__TAURI__)
            return window.parent.__TAURI__;
    } catch { /* cross-origin parent — ignore */ }
    return null;
}

const tauri = findTauri();
export const hasTauri = !!tauri;

export const invoke = hasTauri
    ? tauri.core.invoke
    : () => Promise.reject(new Error("Tauri unavailable (browser preview)"));

export const listen = hasTauri
    ? tauri.event.listen
    : () => Promise.resolve(() => {});

/** Escape a string for interpolation into HTML. */
export function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
    }[c]));
}

let toastEl = null;
let toastTimer = 0;

/** Show a transient pill message at the bottom of the window (.kit-toast in
 *  kit.css). Repeated calls reuse one element and reset the timer. */
export function toast(msg, ms = 1800) {
    if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.className = "kit-toast";
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

/** A neutral PNG data-URL icon (optionally count-badged) for file drag-out —
 *  the plugin requires an image, and not every surface has a thumbnail. */
export function genericFileIcon(count = 1) {
    const size = 72;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#9a8f80";
    ctx.beginPath();
    ctx.roundRect(8, 6, size - 16, size - 12, 8);
    ctx.fill();
    if (count > 1) {
        const r = 12;
        ctx.beginPath();
        ctx.arc(size - r - 2, r + 2, r, 0, Math.PI * 2);
        ctx.fillStyle = "#e0392b";
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 15px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(count), size - r - 2, r + 3);
    }
    return c.toDataURL("image/png");
}

/** Native drag-out of real file(s) to Finder / a file picker / a web "drop
 *  here" zone. Call synchronously inside a pointerdown/mousedown so the OS drag
 *  attaches to the press the user is already holding. `paths` must be absolute.
 *
 *  Options: `icon` — a PNG data-URL overriding the neutral default. `move` —
 *  remove the source once the drop lands, Finder-style. That removal is ours to
 *  do: macOS only lets the drag *state* an intent, and Finder answers cross-app
 *  file drags with Copy no matter what the source mask says. `finish_drag_out`
 *  (lib.rs) is the one that decides, and it only removes when the drop actually
 *  landed in Finder — never into a web upload zone or a file picker.
 *
 *  Returns the paths that left, so a caller can refresh its view. */
export async function dragFilesOut(paths, { icon, move = false } = {}) {
    if (!hasTauri || !paths || !paths.length) return [];
    try {
        // The plugin command is invoked directly rather than through
        // `tauri.drag.startDrag`: that wrapper ships its own inlined Channel
        // that expects a `{message, id}` envelope this Tauri version no longer
        // sends, so its drop callback throws "undefined is not an object" at
        // the end of every drag. Tauri's own Channel matches its own envelope.
        // (`tauri`, not `window.__TAURI__` — plugin globals are injected
        // main-frame only, so an embedded tool borrows its parent's.)
        const onEvent = new tauri.core.Channel();
        const dropped = new Promise((resolve) => {
            onEvent.onmessage = (e) => resolve(e.result === "Dropped");
        });
        await invoke("plugin:drag|start_drag", {
            item: paths,
            image: icon || genericFileIcon(paths.length),
            options: { mode: move ? "move" : "copy" },
            onEvent,
        });
        // start_drag resolves only once the session ends, so the channel
        // message has normally already arrived — but never hang waiting for one
        // that isn't coming.
        const landed = await Promise.race([
            dropped,
            new Promise((r) => setTimeout(() => r(false), 300)),
        ]);
        if (!move || !landed) return [];
        const res = await invoke("finish_drag_out", { paths });
        return res.removed;
    } catch (e) {
        console.error("drag-out failed:", e);
        return [];
    }
}
