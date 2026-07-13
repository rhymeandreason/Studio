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

export const hasTauri = !!window.__TAURI__;

export const invoke = hasTauri
    ? window.__TAURI__.core.invoke
    : () => Promise.reject(new Error("Tauri unavailable (browser preview)"));

export const listen = hasTauri
    ? window.__TAURI__.event.listen
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
