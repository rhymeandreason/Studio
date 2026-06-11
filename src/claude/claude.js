const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

function setWindowTitle(projectName) {
    getCurrentWindow().setTitle(projectName ? `Claude · ${projectName}` : "Claude");
}

const sessionsListEl = document.getElementById("sessions-list");
const historyListEl = document.getElementById("history-list");
const historyToggle = document.getElementById("history-toggle");
const sessionsPanel = document.getElementById("sessions-panel");
const sessionsToggle = document.getElementById("sessions-toggle");
const sessionNameEl = document.getElementById("session-name");
const transcriptEl = document.getElementById("transcript");
const form = document.getElementById("input-form");
const promptInput = document.getElementById("prompt-input");
const modelSelect = document.getElementById("model-select");
const permissionSelect = document.getElementById("permission-select");
const newSessionBtn = document.getElementById("new-session");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const contextFill = document.getElementById("context-fill");
const contextPct = document.getElementById("context-pct");
const planFill = document.getElementById("plan-fill");
const planStatus = document.getElementById("plan-status");

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
    if (key === activeKey) reflectBusy(key);
}

function reflectBusy(key) {
    const busy = busyKeys.has(key);
    stopBtn.hidden = !busy;
    sendBtn.hidden = busy;
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
        const raw = await invoke("read_claude_sessions");
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
    await invoke("save_claude_sessions", { data: JSON.stringify(slim) });
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

function renderSessionsList() {
    sessionsListEl.innerHTML = "";
    // Only show sessions for the current project.
    const visible = currentProjectPath
        ? sessions.filter((s) => s.projectPath === currentProjectPath)
        : sessions;
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
        item.innerHTML = `<span class="claude-session-item__name"></span><span class="claude-session-item__project"><span class="mi mi-sm">folder</span><span></span></span><span class="claude-session-item__model"></span><button class="claude-session-item__rename" title="Rename session"><span class="mi">edit</span></button><button class="claude-session-item__delete" title="Delete session"><span class="mi">delete</span></button>`;
        item.querySelector(".claude-session-item__name").textContent = s.name;
        item.querySelector(".claude-session-item__project span:last-child").textContent =
            s.projectName;
        item.querySelector(".claude-session-item__model").textContent = modelLabel(s.model);
        item.addEventListener("click", () => switchTo(s.key));
        item.querySelector(".claude-session-item__rename").addEventListener("click", (e) => {
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
        history = await invoke("list_claude_project_sessions", { projectPath });
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
        resumeId: h.session_id,
        transcript,
    };
    sessions.unshift(session);
    await persistSessions();
    await switchTo(session.key);
}

function renderTranscript(session) {
    transcriptEl.innerHTML = "";
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
    const el = document.createElement("div");
    el.className = `claude-msg claude-msg--${role}`;
    if (role === "assistant") {
        const icon = document.createElement("img");
        icon.className = "claude-msg__icon claude-msg__icon--svg";
        icon.src = "claude-icon.svg";
        icon.alt = "";
        el.appendChild(icon);
    } else if (role !== "system") {
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
    localStorage.setItem("claude.activeKey", key);
    sessionNameEl.textContent = `${session.name} · ${session.projectName}`;
    setWindowTitle(session.projectName);
    modelSelect.value = session.model || "sonnet";
    permissionSelect.value = session.permissionMode || "default";
    renderTranscript(session);
    renderUsageBars(session);
    renderSessionsList();
    ensureListener(session.key);
    reflectBusy(key);
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
                if (key === activeKey) {
                    sessionNameEl.textContent = `${session.name} · ${session.projectName}`;
                }
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
        resumeId: null,
        transcript: [],
    };
    sessions.unshift(session);
    await persistSessions();
    await switchTo(session.key);
}

async function defaultProject() {
    try {
        const active = await invoke("get_active_project");
        if (active) return active;
    } catch {
        // ignore
    }
    try {
        const list = await invoke("list_projects");
        if (list && list.length) return list[0];
    } catch {
        // ignore
    }
    return null;
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
            // occupancy) — capture it for the context bar.
            if (ev?.type === "message_start" && ev.message?.usage) {
                live.lastUsage = ev.message.usage;
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
            // Quota changed; pull fresh account usage for the 5-hour bar.
            refreshUsage();
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
}

// Account-wide quota usage (the numbers behind Claude's /usage), fetched from
// the backend. Shared across sessions, so kept module-global rather than on a
// session. Shape: { five_hour:{utilization,resets_at}, seven_day:{...} }.
let accountUsage = null;

async function refreshUsage() {
    try {
        accountUsage = await invoke("get_claude_usage");
    } catch {
        accountUsage = null;
    }
    renderUsageBars(sessions.find((s) => s.key === activeKey));
}

function fillColor(pct) {
    if (pct >= 90) return "var(--rose)";
    if (pct >= 70) return "var(--amber, var(--sage))";
    return "var(--sage)";
}

// Paint both bars: context from the active session, 5-hour quota from the
// account usage (with the 7-day figure appended).
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

    const fiveHour = accountUsage?.five_hour;
    if (fiveHour && typeof fiveHour.utilization === "number") {
        const pct = Math.round(fiveHour.utilization);
        const sevenDay = accountUsage?.seven_day;
        const sevenPct =
            sevenDay && typeof sevenDay.utilization === "number"
                ? ` · 7d ${Math.round(sevenDay.utilization)}%`
                : "";
        planStatus.textContent = `${pct}%${sevenPct}`;
        planFill.style.width = `${pct}%`;
        planFill.style.background = fillColor(pct);
    } else {
        planFill.style.width = "0%";
        planStatus.textContent = "—";
    }
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

sessionsToggle.addEventListener("click", () => {
    sessionsPanel.hidden = !sessionsPanel.hidden;
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
document.getElementById("new-session-side").addEventListener("click", startNewSession);

listen("claude-jump", async (event) => {
    const { key, projectPath } = event.payload || {};
    if (key && sessions.some((s) => s.key === key)) {
        await switchTo(key);
        return;
    }
    if (projectPath) {
        // Scope the sidebar to this project from here on.
        currentProjectPath = projectPath;
        // Return to the last active session for this project if it still
        // exists, else its most recent (sessions are kept newest-first),
        // rather than starting fresh.
        const recent = sessions.find((s) => s.projectPath === projectPath);
        if (recent) {
            const lastKey = localStorage.getItem("claude.activeKey");
            const lastActive = sessions.find(
                (s) => s.key === lastKey && s.projectPath === projectPath,
            );
            await switchTo(lastActive ? lastActive.key : recent.key);
            return;
        }
        let projectName = projectPath.split("/").filter(Boolean).pop();
        try {
            const list = await invoke("list_projects");
            const match = list.find((p) => p.path === projectPath);
            if (match) projectName = match.name;
        } catch {
            // ignore
        }
        await createSession(projectPath, projectName);
    }
});

(async function init() {
    await loadSessions();
    renderSessionsList();
    refreshUsage();
    if (sessions.length) {
        // Return to the last active session if it still exists, else the newest.
        const lastKey = localStorage.getItem("claude.activeKey");
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
