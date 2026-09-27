import { spriteStyle, DEFAULT_SPRITE } from "../sprites.js";
import { initDevInspect } from "../devinspect.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

// The project's animal sprite (from workspace.json), used for the status-bar
// walker and assistant avatars. Defaults to the red panda. Persisted so it's
// right immediately on relaunch, then refreshed by each claude-jump.
let currentSprite = localStorage.getItem("claude.sprite") || DEFAULT_SPRITE;
let lastAssistantIcon = null;

// Apply a sprite animation's inline style to an element. The sprite sheets live
// in src/sprites/, a sibling of this window's src/claude/ dir, so the file URL
// from spriteStyle() needs a "../" prefix.
function applySpriteStyle(el, anim, height) {
    const { "--sprite-start": start, "--sprite-end": end, backgroundImage, ...rest } =
        spriteStyle(currentSprite, anim, height);
    Object.assign(el.style, rest);
    el.style.backgroundImage = backgroundImage.replace('url("', 'url("../');
    el.style.setProperty("--sprite-start", start);
    el.style.setProperty("--sprite-end", end);
}

function applyStatusSprite() {
    const panda = document.querySelector(".claude-status__panda");
    if (panda) applySpriteStyle(panda, "movement", 26);
}

// Re-apply the sprite to every assistant avatar; only the last one animates.
function refreshAssistantSprites() {
    const icons = [...transcriptEl.querySelectorAll(".claude-msg__icon--panda")];
    icons.forEach((icon, i) => {
        applySpriteStyle(icon, "idle", 24);
        if (i !== icons.length - 1) icon.style.animation = "none";
    });
    lastAssistantIcon = icons[icons.length - 1] || null;
}

function setSprite(name) {
    currentSprite = name || DEFAULT_SPRITE;
    localStorage.setItem("claude.sprite", currentSprite);
    applyStatusSprite();
    refreshAssistantSprites();
}

function setWindowTitle(projectName) {
    getCurrentWindow().setTitle(projectName ? `Claude · ${projectName}` : "Claude");
    const el = document.getElementById("project-name");
    if (el) el.textContent = projectName || "";
}

// Tint the window with the active project's color. window-chrome.js does this
// once from the URL ?color=, but the in-Studio window is reused across projects,
// so re-apply it on every jump.
function setProjectColor(color) {
    const root = document.documentElement.style;
    if (color) {
        root.setProperty("--window-color", color);
        root.setProperty("--titlebar-tint", color);
        document.body.classList.add("on-tint");
    } else {
        root.removeProperty("--window-color");
        root.removeProperty("--titlebar-tint");
        document.body.classList.remove("on-tint");
    }
}

const sessionsListEl = document.getElementById("sessions-list");
const historyListEl = document.getElementById("history-list");
const historyToggle = document.getElementById("history-toggle");
const sessionsPanel = document.getElementById("sessions-panel");
const sessionsToggle = document.getElementById("sessions-toggle");
const sessionNameEl = document.getElementById("session-name");
const tabsEl = document.getElementById("tabs");
const transcriptEl = document.getElementById("transcript");
const statusEl = document.getElementById("status");
const form = document.getElementById("input-form");
const promptInput = document.getElementById("prompt-input");
// A small custom dropdown matching the Notes page's .notedrop styling: a
// trigger button showing the current choice, and a menu of options with a
// checkmark on the selected item. Exposes a `.value` property and a
// `change` event so it's a drop-in replacement for a <select>.
function createDropdown(container, items, { icon } = {}) {
    const target = new EventTarget();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "notedrop__btn";
    if (icon) {
        const img = document.createElement("img");
        img.className = "notedrop__icon";
        img.src = icon;
        img.alt = "";
        btn.append(img);
    }
    const label = document.createElement("span");
    label.className = "notedrop__label";
    const chev = document.createElement("span");
    chev.className = "mi mi-sm ph ph-caret-down notedrop__chev";
    btn.append(label, chev);

    const menu = document.createElement("div");
    menu.className = "menu notedrop__menu";
    menu.hidden = true;

    let value = items[0]?.value;
    items.forEach((item) => {
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "menu__item notedrop__item";
        opt.textContent = item.label;
        opt.dataset.value = item.value;
        opt.addEventListener("click", () => {
            menu.hidden = true;
            if (target.value !== item.value) {
                target.value = item.value;
                sync();
                target.dispatchEvent(new Event("change"));
            }
        });
        menu.append(opt);
    });

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = menu.hidden;
        // Close any other open dropdown so only one is ever open at a time.
        document.querySelectorAll(".notedrop__menu").forEach((m) => {
            if (m !== menu) m.hidden = true;
        });
        menu.hidden = !open;
    });
    document.addEventListener("click", (e) => {
        if (!container.contains(e.target)) menu.hidden = true;
    });

    function sync() {
        const item = items.find((i) => i.value === target.value) || items[0];
        label.textContent = item?.label || "";
        menu.querySelectorAll(".notedrop__item").forEach((opt) => {
            opt.classList.toggle("is-active", opt.dataset.value === target.value);
        });
    }

    Object.defineProperty(target, "value", {
        get: () => value,
        set: (v) => {
            value = v;
            sync();
        },
    });

    container.append(btn, menu);
    sync();
    return target;
}

const modelSelect = createDropdown(
    document.getElementById("model-select"),
    [
        { value: "sonnet", label: "Sonnet" },
        { value: "opus", label: "Opus" },
        { value: "fable", label: "Fable" },
        { value: "haiku", label: "Haiku" },
    ],
    { icon: "claude-icon.svg" },
);
const PERMISSION_OPTIONS = [
    { value: "default", label: "Ask" },
    { value: "acceptEdits", label: "Accept edits" },
    { value: "plan", label: "Plan" },
    { value: "bypassPermissions", label: "Bypass" },
];
const PERMISSION_MODES = PERMISSION_OPTIONS.map((o) => o.value);
const permissionSelect = createDropdown(document.getElementById("permission-select"), PERMISSION_OPTIONS);
// Working directory: "project" runs Claude in the project folder (where media,
// notes, and artifacts/ live — for design/artifact work); "repo" runs it in the
// workspace's git repo (for code). Backend resolves the actual path.
const cwdSelect = createDropdown(document.getElementById("cwd-select"), [
    { value: "project", label: "Artifacts" },
    { value: "repo", label: "Code" },
]);
const newSessionBtn = document.getElementById("new-session");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const contextFill = document.getElementById("context-fill");
const contextPct = document.getElementById("context-pct");
const planFill = document.getElementById("plan-fill");
const planStatus = document.getElementById("plan-status");
const sevenDayPie = document.getElementById("sevenday-pie");
const sevenDayWrap = document.getElementById("sevenday");

const CONTEXT_WINDOW_DEFAULT = 200000;

/** @type {Array<Session>} */
let sessions = [];
let activeKey = null;
// The project whose sessions the sidebar shows. The Claude window is scoped to
// one project at a time, so sessions from other projects are hidden.
let currentProjectPath = null;
// Whether to surface Claude Code sessions started outside Studio (the "Recent"
// list, read from ~/.claude/projects). Persisted across launches.
let includeOutside = localStorage.getItem("claude.includeOutside") !== "false";
const listeners = new Map(); // key -> unlisten fn
const liveBubbles = new Map(); // key -> { assistantEl, toolKeys: Set }
const busyKeys = new Set(); // sessions with a turn in progress

// Auto-scroll only when the user is already at the bottom, so scrolling up to
// read tool output isn't yanked back down by new messages/streamed text.
let stickToBottom = true;
function scrollToBottom(force) {
    if (force || stickToBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}
transcriptEl.addEventListener("scroll", () => {
    const gap = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
    stickToBottom = gap < 80;
});

// Show the stop button (instead of send) while the given session has a turn
// running; only reflects the UI when it's the active session.
function setBusy(key, busy) {
    if (busy) busyKeys.add(key);
    else busyKeys.delete(key);
    if (key === activeKey) {
        reflectBusy(key);
        updateStatusTimer();
    }
}

function reflectBusy(key) {
    const busy = busyKeys.has(key);
    stopBtn.hidden = !busy;
    sendBtn.hidden = busy;
}

// Live progress status (spinner + activity + token counts) for the running turn.
let statusTimer = null;
function updateStatusTimer() {
    const running = activeKey && busyKeys.has(activeKey);
    if (running && !statusTimer) statusTimer = setInterval(renderStatus, 500);
    if (!running && statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
    }
    renderStatus();
}

function fmtTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function renderStatus() {
    const live = liveBubbles.get(activeKey);
    if (!activeKey || !busyKeys.has(activeKey) || !live) {
        statusEl.hidden = true;
        return;
    }
    statusEl.hidden = false;
    statusEl.querySelector(".claude-status__label").textContent = live.activity || "Working";
    const toolEl = statusEl.querySelector(".claude-status__tool");
    toolEl.hidden = !live.toolSummary;
    if (live.toolSummary) {
        toolEl.querySelector(".claude-status__tool-name").textContent = live.toolSummary;
    }
    const secs = live.turnStart ? Math.floor((Date.now() - live.turnStart) / 1000) : 0;
    const ctx = live.promptTokens ? ` · ↑ ${fmtTokens(live.promptTokens)} ctx` : "";
    const out = ` · ↓ ${fmtTokens(live.outputTokens || 0)} tok`;
    statusEl.querySelector(".claude-status__meta").textContent = `${secs}s${ctx}${out}`;
}

/**
 * @typedef {Object} Session
 * @property {string} key
 * @property {string} name
 * @property {string} projectPath
 * @property {string} projectName
 * @property {string} model
 * @property {string|null} resumeId
 * @property {Array<{role:string, text:string}>} transcript
 */

function uuid() {
    return crypto.randomUUID();
}

// Guard against saving before the store has loaded — a save then would write
// an empty list over the user's sessions.
let sessionsLoaded = false;

async function loadSessions() {
    try {
        // Per-project window: its own session file (companion). The in-Studio
        // window passes null and the backend uses the shared file.
        const raw = await invoke("read_claude_sessions", { project: currentProjectPath });
        sessions = raw ? JSON.parse(raw) : [];
        sessionsLoaded = true;
    } catch (err) {
        // Leave saving disabled: the backend has kept the unreadable file.
        sessions = [];
        console.error("[claude] couldn't load sessions", err);
    }
    // Drop usage stored by the old (cumulative, >100%) calculation so it
    // doesn't show a bogus number until the session's next turn recomputes it.
    for (const s of sessions) {
        if (s.usage && s.usage.used > s.usage.contextWindow) delete s.usage;
    }
}

async function persistSessions() {
    if (!sessionsLoaded) return;
    const slim = sessions.map((s) => ({
        ...s,
        // Don't persist huge transcripts indefinitely — keep last 50 turns.
        transcript: s.transcript.slice(-50),
    }));
    await invoke("save_claude_sessions", {
        project: currentProjectPath,
        data: JSON.stringify(slim),
    });
}

const ROLE_ICONS = {
    user: "user",
    assistant: "robot",
    tool: "wrench",
    system: "info",
};

function modelLabel(model) {
    const m = (model || "sonnet").trim();
    return m.charAt(0).toUpperCase() + m.slice(1);
}

// Sessions visible in this window (scoped to the current project).
function visibleSessions() {
    return currentProjectPath
        ? sessions.filter((s) => s.projectPath === currentProjectPath)
        : sessions;
}

// A tab per session for the current project; click to switch, × to close.
function renderTabs() {
    tabsEl.innerHTML = "";
    // Only the *other* sessions get a tab; the current one is shown as the title.
    const others = visibleSessions().filter((s) => s.key !== activeKey);
    if (!others.length) return;
    for (const s of others) {
        const tab = document.createElement("div");
        tab.className = "claude-tab" + (s.key === activeKey ? " is-active" : "");
        tab.title = s.name;
        tab.innerHTML = `<span class="claude-tab__name"></span><button class="claude-tab__close" title="Close session"><span class="mi ph ph-x"></span></button>`;
        tab.querySelector(".claude-tab__name").textContent = s.name;
        tab.addEventListener("click", () => switchTo(s.key));
        tab.querySelector(".claude-tab__close").addEventListener("click", (e) => {
            e.stopPropagation();
            deleteSession(s.key);
        });
        tabsEl.appendChild(tab);
    }
}

function renderSessionsList() {
    renderTabs();
    sessionsListEl.innerHTML = "";
    // Only show sessions for the current project.
    const visible = visibleSessions();
    if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "claude-sessions__empty";
        empty.textContent = "No sessions yet.";
        sessionsListEl.appendChild(empty);
        return;
    }
    for (const s of visible) {
        const item = document.createElement("div");
        item.className = "claude-session-item" + (s.key === activeKey ? " is-active" : "");
        item.innerHTML = `<span class="claude-session-item__name" title="Click to rename"></span><span class="claude-session-item__project"><span class="mi mi-sm ph ph-folder"></span><span></span></span><span class="claude-session-item__meta"><span class="claude-session-item__model"></span><span class="claude-session-item__context"></span></span><button class="claude-session-item__delete" title="Delete session"><span class="mi ph ph-trash"></span></button>`;
        item.querySelector(".claude-session-item__name").textContent = s.name;
        item.querySelector(".claude-session-item__project span:last-child").textContent =
            s.projectName;
        item.querySelector(".claude-session-item__model").textContent = modelLabel(s.model);
        if (s.usage) {
            const pct = Math.min(100, Math.round((s.usage.used / s.usage.contextWindow) * 100));
            item.querySelector(".claude-session-item__context").textContent = `${pct}%`;
        }
        item.addEventListener("click", () => switchTo(s.key));
        item.querySelector(".claude-session-item__name").addEventListener("click", (e) => {
            e.stopPropagation();
            beginRename(s.key, item);
        });
        item.querySelector(".claude-session-item__delete").addEventListener("click", (e) => {
            e.stopPropagation();
            deleteSession(s.key);
        });
        sessionsListEl.appendChild(item);
    }
}

async function renderHistoryList(projectPath, projectName) {
    document.getElementById("history-project").textContent = projectName;
    historyListEl.innerHTML = "";
    if (!includeOutside) {
        historyListEl.hidden = true;
        return;
    }
    historyListEl.hidden = false;
    let history = [];
    try {
        history = await invoke("list_claude_project_sessions", {
            projectPath,
            cwd: cwdSelect.value || "project",
        });
    } catch {
        history = [];
    }
    // Hide entries we already have an in-app session for.
    const known = new Set(sessions.filter((s) => s.resumeId).map((s) => s.resumeId));
    history = history.filter((h) => !known.has(h.session_id));

    if (!history.length) {
        const empty = document.createElement("div");
        empty.className = "claude-sessions__empty";
        empty.textContent = "No prior sessions found.";
        historyListEl.appendChild(empty);
        return;
    }
    for (const h of history) {
        const btn = document.createElement("button");
        btn.className = "claude-session-item";
        btn.innerHTML = `<span class="claude-session-item__name"></span>`;
        btn.querySelector(".claude-session-item__name").textContent = h.summary;
        btn.addEventListener("click", () => resumeHistorySession(h, projectPath, projectName));
        historyListEl.appendChild(btn);
    }
}

async function resumeHistorySession(h, projectPath, projectName) {
    let transcript = [];
    try {
        transcript = await invoke("read_claude_session_log", {
            projectPath,
            sessionId: h.session_id,
            cwd: cwdSelect.value || "project",
        });
    } catch {
        transcript = [];
    }
    const session = {
        key: uuid(),
        name: h.summary,
        projectPath,
        projectName,
        model: modelSelect.value || "sonnet",
        permissionMode: permissionSelect.value || "default",
        cwd: cwdSelect.value || "project",
        resumeId: h.session_id,
        resumeCwd: cwdSelect.value || "project",
        transcript,
    };
    sessions.unshift(session);
    await persistSessions();
    await switchTo(session.key);
}

function renderTranscript(session) {
    transcriptEl.innerHTML = "";
    lastAssistantIcon = null;
    if (!session.transcript.length) {
        const empty = document.createElement("div");
        empty.className = "claude-empty";
        empty.innerHTML = `<span class="mi ph ph-chats"></span>Start the conversation`;
        transcriptEl.appendChild(empty);
        return;
    }
    for (const msg of session.transcript) {
        appendBubble(msg.role, msg.text, msg.images);
    }
    // A reply still streaming in: re-show it and keep streaming into it.
    const live = liveBubbles.get(session.key);
    if (live?.assistantText) live.assistantEl = appendBubble("assistant", live.assistantText);
    // …and anything still waiting on an answer.
    for (const [id, req] of live?.asks || []) appendAsk(session.key, id, req);
    // Switching into a session: jump to the latest.
    stickToBottom = true;
    scrollToBottom(true);
}

// --- Markdown -------------------------------------------------------------
// Assistant replies render as Markdown. The window can invoke claude_send, so
// raw HTML in a reply (e.g. echoed from a web page) must never become live DOM:
// HTML is shown as text, images as links, and only http(s) links survive.
const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeHref = (href) => (/^https?:\/\//i.test(href || "") ? href : null);
const md = window.marked
    ? new window.marked.Marked({
          gfm: true,
          renderer: {
              html: (html) => escapeHtml(html),
              link(href, title, text) {
                  const url = safeHref(href);
                  return url ? `<a href="${escapeHtml(url)}" title="${escapeHtml(title || url)}">${text}</a>` : text;
              },
              image(href, title, text) {
                  const url = safeHref(href);
                  return url ? `<a href="${escapeHtml(url)}">${escapeHtml(text || url)}</a>` : escapeHtml(text || "");
              },
          },
      })
    : null;

// The raw text behind each rendered bubble, for double-click-to-copy.
const rawText = new WeakMap();

function renderMarkdown(body, text) {
    rawText.set(body, text);
    if (!md) {
        body.textContent = text;
        return;
    }
    body.innerHTML = md.parse(text);
    // Wide tables scroll in their own box instead of crushing their columns.
    body.querySelectorAll("table").forEach((t) => {
        const scroller = document.createElement("div");
        scroller.className = "claude-md__scroll";
        t.replaceWith(scroller);
        scroller.append(t);
    });
}

// Streaming re-renders the whole reply, so coalesce deltas to one per frame.
const pendingRenders = new Map(); // body el -> text
function scheduleMarkdown(body, text) {
    if (!pendingRenders.size) {
        requestAnimationFrame(() => {
            for (const [el, t] of pendingRenders) renderMarkdown(el, t);
            pendingRenders.clear();
            scrollToBottom();
        });
    }
    pendingRenders.set(body, text);
}

// Links in replies open in the browser, never inside this window.
transcriptEl.addEventListener("click", (e) => {
    const a = e.target.closest(".claude-md a[href]");
    if (!a) return;
    e.preventDefault();
    invoke("open_path", { path: a.getAttribute("href") }).catch(() => {});
});

function appendBubble(role, text, images) {
    transcriptEl.querySelector(".claude-empty")?.remove();

    // Tool calls render collapsed: a clickable header (the tool name) that
    // expands to show the full input. Stored/streamed text is "name {input}".
    if (role === "tool") {
        const el = document.createElement("div");
        el.className = "claude-msg claude-msg--tool is-collapsed";
        const sp = text.indexOf(" ");
        const name = sp === -1 ? text : text.slice(0, sp);
        const detail = sp === -1 ? "" : text.slice(sp + 1);
        el.innerHTML = `<button class="claude-tool"><span class="mi claude-tool__chevron ph ph-caret-right"></span><span class="mi claude-tool__icon ph ph-wrench"></span><span class="claude-tool__name"></span></button><pre class="claude-tool__detail"></pre>`;
        el.querySelector(".claude-tool__name").textContent = name;
        el.querySelector(".claude-tool__detail").textContent = detail;
        el.querySelector(".claude-tool").addEventListener("click", () => {
            el.classList.toggle("is-collapsed");
        });
        transcriptEl.appendChild(el);
        scrollToBottom(false);
        return el;
    }

    const el = document.createElement("div");
    el.className = `claude-msg claude-msg--${role}`;
    if (role === "assistant") {
        const who = document.createElement("div");
        who.className = "claude-msg__who";
        const icon = document.createElement("span");
        icon.className = "claude-msg__icon claude-msg__icon--panda";
        applySpriteStyle(icon, "idle", 24);
        if (lastAssistantIcon) lastAssistantIcon.style.animation = "none";
        lastAssistantIcon = icon;
        const author = document.createElement("span");
        author.className = "claude-msg__author";
        author.textContent = sessions.find((s) => s.key === activeKey)?.projectName || "";
        who.append(icon, author);
        el.appendChild(who);
    } else if (role === "error") {
        el.className = "claude-msg claude-msg--system claude-msg--error";
    } else if (role !== "system" && role !== "user") {
        const icon = document.createElement("span");
        icon.className = `mi ph ph-${ROLE_ICONS[role] || "circle"} claude-msg__icon`;
        el.appendChild(icon);
    }
    if (images?.length) {
        const strip = document.createElement("div");
        strip.className = "claude-msg__images";
        for (const src of images) {
            const img = document.createElement("img");
            img.src = src;
            img.alt = "";
            strip.append(img);
        }
        el.appendChild(strip);
        if (!text) {
            transcriptEl.appendChild(el);
            scrollToBottom(role === "user");
            return strip;
        }
    }
    const body = document.createElement("div");
    body.className = "claude-msg__body";
    if (role === "assistant") {
        body.classList.add("claude-md");
        renderMarkdown(body, text);
    } else {
        body.textContent = text;
    }
    el.appendChild(body);
    transcriptEl.appendChild(el);
    // Always follow the user's own message; otherwise only if pinned to bottom.
    scrollToBottom(role === "user");
    return body;
}

// --- Asks: permission, question, and plan cards ------------------------------
// With `--permission-prompt-tool stdio`, Claude Code sends a `can_use_tool`
// control_request whenever it needs the user: a tool permission, an
// AskUserQuestion, or an ExitPlanMode (plan approval). Each becomes a card; the
// user's choice goes back as a control_response and Claude continues.

// Write a raw stream-json message to the session's claude process.
function control(key, message) {
    return invoke("claude_control", { key, message });
}

let controlSeq = 0;
function controlRequest(key, request) {
    return control(key, { type: "control_request", request_id: `studio-${++controlSeq}`, request });
}

// Answer an ask and settle its card. `note` is the card's resolved label.
function answerAsk(key, requestId, response, note) {
    const live = getLiveBubbles(key);
    live.asks.delete(requestId);
    if (!live.asks.size) live.activity = "Working";
    resolveAskCard(requestId, note);
    renderStatus();
    control(key, {
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
    }).catch((err) => appendBubble("error", `Couldn't answer Claude: ${err}`));
}

// Replace a card's controls with a one-line outcome (Allowed / Denied / …).
function resolveAskCard(requestId, note) {
    const card = transcriptEl.querySelector(`[data-ask="${CSS.escape(requestId)}"]`);
    if (!card) return;
    card.classList.add("is-resolved");
    card.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
    const actions = card.querySelector(".claude-ask__actions");
    if (actions) {
        actions.innerHTML = "";
        const done = document.createElement("span");
        done.className = "claude-ask__outcome";
        done.textContent = note;
        actions.append(done);
    }
}

// The turn ended or the process went away: nothing can answer these now.
function expireAsks(live) {
    for (const id of live.asks.keys()) resolveAskCard(id, "Expired");
    live.asks.clear();
}

const stripAnsi = (s) => String(s || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function button(label, className, onClick) {
    const b = el("button", `btn ${className || ""}`.trim(), label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
}

function askCard(requestId, icon, title) {
    transcriptEl.querySelector(".claude-empty")?.remove();
    const card = el("div", "claude-msg claude-ask");
    card.dataset.ask = requestId;
    const head = el("div", "claude-ask__head");
    head.append(el("span", `mi mi-sm ph ph-${icon}`), el("span", "claude-ask__title", title));
    card.append(head);
    return card;
}

function mountAskCard(card) {
    transcriptEl.appendChild(card);
    scrollToBottom(true);
    return card;
}

function appendAsk(key, requestId, req) {
    if (req.tool_name === "AskUserQuestion") return appendQuestion(key, requestId, req.input || {});
    if (req.tool_name === "ExitPlanMode") return appendPlan(key, requestId, req.input || {});
    return appendPermission(key, requestId, req);
}

// What the tool is about to do, in the most readable form for common tools.
function describeToolInput(tool, input) {
    const lines = (s, n) => {
        const all = String(s ?? "").split("\n");
        return all.length > n ? [...all.slice(0, n), `… ${all.length - n} more lines`] : all;
    };
    switch (tool) {
        case "Bash":
            return { subject: input.description, detail: input.command };
        case "Edit":
            return {
                subject: input.file_path,
                detail: [
                    ...lines(input.old_string, 20).map((l) => `- ${l}`),
                    ...lines(input.new_string, 20).map((l) => `+ ${l}`),
                ].join("\n"),
            };
        case "Write":
            return { subject: input.file_path, detail: lines(input.content, 30).join("\n") };
        case "Read":
        case "NotebookEdit":
            return { subject: input.file_path || input.notebook_path };
        case "WebFetch":
            return { subject: input.url, detail: input.prompt };
        case "WebSearch":
            return { subject: input.query };
        case "Glob":
        case "Grep":
            return { subject: input.pattern, detail: input.path };
        default:
            return { detail: JSON.stringify(input, null, 2) };
    }
}

function appendPermission(key, requestId, req) {
    const tool = req.display_name || req.tool_name || "a tool";
    const card = askCard(requestId, "shield-check", req.title || `Allow ${tool}?`);
    const { subject, detail } = describeToolInput(req.tool_name, req.input || {});
    const about = req.description || subject;
    if (about) card.append(el("div", "claude-ask__subject", about));
    if (req.description && subject && subject !== req.description) {
        card.append(el("div", "claude-ask__path", subject));
    }
    if (detail) card.append(el("pre", "claude-ask__detail", detail));
    if (req.blocked_path) card.append(el("div", "claude-ask__reason", `Outside the project: ${req.blocked_path}`));
    if (req.decision_reason) card.append(el("div", "claude-ask__reason", stripAnsi(req.decision_reason)));

    const actions = el("div", "claude-ask__actions");
    const deny = button("Deny", "", () =>
        answerAsk(key, requestId, { behavior: "deny", message: "The user denied this. Ask what they'd like instead." }, "Denied"),
    );
    actions.append(deny);
    // "Allow for session" applies Claude's own suggested rules, scoped to this
    // session only (suggestions default to writing the project's settings).
    const suggestions = req.permission_suggestions || [];
    if (suggestions.length && !req.suppress_always_allow_rule) {
        actions.append(
            button("Allow for session", "", () =>
                answerAsk(key, requestId, {
                    behavior: "allow",
                    updatedInput: req.input,
                    updatedPermissions: suggestions.map((s) => ({ ...s, destination: "session" })),
                }, "Allowed for this session"),
            ),
        );
    }
    actions.append(
        button("Allow", "btn-primary", () =>
            answerAsk(key, requestId, { behavior: "allow", updatedInput: req.input }, "Allowed"),
        ),
    );
    card.append(actions);
    mountAskCard(card);
    // Risky asks must not be one stray keypress from approval.
    if (req.default_to_no) deny.focus();
}

// AskUserQuestion: pick an option per question (or type your own), and the
// answers go back as the tool's real result.
function appendQuestion(key, requestId, input) {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const card = askCard(requestId, "chat-circle-dots", questions.length > 1 ? "Claude has a few questions" : "Claude has a question");
    const answers = questions.map(() => ({ picked: new Set(), other: "" }));
    let sendBtn;
    const refresh = () => {
        sendBtn.disabled = !answers.every((a) => a.picked.size || a.other.trim());
    };

    questions.forEach((q, qi) => {
        const block = el("div", "claude-q");
        block.append(el("div", "claude-q__head", q.question || q.header || "Question"));
        const opts = el("div", "claude-q__opts");
        const other = el("input", "field__input claude-q__other");
        (q.options || []).forEach((opt) => {
            const b = el("button", "claude-q__opt");
            b.type = "button";
            b.append(el("span", "claude-q__opt-label", opt.label));
            if (opt.description) b.append(el("span", "claude-q__opt-desc", opt.description));
            b.addEventListener("click", () => {
                const a = answers[qi];
                if (q.multiSelect) {
                    b.classList.toggle("is-selected");
                    if (a.picked.has(opt.label)) a.picked.delete(opt.label);
                    else a.picked.add(opt.label);
                } else {
                    opts.querySelectorAll(".claude-q__opt").forEach((o) => o.classList.remove("is-selected"));
                    b.classList.add("is-selected");
                    a.picked = new Set([opt.label]);
                    a.other = other.value = "";
                }
                refresh();
            });
            opts.append(b);
        });
        // Free-text answer instead of (single-select) or alongside (multi) the options.
        other.placeholder = "Something else…";
        other.addEventListener("input", () => {
            answers[qi].other = other.value;
            if (!q.multiSelect && other.value.trim()) {
                answers[qi].picked.clear();
                opts.querySelectorAll(".claude-q__opt").forEach((o) => o.classList.remove("is-selected"));
            }
            refresh();
        });
        other.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !sendBtn.disabled) sendBtn.click();
        });
        block.append(opts, other);
        card.append(block);
    });

    const actions = el("div", "claude-ask__actions");
    sendBtn = button("Send answer", "btn-primary", () => {
        const out = {};
        const summary = [];
        questions.forEach((q, i) => {
            const parts = [...answers[i].picked];
            if (answers[i].other.trim()) parts.push(answers[i].other.trim());
            out[q.question] = parts.join(", ");
            summary.push(`${q.header || q.question}: ${out[q.question]}`);
        });
        const session = sessions.find((s) => s.key === key);
        session?.transcript.push({ role: "system", text: `Answered — ${summary.join(" · ")}` });
        answerAsk(key, requestId, { behavior: "allow", updatedInput: { ...input, answers: out } }, summary.join(" · "));
    });
    sendBtn.disabled = true;
    actions.append(
        button("Skip", "", () =>
            answerAsk(key, requestId, { behavior: "deny", message: "The user skipped the question." }, "Skipped"),
        ),
        sendBtn,
    );
    card.append(actions);
    return mountAskCard(card);
}

// ExitPlanMode: Claude's plan, rendered, with approve / keep-planning buttons.
// Approving also switches the session out of Plan mode (the CLI then reports
// the new mode, which syncs the picker).
function appendPlan(key, requestId, input) {
    const card = askCard(requestId, "list-checks", "Ready to go with this plan?");
    card.classList.add("claude-ask--plan");
    const plan = el("div", "claude-msg__body claude-md claude-ask__plan");
    renderMarkdown(plan, input.plan || "");
    card.append(plan);
    const approve = (mode, note) =>
        answerAsk(key, requestId, {
            behavior: "allow",
            updatedInput: input,
            updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
        }, note);
    const actions = el("div", "claude-ask__actions");
    actions.append(
        button("Keep planning", "", () =>
            answerAsk(key, requestId, { behavior: "deny", message: "The user wants to keep planning. Ask what to change." }, "Kept planning"),
        ),
        button("Approve, ask before edits", "", () => approve("default", "Approved")),
        button("Approve, accept edits", "btn-primary", () => approve("acceptEdits", "Approved — accepting edits")),
    );
    card.append(actions);
    return mountAskCard(card);
}

function resetUsageBars() {
    contextFill.style.width = "0%";
    contextPct.textContent = "0%";
    planFill.style.width = "0%";
    planStatus.textContent = "—";
}

async function switchTo(key) {
    activeKey = key;
    const session = sessions.find((s) => s.key === key);
    if (!session) return;
    const projectChanged = session.projectPath !== currentProjectPath;
    currentProjectPath = session.projectPath;
    // Remember the last active session so reopening the window returns to it.
    localStorage.setItem(activeKeyName(), key);
    sessionNameEl.textContent = session.name;
    setWindowTitle(session.projectName);
    // The window is only tinted once from the URL's ?color= at launch (see
    // window-chrome.js); the companion is single-instance, so switching to a
    // session from a different project in an already-open window needs to
    // re-fetch and re-apply that project's color itself.
    if (projectChanged) {
        const ws = await invoke("read_workspace", { path: session.projectPath }).catch(() => null);
        setProjectColor((ws && ws.color) || "");
    }
    modelSelect.value = session.model || "sonnet";
    permissionSelect.value = session.permissionMode || "default";
    cwdSelect.value = session.cwd || "project";
    renderTranscript(session);
    renderUsageBars(session);
    renderSessionsList();
    ensureListener(session.key);
    reflectBusy(key);
    updateStatusTimer();
    renderHistoryList(session.projectPath, session.projectName);
}

function beginRename(key, item) {
    const session = sessions.find((s) => s.key === key);
    if (!session) return;
    const nameEl = item.querySelector(".claude-session-item__name");

    const input = document.createElement("input");
    input.className = "claude-session-item__rename-input";
    input.value = session.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
        if (done) return;
        done = true;
        if (save) {
            const next = input.value.trim();
            if (next && next !== session.name) {
                session.name = next;
                persistSessions();
                if (key === activeKey) sessionNameEl.textContent = session.name;
            }
        }
        renderSessionsList();
    };

    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            commit(true);
        } else if (e.key === "Escape") {
            e.preventDefault();
            commit(false);
        }
    });
    input.addEventListener("blur", () => commit(true));
}

// Rename the active session by clicking its title in the header bar.
function beginRenameTitle() {
    const session = sessions.find((s) => s.key === activeKey);
    if (!session) return;

    const input = document.createElement("input");
    input.className = "claude-session-name__input";
    input.value = session.name;
    sessionNameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
        if (done) return;
        done = true;
        if (save) {
            const next = input.value.trim();
            if (next && next !== session.name) {
                session.name = next;
                persistSessions();
            }
        }
        sessionNameEl.textContent = session.name;
        input.replaceWith(sessionNameEl);
        renderSessionsList();
    };

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
        } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
        }
    });
    input.addEventListener("blur", () => finish(true));
}

sessionNameEl.addEventListener("click", beginRenameTitle);

async function deleteSession(key) {
    const idx = sessions.findIndex((s) => s.key === key);
    if (idx === -1) return;
    const [removed] = sessions.splice(idx, 1);

    // Tear down the subprocess and its stream listener, if any.
    try {
        await invoke("claude_stop", { key });
    } catch {
        // ignore — proc may not be running
    }
    const unlisten = listeners.get(key);
    if (unlisten) {
        unlisten.then((fn) => fn()).catch(() => {});
        listeners.delete(key);
    }
    liveBubbles.delete(key);
    busyKeys.delete(key);

    await persistSessions();

    // If we deleted the active session, fall back to another (or empty state).
    if (activeKey === key) {
        activeKey = null;
        if (sessions.length) {
            await switchTo(sessions[0].key);
        } else {
            sessionNameEl.textContent = "New session";
            transcriptEl.innerHTML = "";
            renderTranscript({ transcript: [] });
            resetUsageBars();
            renderSessionsList();
            reflectBusy(null);
            if (removed) renderHistoryList(removed.projectPath, removed.projectName);
        }
    } else {
        renderSessionsList();
    }
}

async function createSession(projectPath, projectName) {
    const session = {
        key: uuid(),
        name: "New session",
        projectPath,
        projectName,
        model: modelSelect.value || "sonnet",
        permissionMode: permissionSelect.value || "default",
        cwd: cwdSelect.value || "project",
        resumeId: null,
        transcript: [],
    };
    sessions.unshift(session);
    await persistSessions();
    await switchTo(session.key);
}

// The last project the window was pointed at (via a studio-claude:// deep link),
// used as the target for new sessions. Persisted so it survives relaunches.
let lastProject = null;
try {
    lastProject = JSON.parse(localStorage.getItem("claude.lastProject") || "null");
} catch {
    lastProject = null;
}
function setLastProject(path, name) {
    if (!path) return;
    lastProject = { path, name: name || path.split("/").filter(Boolean).pop() };
    localStorage.setItem("claude.lastProject", JSON.stringify(lastProject));
}

async function defaultProject() {
    // The active session's project, else this window's project, else the last
    // project we were launched with. (Prefer the window's own project over the
    // cross-window-shared lastProject so new sessions land in the right place.)
    const active = sessions.find((s) => s.key === activeKey);
    if (active) return { path: active.projectPath, name: active.projectName };
    if (currentProjectPath) {
        const name =
            lastProject && lastProject.path === currentProjectPath
                ? lastProject.name
                : currentProjectPath.split("/").filter(Boolean).pop();
        return { path: currentProjectPath, name };
    }
    return lastProject;
}

// Returns the listen() promise so a send can wait until the listener is
// attached (otherwise the process's first events can arrive before it).
function ensureListener(key) {
    if (!listeners.has(key)) {
        listeners.set(
            key,
            listen(`claude-stream-${key}`, (event) => handleStreamLine(key, event.payload)),
        );
    }
    return listeners.get(key);
}

// Move whatever streamed so far into the transcript and reset the live turn
// state, so the next turn starts a fresh bubble (used on result, stop, crash).
function finalizeLive(session, live) {
    if (live.assistantText) {
        session.transcript.push({ role: "assistant", text: live.assistantText });
    }
    live.assistantEl = null;
    live.assistantText = "";
    live.toolKeys = new Set();
    live.toolSummary = null;
}

function getLiveBubbles(key) {
    let live = liveBubbles.get(key);
    if (!live) {
        live = { assistantEl: null, toolKeys: new Set(), asks: new Map() };
        liveBubbles.set(key, live);
    }
    return live;
}

function handleStreamLine(key, line) {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }

    const isActive = key === activeKey;
    const session = sessions.find((s) => s.key === key);
    if (!session) return;
    const live = getLiveBubbles(key);

    // The CLI can emit a "result" mid-task (e.g. around a compaction/continuation
    // boundary) and then keep working. Any further activity after that means
    // the turn isn't actually over — flip busy back on so the status bar (and
    // stop button) reflect reality. (Not "system": model/mode switches emit
    // those while idle.)
    if (!busyKeys.has(key) && (msg.type === "stream_event" || msg.type === "assistant")) {
        setBusy(key, true);
    }

    switch (msg.type) {
        case "system": {
            if (msg.subtype === "init" && msg.session_id) {
                session.resumeId = msg.session_id;
                // Claude Code files the session under the cwd it runs in; remember
                // which, so a later cwd switch can carry the log across.
                session.resumeCwd = live.spawnCwd || session.cwd || "project";
            }
            // The mode can change from inside the session (approving a plan
            // switches out of Plan) — keep the picker in sync.
            if (msg.permissionMode && PERMISSION_MODES.includes(msg.permissionMode)
                && msg.permissionMode !== session.permissionMode) {
                session.permissionMode = msg.permissionMode;
                if (isActive) permissionSelect.value = msg.permissionMode;
                persistSessions();
            }
            break;
        }
        case "stream_event": {
            const ev = msg.event;
            // message_start carries this turn's prompt usage (current context
            // occupancy) — capture it for the context bar and live status.
            if (ev?.type === "message_start" && ev.message?.usage) {
                live.lastUsage = ev.message.usage;
                const u = ev.message.usage;
                live.promptTokens =
                    (u.input_tokens || 0) +
                    (u.cache_read_input_tokens || 0) +
                    (u.cache_creation_input_tokens || 0);
            }
            // message_delta carries the growing output token count.
            if (ev?.type === "message_delta" && ev.usage) {
                live.outputTokens = ev.usage.output_tokens || live.outputTokens || 0;
                if (isActive) renderStatus();
            }
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                if (!live.assistantEl && isActive) {
                    live.assistantEl = appendBubble("assistant", "");
                }
                live.assistantText = (live.assistantText || "") + ev.delta.text;
                if (live.assistantEl) scheduleMarkdown(live.assistantEl, live.assistantText);
                live.activity = "Writing";
                live.toolSummary = null;
            }
            break;
        }
        case "assistant": {
            // The latest assistant message's usage reflects the current prompt
            // size (per-turn, not cumulative) — best estimate of context used.
            if (msg.message?.usage) live.lastUsage = msg.message.usage;
            const blocks = msg.message?.content || [];
            for (const block of blocks) {
                if (block.type === "tool_use" && !live.toolKeys.has(block.id)) {
                    live.toolKeys.add(block.id);
                    const summary = `${block.name} ${JSON.stringify(block.input || {})}`;
                    // These surface as cards when their control_request arrives
                    // (see "control_request"), not as tool bubbles.
                    if (block.name === "AskUserQuestion" || block.name === "ExitPlanMode") {
                        session.transcript.push({ role: "tool", text: summary });
                        continue;
                    }
                    if (isActive) appendBubble("tool", summary);
                    session.transcript.push({ role: "tool", text: summary });
                    live.activity = `Running ${block.name}`;
                    live.toolSummary = summary;
                    if (isActive) renderStatus();
                }
            }
            break;
        }
        case "control_request": {
            // Claude Code asks us: tool permission (incl. AskUserQuestion and
            // ExitPlanMode, which are "asks" too). Anything else we don't
            // implement gets an error reply so the CLI never waits on us.
            const req = msg.request || {};
            if (req.subtype === "can_use_tool") {
                live.asks.set(msg.request_id, req);
                live.activity = "Waiting for you";
                live.toolSummary = null;
                if (isActive) {
                    appendAsk(key, msg.request_id, req);
                    renderStatus();
                }
            } else {
                control(key, {
                    type: "control_response",
                    response: { subtype: "error", request_id: msg.request_id, error: `Studio doesn't support ${req.subtype}` },
                }).catch(() => {});
            }
            break;
        }
        case "control_cancel_request": {
            live.asks.delete(msg.request_id);
            resolveAskCard(msg.request_id, "Cancelled");
            break;
        }
        case "result": {
            // Asks can't outlive their turn.
            expireAsks(live);
            // Stopped by the user (interrupt): the CLI reports that as an error
            // result, but it's just a stop.
            if (live.interrupting) {
                live.interrupting = false;
                finalizeLive(session, live);
                live.pendingText = null;
                if (isActive) appendBubble("system", "Stopped.");
                session.transcript.push({ role: "system", text: "Stopped." });
                setBusy(key, false);
                persistSessions();
                break;
            }
            // A --resume whose conversation can't be found (e.g. its log was
            // deleted) fails before doing anything. Drop the stale id and resend
            // the message as a fresh conversation once the dead process closes.
            const errors = Array.isArray(msg.errors) ? msg.errors.join("\n") : "";
            if (msg.is_error && /No conversation found/i.test(errors) && live.pendingText) {
                session.resumeId = null;
                live.retryText = live.pendingText;
                live.retryImages = live.pendingImages || [];
                persistSessions();
                break;
            }
            // Finalize the streamed assistant message into the transcript.
            const streamed = !!live.assistantText;
            finalizeLive(session, live);
            if (msg.is_error) {
                // Overloaded, max turns, expired login…: show it as an error, not
                // as if Claude had said it.
                const text = errors || msg.result || `Claude stopped (${msg.subtype || "error"})`;
                if (isActive) appendBubble("error", text);
                session.transcript.push({ role: "error", text });
            } else if (!streamed && msg.result) {
                if (isActive) appendBubble("assistant", msg.result);
                session.transcript.push({ role: "assistant", text: msg.result });
            }
            live.pendingText = null;

            // Auto-name the session from the first exchange.
            if (session.name === "New session") {
                const firstUser = session.transcript.find((m) => m.role === "user");
                if (firstUser) session.name = firstUser.text.slice(0, 40) || "Image";
            }

            updateUsage(session, live.lastUsage, msg.modelUsage);
            live.lastUsage = null;
            setBusy(key, false);
            persistSessions();
            renderSessionsList();
            // A turn just completed — refresh account quota usage.
            refreshUsage();
            break;
        }
        case "rate_limit_event": {
            // Note: don't fetch /api/oauth/usage here — it fires repeatedly and
            // would 429 the endpoint. The throttled post-result refresh covers it.
            break;
        }
        case "__stderr__": {
            if (isActive) appendBubble("system", msg.line);
            break;
        }
        case "__closed__": {
            // A late close from a process that has since been replaced (stop,
            // then a quick resend) must not mark the new one dead.
            if (msg.pid && live.pid && msg.pid !== live.pid) break;
            session._dead = true;
            live.interrupting = false;
            expireAsks(live);
            if (live.retryText != null) {
                const text = live.retryText;
                const images = live.retryImages || [];
                live.retryText = live.retryImages = null;
                if (isActive) {
                    appendBubble("system", "Couldn't find the previous conversation — continuing in a fresh one.");
                }
                spawnAndSend(session, text, images);
                break;
            }
            // Exited mid-turn (crash, killed from outside): keep what streamed
            // and say so, rather than leaving a spinner that never ends.
            if (busyKeys.has(key)) {
                finalizeLive(session, live);
                const text = "Claude exited unexpectedly. Send again to resume.";
                if (isActive) appendBubble("error", text);
                session.transcript.push({ role: "error", text });
                persistSessions();
            }
            live.pendingText = null;
            setBusy(key, false);
            break;
        }
        default:
            break;
    }
}

// Record the context usage on the session so the bar can be restored when the
// session is reopened, then refresh if it's active.
//
// `usage` is the LAST turn's prompt usage (from the latest assistant/message_start
// message) — input + cache-read + cache-creation tokens, i.e. how full the
// context window is right now. NOTE: the result event's own `usage`/`modelUsage`
// are *cumulative* over the process lifetime and grow past the window, so they
// must not be used here. The context window itself is read from modelUsage
// (a constant per model; take the largest, which is the conversational model's).
function updateUsage(session, usage, modelUsage) {
    if (!usage) return;
    const used =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
    const windows = Object.values(modelUsage || {})
        .map((m) => m.contextWindow || 0)
        .filter(Boolean);
    const contextWindow = windows.length ? Math.max(...windows) : CONTEXT_WINDOW_DEFAULT;
    session.usage = { used, contextWindow };
    if (session.key === activeKey) renderUsageBars(session);
    renderSessionsList();
}

// Account-wide quota usage (the numbers behind Claude's /usage), fetched from
// the backend. Shared across sessions, so kept module-global rather than on a
// session. Shape: { five_hour:{utilization,resets_at}, seven_day:{...} }.
// Seeded from localStorage so the bar shows the last known value immediately
// (and never blanks) even if the first fetch is rate-limited.
let accountUsage = null;
try {
    accountUsage = JSON.parse(localStorage.getItem("claude.accountUsage") || "null");
} catch {
    accountUsage = null;
}

// The /api/oauth/usage endpoint rate-limits (429) if hit too often, which
// would blank the bar — so throttle to at most once per minute and coalesce
// concurrent calls. Pass force=true to bypass (e.g. initial load).
let lastUsageFetch = 0;
let usageFetching = false;
const USAGE_MIN_INTERVAL_MS = 60000;
async function refreshUsage(force) {
    const now = Date.now();
    if (usageFetching) return;
    if (!force && now - lastUsageFetch < USAGE_MIN_INTERVAL_MS) return;
    usageFetching = true;
    lastUsageFetch = now;
    let ok = false;
    try {
        const next = await invoke("get_claude_usage");
        // Only adopt a well-formed payload; keep the last good value otherwise
        // so a transient fetch/auth/keychain failure doesn't blank the bar.
        if (next && next.five_hour) {
            accountUsage = next;
            localStorage.setItem("claude.accountUsage", JSON.stringify(next));
            ok = true;
        }
    } catch {
        // keep last known accountUsage
    } finally {
        usageFetching = false;
    }
    renderUsageBars(sessions.find((s) => s.key === activeKey));
    // If a fetch failed (e.g. transient 429), retry in the background rather
    // than waiting for the next turn — otherwise the bar can stay stale.
    if (!ok) setTimeout(() => refreshUsage(true), 30000);
}

function fillColor(pct) {
    if (pct >= 90) return "var(--rose)";
    if (pct >= 70) return "var(--amber, var(--sage))";
    return "var(--sage)";
}

// Paint usage: context bar from the active session, 5-hour quota bar and the
// 7-day pie from the account usage.
function renderUsageBars(session) {
    const usage = session?.usage;
    if (usage) {
        const pct = Math.min(100, Math.round((usage.used / usage.contextWindow) * 100));
        contextFill.style.width = `${pct}%`;
        contextPct.textContent = `${pct}% · ${usage.used.toLocaleString()} / ${usage.contextWindow.toLocaleString()}`;
    } else {
        contextFill.style.width = "0%";
        contextPct.textContent = "0%";
    }

    const fiveHourEl = document.getElementById("five-hour");
    const fiveHour = accountUsage?.five_hour;
    if (fiveHour && typeof fiveHour.utilization === "number") {
        const pct = Math.round(fiveHour.utilization);
        planStatus.textContent = `${pct}%`;
        planFill.style.width = `${pct}%`;
        planFill.style.background = fillColor(pct);
        if (fiveHourEl) {
            fiveHourEl.title = `5-hour usage: ${pct}%${
                fiveHour.resets_at ? ` · resets ${fmtReset(fiveHour.resets_at)}` : ""
            }`;
        }
    } else {
        planFill.style.width = "0%";
        planStatus.textContent = "—";
        if (fiveHourEl) fiveHourEl.title = "5-hour usage";
    }

    renderSevenDayPie();
}

// 7-day usage as a conic-gradient pie wedge.
function renderSevenDayPie() {
    const sevenDay = accountUsage?.seven_day;
    const labelEl = sevenDayWrap.querySelector(".claude-sevenday__label");
    if (sevenDay && typeof sevenDay.utilization === "number") {
        const pct = Math.round(sevenDay.utilization);
        const deg = (pct / 100) * 360;
        const color = fillColor(pct);
        sevenDayPie.style.background = `conic-gradient(${color} ${deg}deg, var(--hairline-strong) ${deg}deg)`;
        // Days until the weekly window resets.
        const left = daysUntil(sevenDay.resets_at);
        if (labelEl) labelEl.textContent = left != null ? `${left}d` : "7d";
        sevenDayWrap.title = `7-day usage: ${pct}%${
            left != null ? ` · resets in ${left} day${left === 1 ? "" : "s"}` : ""
        }`;
    } else {
        sevenDayPie.style.background = "var(--hairline-strong)";
        if (labelEl) labelEl.textContent = "7d";
        sevenDayWrap.title = "7-day usage";
    }
}

// Friendly reset time, e.g. "at 8:10 PM (in 2h 35m)".
function fmtReset(iso) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const time = new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const mins = Math.max(0, Math.round((t - Date.now()) / 60000));
    const rel = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    return `at ${time} (in ${rel})`;
}

// Whole days from now until an ISO timestamp (rounded up, min 0).
function daysUntil(iso) {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isNaN(ms)) return null;
    return Math.max(0, Math.ceil(ms / 86400000));
}

async function sendMessage(text, images = []) {
    if (!activeKey) {
        const proj = await defaultProject();
        if (!proj) {
            appendBubble("system", "No project found in ~/Projects.");
            return;
        }
        await createSession(proj.path, proj.name);
    }
    const session = sessions.find((s) => s.key === activeKey);
    if (!session) return;

    // The transcript keeps only small thumbnails; the full images go to Claude.
    const thumbs = images.map((i) => i.thumb);
    appendBubble("user", text, thumbs);
    session.transcript.push(thumbs.length ? { role: "user", text, images: thumbs } : { role: "user", text });
    persistSessions();

    // Claude is waiting on a card: like the terminal, typing instead of
    // clicking declines the ask with the message as feedback. (With images
    // attached, decline and send the message as a turn so they aren't lost.)
    const live = getLiveBubbles(session.key);
    if (live.asks.size) {
        for (const id of [...live.asks.keys()]) {
            answerAsk(session.key, id, { behavior: "deny", message: `The user replied instead: ${text}` }, "Replied instead");
        }
        if (!images.length) return;
    }

    await spawnAndSend(session, text, images);
}

// Stream-json content for a user message: images first (as the API
// recommends), then the text. Plain text needs no blocks.
function messageContent(text, images) {
    if (!images.length) return null;
    const blocks = images.map((i) => ({
        type: "image",
        source: { type: "base64", media_type: i.media_type, data: i.data },
    }));
    if (text) blocks.push({ type: "text", text });
    return blocks;
}

// Write a message to the session's claude process, (re)spawning it if needed.
async function spawnAndSend(session, text, images = []) {
    if (session._dead) {
        await invoke("claude_stop", { key: session.key });
        session._dead = false;
    }

    await ensureListener(session.key);
    // Reset live progress state for this turn.
    const live = getLiveBubbles(session.key);
    live.turnStart = Date.now();
    live.outputTokens = 0;
    live.promptTokens = 0;
    live.activity = "Working";
    live.pendingText = text;
    live.pendingImages = images;
    live.spawnCwd = session.cwd || "project";
    setBusy(session.key, true);
    try {
        live.pid = await invoke("claude_send", {
            key: session.key,
            projectPath: session.projectPath,
            model: session.model,
            text,
            content: messageContent(text, images),
            resume: session.resumeId,
            permissionMode: session.permissionMode || "default",
            cwd: session.cwd || "project",
            // Where the conversation was last recorded (it may differ from cwd
            // after an Artifacts ↔ Code switch; the backend carries it over).
            resumeCwd: session.resumeCwd || session.cwd || "project",
        });
    } catch (err) {
        const msg = `Couldn't start Claude: ${err}`;
        if (session.key === activeKey) appendBubble("error", msg);
        session.transcript.push({ role: "error", text: msg });
        live.pendingText = null;
        setBusy(session.key, false);
    }
}

// Stop the running turn. Interrupting keeps the process (and its context)
// alive; the CLI ends the turn with a result, handled as "Stopped." If it
// doesn't respond promptly, fall back to killing the process.
async function stopSession(key) {
    if (!busyKeys.has(key)) return;
    const live = getLiveBubbles(key);
    const session = sessions.find((s) => s.key === key);
    if (session && !session._dead && live.pid) {
        live.interrupting = true;
        try {
            await controlRequest(key, { subtype: "interrupt" });
            setTimeout(() => {
                if (live.interrupting && busyKeys.has(key)) killSession(key);
            }, 4000);
            return;
        } catch {
            live.interrupting = false;
        }
    }
    killSession(key);
}

// End a turn by killing its process (the next send respawns with --resume).
async function killSession(key) {
    if (!busyKeys.has(key)) return;
    const session = sessions.find((s) => s.key === key);
    const live = getLiveBubbles(key);
    if (session) {
        finalizeLive(session, live);
        persistSessions();
    }
    live.pendingText = null;
    live.interrupting = false;
    expireAsks(live);

    try {
        await invoke("claude_stop", { key });
    } catch {
        // ignore
    }
    if (session) session._dead = true;
    setBusy(key, false);
    if (key === activeKey) appendBubble("system", "Stopped.");
}

// The cwd is fixed at spawn: end the session's process so the next send
// respawns in the new directory (--resume keeps the context).
function restartOnNextSend(session) {
    if (busyKeys.has(session.key)) {
        killSession(session.key);
    } else if (!session._dead && listeners.has(session.key)) {
        invoke("claude_stop", { key: session.key }).catch(() => {});
        session._dead = true;
    }
}

stopBtn.addEventListener("click", () => {
    if (activeKey) stopSession(activeKey);
});

form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = promptInput.value.trim();
    if (!text && !attachments.length) return;
    // Wait for images still being read/resized before sending.
    if (attachments.some((a) => !a.ready)) return;
    const images = attachments.map((a) => a.image);
    promptInput.value = "";
    attachments = [];
    renderAttachments();
    sendMessage(text, images);
});

// --- Image attachments (paste / drop) ------------------------------------------
// Images wait in a tray above the input and go out with the next message as
// image content blocks. Large ones are scaled down first: Claude downsizes
// anything much bigger anyway, and the API caps each image at 5 MB.
const attachmentsEl = document.getElementById("attachments");
const MAX_EDGE = 2000;
const MAX_BASE64 = 3_500_000;
/** @type {Array<{id:number, ready:boolean, thumb?:string, image?:{media_type:string,data:string,thumb:string}, error?:string}>} */
let attachments = [];
let attachmentSeq = 0;

function canvasFor(bitmap, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
}

const base64Of = (dataUrl) => dataUrl.slice(dataUrl.indexOf(",") + 1);

// Blob → { media_type, data, thumb }, re-encoding only when too big.
async function prepareImage(blob) {
    const bitmap = await createImageBitmap(blob);
    const thumb = canvasFor(bitmap, 160).toDataURL("image/jpeg", 0.8);
    const dataUrl = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(blob);
    });
    const tooBig = Math.max(bitmap.width, bitmap.height) > MAX_EDGE || dataUrl.length > MAX_BASE64;
    if (!tooBig && /^image\/(png|jpeg|gif|webp)$/.test(blob.type)) {
        return { media_type: blob.type, data: base64Of(dataUrl), thumb };
    }
    const canvas = canvasFor(bitmap, MAX_EDGE);
    let out = canvas.toDataURL("image/png");
    let type = "image/png";
    if (out.length > MAX_BASE64) {
        out = canvas.toDataURL("image/jpeg", 0.9);
        type = "image/jpeg";
    }
    return { media_type: type, data: base64Of(out), thumb };
}

function addAttachment(load) {
    const a = { id: ++attachmentSeq, ready: false };
    attachments.push(a);
    renderAttachments();
    load()
        .then((image) => {
            a.image = image;
            a.thumb = image.thumb;
            a.ready = true;
        })
        .catch((err) => {
            attachments = attachments.filter((x) => x !== a);
            appendBubble("error", `Couldn't attach image: ${err}`);
        })
        .finally(renderAttachments);
}

function renderAttachments() {
    attachmentsEl.innerHTML = "";
    attachmentsEl.hidden = !attachments.length;
    for (const a of attachments) {
        const tile = document.createElement("div");
        tile.className = "claude-attachment" + (a.ready ? "" : " is-loading");
        if (a.thumb) {
            const img = document.createElement("img");
            img.src = a.thumb;
            img.alt = "";
            tile.append(img);
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "claude-attachment__remove";
        remove.title = "Remove";
        remove.innerHTML = `<span class="mi ph ph-x"></span>`;
        remove.addEventListener("click", () => {
            attachments = attachments.filter((x) => x !== a);
            renderAttachments();
            promptInput.focus();
        });
        tile.append(remove);
        attachmentsEl.append(tile);
    }
}

// Paste: the paste event's own clipboard data (no permission prompt, unlike
// navigator.clipboard.read()). Text pastes are left alone.
promptInput.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) addAttachment(() => prepareImage(f));
});

// Drop: macOS file drops arrive as Tauri drag-drop events with paths (the
// webview never sees HTML5 file drags). Images attach; any other file drops
// its path into the prompt so Claude can read it.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|tiff?)$/i;
const dropZone = document.querySelector(".claude-right");
window.__TAURI__.webview?.getCurrentWebview().onDragDropEvent((event) => {
    const { type, paths = [] } = event.payload || {};
    if (type === "enter" || type === "over") {
        dropZone.classList.add("is-dropping");
        return;
    }
    dropZone.classList.remove("is-dropping");
    if (type !== "drop" || !paths.length) return;
    const others = [];
    for (const path of paths) {
        if (!IMAGE_EXT.test(path)) {
            others.push(path);
            continue;
        }
        addAttachment(async () => {
            const { media_type, data } = await invoke("read_chat_image", { path });
            const blob = await (await fetch(`data:${media_type};base64,${data}`)).blob();
            return prepareImage(blob);
        });
    }
    if (others.length) {
        const sep = promptInput.value && !/\s$/.test(promptInput.value) ? " " : "";
        promptInput.value += sep + others.join(" ");
    }
    promptInput.focus();
});

promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
    }
});

// Double-click a message to copy its full text to the clipboard.
transcriptEl.addEventListener("dblclick", async (e) => {
    const body = e.target.closest(".claude-msg__body");
    if (!body) return;
    try {
        await navigator.clipboard.writeText(rawText.get(body) ?? body.textContent);
        window.getSelection()?.removeAllRanges();
        body.classList.add("is-copied");
        setTimeout(() => body.classList.remove("is-copied"), 600);
    } catch {
        // ignore clipboard failures
    }
});

// Model and permission mode apply to a running process live (control
// requests). With no process, they're simply used as flags at the next spawn;
// if the process turns out to be gone, respawn next time.
function applyLive(session, request) {
    const live = liveBubbles.get(session.key);
    if (session._dead || !live?.pid) return;
    controlRequest(session.key, request).catch(() => {
        session._dead = true;
    });
}

modelSelect.addEventListener("change", () => {
    const session = sessions.find((s) => s.key === activeKey);
    if (!session) return;
    session.model = modelSelect.value;
    persistSessions();
    applyLive(session, { subtype: "set_model", model: session.model });
});

permissionSelect.addEventListener("change", () => {
    const session = sessions.find((s) => s.key === activeKey);
    if (!session) return;
    session.permissionMode = permissionSelect.value;
    persistSessions();
    applyLive(session, { subtype: "set_permission_mode", mode: session.permissionMode });
});

cwdSelect.addEventListener("change", () => {
    const session = sessions.find((s) => s.key === activeKey);
    if (session) {
        session.cwd = cwdSelect.value;
        persistSessions();
        // cwd is set when the claude process spawns; restart a running one so the
        // next send runs in the newly-selected directory.
        restartOnNextSend(session);
    }
    // The "Recent" history list is per-directory — re-list for the new cwd.
    const proj = sessions.find((s) => s.key === activeKey) || lastProject;
    if (proj) {
        renderHistoryList(
            proj.projectPath || proj.path,
            proj.projectName || proj.name,
        );
    }
});

sessionsToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    sessionsPanel.hidden = !sessionsPanel.hidden;
    sessionsToggle.classList.toggle("is-active", !sessionsPanel.hidden);
});

document.querySelector(".claude-right").addEventListener("click", () => {
    if (!sessionsPanel.hidden) {
        sessionsPanel.hidden = true;
        sessionsToggle.classList.remove("is-active");
    }
});

historyToggle.checked = includeOutside;
historyToggle.addEventListener("change", async () => {
    includeOutside = historyToggle.checked;
    localStorage.setItem("claude.includeOutside", includeOutside);
    const session = sessions.find((s) => s.key === activeKey);
    if (session) {
        await renderHistoryList(session.projectPath, session.projectName);
    } else {
        const proj = await defaultProject();
        if (proj) await renderHistoryList(proj.path, proj.name);
    }
});

async function startNewSession() {
    const proj = await defaultProject();
    if (!proj) {
        appendBubble("system", "No project found in ~/Projects.");
        return;
    }
    await createSession(proj.path, proj.name);
}

newSessionBtn.addEventListener("click", startNewSession);

// The window is reused across projects and only gets a color on "claude-jump"
// (i.e. when opened/switched to). If the project's accent is changed elsewhere
// (Mode switcher) while this window is already frontmost, pick it up too.
listen("fs-changed", async () => {
    if (!currentProjectPath) return;
    const ws = await invoke("read_workspace", { path: currentProjectPath }).catch(() => null);
    if (ws) setProjectColor(ws.color || "");
});

listen("claude-jump", async (event) => {
    // The window hides rather than closes, so opening it doesn't re-run init();
    // refresh usage on each open (throttled, so rapid reopens don't 429).
    refreshUsage();
    const { key, projectPath, projectName, sprite, color } = event.payload || {};
    if (sprite !== undefined) setSprite(sprite);
    if (color !== undefined) setProjectColor(color);
    if (key && sessions.some((s) => s.key === key)) {
        await switchTo(key);
        return;
    }
    if (projectPath) {
        const name = projectName || projectPath.split("/").filter(Boolean).pop();
        setLastProject(projectPath, name);
        setWindowTitle(name);
        // Scope the sidebar to this project from here on.
        currentProjectPath = projectPath;
        // Return to the last active session for this project if it still
        // exists, else its most recent (sessions are kept newest-first),
        // rather than starting fresh.
        const recent = sessions.find((s) => s.projectPath === projectPath);
        if (recent) {
            const lastKey = localStorage.getItem(activeKeyName());
            const lastActive = sessions.find(
                (s) => s.key === lastKey && s.projectPath === projectPath,
            );
            await switchTo(lastActive ? lastActive.key : recent.key);
            return;
        }
        await createSession(projectPath, name);
    }
});

// localStorage is shared across the companion's per-project windows, so the
// "last active session" must be keyed per project.
function activeKeyName() {
    return "claude.activeKey:" + (currentProjectPath || "");
}

(async function init() {
    initDevInspect();
    renderStatus(); // hidden unless a turn is already running
    // A per-project window carries its project in the URL; adopt it before
    // loading that project's sessions.
    const params = new URLSearchParams(location.search);
    const urlProject = params.get("project");
    if (urlProject) {
        currentProjectPath = urlProject;
        const name = params.get("name") || urlProject.split("/").filter(Boolean).pop();
        setLastProject(urlProject, name);
        setSprite(params.get("sprite") || "");
        setWindowTitle(name);
        invoke("save_last_project", {
            path: urlProject,
            name,
            sprite: params.get("sprite") || "",
        }).catch(() => {});
    }
    applyStatusSprite();
    await loadSessions();
    renderSessionsList();
    refreshUsage(true);
    if (sessions.length) {
        // Return to the last active session if it still exists, else the newest.
        const lastKey = localStorage.getItem(activeKeyName());
        const restore = sessions.some((s) => s.key === lastKey) ? lastKey : sessions[0].key;
        await switchTo(restore);
    } else {
        resetUsageBars();
        const proj = await defaultProject();
        if (proj) {
            renderHistoryList(proj.path, proj.name);
            setWindowTitle(proj.name);
        }
    }
})();
