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
        const changed = (e.payload || []).filter(mine);
        if (!changed.length) return;
        // Stylesheet-only edits swap in place, so the page keeps its state
        // (tab, scroll, selection, half-typed text). Anything else reloads.
        if (changed.every((p) => p.endsWith(".css"))) {
            try { if (swapCss(changed)) return; } catch (err) { console.warn("dev-reload: CSS swap failed", err); }
        }
        reloading = true;
        location.reload();
    });

    // rel → cache-buster of its latest swap. A swapped sheet's own @imports
    // come back un-busted (a fresh styles.css asks for plain "tokens.css",
    // which the cache may answer with the old copy), so every pass re-points
    // them at the latest version of anything swapped before.
    const versions = new Map();

    const relOf = (url, rels) =>
        rels.find((rel) => url.pathname === "/" + rel || url.pathname.endsWith("/" + rel));
    const withV = (url, v) => {
        const u = new URL(url, location.href);
        u.searchParams.set("v", v);
        return u.href;
    };

    // Point every @import (any depth) of a swapped sheet at its latest version.
    function syncImports(sheet, hits) {
        let rules;
        try { rules = sheet.cssRules; } catch { return; }
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            if (!(rule instanceof CSSImportRule)) continue;
            const url = new URL(rule.href, sheet.href || location.href);
            const rel = relOf(url, [...versions.keys()]);
            const v = rel && versions.get(rel);
            if (!v || url.searchParams.get("v") === v) {
                if (rule.styleSheet) syncImports(rule.styleSheet, hits);
                continue;
            }
            const media = rule.media.mediaText ? " " + rule.media.mediaText : "";
            sheet.deleteRule(i);
            sheet.insertRule(`@import url("${withV(url, v)}")${media};`, i);
            hits?.add(rel);
        }
    }

    // Re-fetch each changed stylesheet, wherever this document pulled it in:
    // a <link>, or an @import at any depth (tokens.css comes in via
    // styles.css). Returns false if one wasn't found that way (e.g. a sheet
    // fetched by script), and the caller falls back to a reload.
    function swapCss(paths) {
        const v = String(Date.now());
        for (const rel of paths) versions.set(rel, v);
        const hits = new Set();

        // @imports first — swapping a <link> below replaces its sheet object.
        for (const sheet of document.styleSheets) syncImports(sheet, hits);

        // <link>s: load the fresh copy beside the old one and drop the old one
        // once it's in, so there's no unstyled flash in between.
        for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
            const rel = relOf(new URL(link.href), paths);
            if (!rel) continue;
            const fresh = link.cloneNode();
            fresh.href = withV(link.href, v);
            fresh.onload = () => { syncImports(fresh.sheet); link.remove(); };
            fresh.onerror = () => link.remove();
            link.after(fresh);
            hits.add(rel);
        }

        return paths.every((rel) => hits.has(rel));
    }
}
