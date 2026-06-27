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
    chev.className = "mi mi-sm notedrop__chev";
    chev.textContent = "expand_more";
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
const permissionSelect = createDropdown(document.getElementById("permission-select"), [
    { value: "default", label: "Ask" },
    { value: "acceptEdits", label: "Accept edits" },
    { value: "plan", label: "Plan" },
    { value: "bypassPermissions", label: "Bypass" },
]);
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

async function loadSessions() {
    try {
        // Per-project window: its own session file (companion). The in-Studio
        // window passes null and the backend uses the shared file.
        const raw = await invoke("read_claude_sessions", { project: currentProjectPath });
        sessions = raw ? JSON.parse(raw) : [];
    } catch {
        sessions = [];
    }
    // Drop usage stored by the old (cumulative, >100%) calculation so it
    // doesn't show a bogus number until the session's next turn recomputes it.
    for (const s of sessions) {
        if (s.usage && s.usage.used > s.usage.contextWindow) delete s.usage;
    }
}

async function persistSessions() {
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
    user: "person",
    assistant: "smart_toy",
    tool: "build",
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
        tab.innerHTML = `<span class="claude-tab__name"></span><button class="claude-tab__close" title="Close session"><span class="mi">close</span></button>`;
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
        item.innerHTML = `<span class="claude-session-item__name" title="Click to rename"></span><span class="claude-session-item__project"><span class="mi mi-sm">folder</span><span></span></span><span class="claude-session-item__meta"><span class="claude-session-item__model"></span><span class="claude-session-item__context"></span></span><button class="claude-session-item__delete" title="Delete session"><span class="mi">delete</span></button>`;
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
        empty.innerHTML = `<span class="mi">forum</span>Start the conversation`;
        transcriptEl.appendChild(empty);
        return;
    }
    for (const msg of session.transcript) {
        appendBubble(msg.role, msg.text);
    }
    // Switching into a session: jump to the latest.
    stickToBottom = true;
    scrollToBottom(true);
}

function appendBubble(role, text) {
    transcriptEl.querySelector(".claude-empty")?.remove();

    // Tool calls render collapsed: a clickable header (the tool name) that
    // expands to show the full input. Stored/streamed text is "name {input}".
    if (role === "tool") {
        const el = document.createElement("div");
        el.className = "claude-msg claude-msg--tool is-collapsed";
        const sp = text.indexOf(" ");
        const name = sp === -1 ? text : text.slice(0, sp);
        const detail = sp === -1 ? "" : text.slice(sp + 1);
        el.innerHTML = `<button class="claude-tool"><span class="mi claude-tool__chevron">chevron_right</span><span class="mi claude-tool__icon">build</span><span class="claude-tool__name"></span></button><pre class="claude-tool__detail"></pre>`;
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
    } else if (role !== "system" && role !== "user") {
        const icon = document.createElement("span");
        icon.className = "mi claude-msg__icon";
        icon.textContent = ROLE_ICONS[role] || "circle";
        el.appendChild(icon);
    }
    const body = document.createElement("div");
    body.className = "claude-msg__body";
    body.textContent = text;
    el.appendChild(body);
    transcriptEl.appendChild(el);
    // Always follow the user's own message; otherwise only if pinned to bottom.
    scrollToBottom(role === "user");
    return body;
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
    currentProjectPath = session.projectPath;
    // Remember the last active session so reopening the window returns to it.
    localStorage.setItem(activeKeyName(), key);
    sessionNameEl.textContent = session.name;
    setWindowTitle(session.projectName);
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

function ensureListener(key) {
    if (listeners.has(key)) return;
    console.log("[claude] listening on", `claude-stream-${key}`);
    const promise = listen(`claude-stream-${key}`, (event) => {
        console.log("[claude] event", event.payload);
        handleStreamLine(key, event.payload);
    });
    listeners.set(key, promise);
}

function getLiveBubbles(key) {
    let live = liveBubbles.get(key);
    if (!live) {
        live = { assistantEl: null, toolKeys: new Set() };
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
    // stop button) reflect reality.
    if (
        !busyKeys.has(key) &&
        (msg.type === "system" || msg.type === "stream_event" || msg.type === "assistant")
    ) {
        setBusy(key, true);
    }

    switch (msg.type) {
        case "system": {
            if (msg.subtype === "init" && msg.session_id) {
                session.resumeId = msg.session_id;
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
                if (live.assistantEl) {
                    live.assistantEl.textContent += ev.delta.text;
                    if (isActive) scrollToBottom();
                }
                live.assistantText = (live.assistantText || "") + ev.delta.text;
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
                    if (isActive) appendBubble("tool", summary);
                    session.transcript.push({ role: "tool", text: summary });
                    live.activity = `Running ${block.name}`;
                    live.toolSummary = summary;
                    if (isActive) renderStatus();
                }
            }
            break;
        }
        case "result": {
            // Finalize the streamed assistant message into the transcript.
            if (live.assistantText) {
                session.transcript.push({ role: "assistant", text: live.assistantText });
            } else if (msg.result) {
                if (isActive) appendBubble("assistant", msg.result);
                session.transcript.push({ role: "assistant", text: msg.result });
            }
            live.assistantEl = null;
            live.assistantText = "";
            live.toolKeys = new Set();
            live.toolSummary = null;

            // Auto-name the session from the first exchange.
            if (session.name === "New session") {
                const firstUser = session.transcript.find((m) => m.role === "user");
                if (firstUser) session.name = firstUser.text.slice(0, 40);
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
            session._dead = true;
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

async function sendMessage(text) {
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

    appendBubble("user", text);
    session.transcript.push({ role: "user", text });
    persistSessions();

    if (session._dead) {
        await invoke("claude_stop", { key: session.key });
        session._dead = false;
    }

    ensureListener(session.key);
    // Reset live progress state for this turn.
    const live = getLiveBubbles(session.key);
    live.turnStart = Date.now();
    live.outputTokens = 0;
    live.promptTokens = 0;
    live.activity = "Working";
    setBusy(session.key, true);
    console.log("[claude] sending", {
        key: session.key,
        projectPath: session.projectPath,
        model: session.model,
        resume: session.resumeId,
    });
    try {
        await invoke("claude_send", {
            key: session.key,
            projectPath: session.projectPath,
            model: session.model,
            text,
            resume: session.resumeId,
            permissionMode: session.permissionMode || "default",
            cwd: session.cwd || "project",
        });
        console.log("[claude] claude_send returned");
    } catch (err) {
        console.error("[claude] claude_send error", err);
        appendBubble("system", `Error: ${err}`);
        setBusy(session.key, false);
    }
}

// Interrupt a session's in-progress turn: finalize any streamed text, kill the
// subprocess (the next message respawns it with --resume, keeping context).
async function stopSession(key) {
    if (!busyKeys.has(key)) return;
    const session = sessions.find((s) => s.key === key);
    const live = getLiveBubbles(key);
    if (session && live.assistantText) {
        session.transcript.push({ role: "assistant", text: live.assistantText });
        persistSessions();
    }
    live.assistantEl = null;
    live.assistantText = "";
    live.toolKeys = new Set();

    try {
        await invoke("claude_stop", { key });
    } catch {
        // ignore
    }
    if (session) session._dead = true;
    setBusy(key, false);
    if (key === activeKey) appendBubble("system", "Stopped.");
}

stopBtn.addEventListener("click", () => {
    if (activeKey) stopSession(activeKey);
});

form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = promptInput.value.trim();
    if (!text) return;
    promptInput.value = "";
    sendMessage(text);
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
        await navigator.clipboard.writeText(body.textContent);
        window.getSelection()?.removeAllRanges();
        body.classList.add("is-copied");
        setTimeout(() => body.classList.remove("is-copied"), 600);
    } catch {
        // ignore clipboard failures
    }
});

modelSelect.addEventListener("change", () => {
    const session = sessions.find((s) => s.key === activeKey);
    if (session) {
        session.model = modelSelect.value;
        persistSessions();
    }
});

permissionSelect.addEventListener("change", () => {
    const session = sessions.find((s) => s.key === activeKey);
    if (!session) return;
    session.permissionMode = permissionSelect.value;
    persistSessions();
    // --permission-mode is applied when the session's claude process starts,
    // so a change mid-session takes effect after it restarts. If one is
    // already running, restart it on the next send so the new mode applies.
    if (!session._dead && listeners.has(session.key)) {
        invoke("claude_stop", { key: session.key }).catch(() => {});
        session._dead = true;
    }
});

cwdSelect.addEventListener("change", () => {
    const session = sessions.find((s) => s.key === activeKey);
    if (session) {
        session.cwd = cwdSelect.value;
        persistSessions();
        // cwd is set when the claude process spawns; restart a running one so the
        // next send runs in the newly-selected directory.
        if (!session._dead && listeners.has(session.key)) {
            invoke("claude_stop", { key: session.key }).catch(() => {});
            session._dead = true;
        }
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

listen("claude-jump", async (event) => {
    // The window hides rather than closes, so opening it doesn't re-run init();
    // refresh usage on each open (throttled, so rapid reopens don't 429).
    refreshUsage();
    const { key, projectPath, projectName, sprite } = event.payload || {};
    if (sprite !== undefined) setSprite(sprite);
    if (key && sessions.some((s) => s.key === key)) {
        await switchTo(key);
        return;
    }
    if (projectPath) {
        const name = projectName || projectPath.split("/").filter(Boolean).pop();
        setLastProject(projectPath, name);
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
