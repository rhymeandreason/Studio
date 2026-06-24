// Studio kit — custom window chrome.
//
// Self-initializing module for tool windows built with no native decorations
// (decorations(false) + transparent(true), set per-tool in src-tauri/src/lib.rs).
// Import once per document:
//   <link rel="stylesheet" href="../kit/window-chrome.css" />
//   <script type="module" src="../kit/window-chrome.js"></script>
// and mark the tool's top bar element with `data-window-bar`.
//
// It then:
//   - reads ?color= from the URL and tints the bar (--titlebar-tint) + exposes
//     the raw color as --window-color for the tool to use however it likes;
//   - makes the bar a Tauri drag region (buttons inside still click);
//   - injects a close dot at the bar's left edge and wires Cmd/Ctrl+W.
//
// Tools that retint dynamically (e.g. the Code Editor, per open file) just set
// --titlebar-tint themselves later; the initial ?color= is the first paint.

const TAURI = window.__TAURI__;

// Initial tint from the URL (matches the native git-window color the opener
// encoded). Set on :root so a tool's own CSS/JS can override or reuse it.
const color = new URLSearchParams(location.search).get("color") || "";
if (color) {
    const root = document.documentElement.style;
    root.setProperty("--titlebar-tint", color);
    root.setProperty("--window-color", color);
}

function closeWin() {
    TAURI?.window.getCurrentWindow().close();
}

function init() {
    // Harmonize grays/surfaces against the tint (tokens.css `.on-tint`) — only
    // when the window is actually color-tinted; paper windows keep solid grays.
    if (color) document.body.classList.add("on-tint");

    const bar = document.querySelector("[data-window-bar]");
    if (bar) {
        bar.setAttribute("data-tauri-drag-region", "");
        // The close dot is prepended into [data-window-close] if the tool marks
        // one (so it groups with that element's buttons), else into the bar.
        const slot = bar.querySelector("[data-window-close]") || bar;
        if (!slot.querySelector(".window-close")) {
            const btn = document.createElement("button");
            btn.className = "window-close";
            btn.title = "Close window";
            btn.addEventListener("click", closeWin);
            slot.prepend(btn);
        }
    }
    window.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
            e.preventDefault();
            closeWin();
        }
    });
}

if (document.readyState !== "loading") init();
else document.addEventListener("DOMContentLoaded", init);

export { closeWin };
