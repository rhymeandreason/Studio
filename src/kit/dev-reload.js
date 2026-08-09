// Studio kit — selective dev reload.
//
// `tauri dev`'s built-in frontend watcher reloads *every* webview on any change
// under src/, so editing one tool file refreshes all open Studio windows. We
// run dev with `--no-watch` (see package.json) and let Rust emit
// `dev-file-changed` (debug builds only, src-tauri/src/lib.rs) with paths
// relative to src/. Each document then decides for itself whether it cares.
//
// The rule: reload if the changed file is this document, or is among the
// resources this document actually loaded. So editing a tool's HTML reloads
// only that tool's window, while tokens.css or kit/*.js reloads everyone who
// imported it — which is what you want.
//
// Imported by kit/window-chrome.js (every tool window) and by the surfaces that
// don't use window chrome (index.html, dock, claude).

const TAURI = window.__TAURI__;
if (TAURI?.event) {
    let reloading = false;

    // Every URL this document has fetched (scripts, styles, fonts, images,
    // dynamic imports), plus the document itself.
    const loaded = () => {
        const urls = [location.pathname];
        for (const e of performance.getEntriesByType("resource")) {
            try { urls.push(new URL(e.name).pathname); } catch { /* data: etc. */ }
        }
        return urls;
    };

    // `rel` is relative to src/ ("tools/markdown-editor.html", "tokens.css").
    const mine = (rel) => {
        const tail = "/" + rel;
        return loaded().some((p) => p === tail || p.endsWith(tail));
    };

    TAURI.event.listen("dev-file-changed", (e) => {
        if (reloading) return;
        const paths = e.payload || [];
        if (!paths.some(mine)) return;
        reloading = true;
        location.reload();
    });
}
