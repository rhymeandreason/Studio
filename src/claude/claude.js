const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const sessionsListEl = document.getElementById("sessions-list");
const historyListEl = document.getElementById("history-list");
const sessionsPanel = document.getElementById("sessions-panel");
const sessionsToggle = document.getElementById("sessions-toggle");
const sessionNameEl = document.getElementById("session-name");
const transcriptEl = document.getElementById("transcript");
const form = document.getElementById("input-form");
const promptInput = document.getElementById("prompt-input");
const modelSelect = document.getElementById("model-select");
const newSessionBtn = document.getElementById("new-session");
const contextFill = document.getElementById("context-fill");
const contextPct = document.getElementById("context-pct");
const planFill = document.getElementById("plan-fill");
const planStatus = document.getElementById("plan-status");

const CONTEXT_WINDOW_DEFAULT = 200000;

/** @type {Array<Session>} */
let sessions = [];
let activeKey = null;
const listeners = new Map(); // key -> unlisten fn
const liveBubbles = new Map(); // key -> { assistantEl, toolKeys: Set }

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

function renderSessionsList() {
    sessionsListEl.innerHTML = "";
    if (!sessions.length) {
        const empty = document.createElement("div");
        empty.className = "claude-sessions__empty";
        empty.textContent = "No sessions yet.";
        sessionsListEl.appendChild(empty);
        return;
    }
    for (const s of sessions) {
        const btn = document.createElement("button");
        btn.className = "claude-session-item" + (s.key === activeKey ? " is-active" : "");
        btn.innerHTML = `<span class="claude-session-item__name"></span><span class="claude-session-item__project"><span class="mi mi-sm">folder</span><span></span></span>`;
        btn.querySelector(".claude-session-item__name").textContent = s.name;
        btn.querySelector(".claude-session-item__project span:last-child").textContent =
            s.projectName;
        btn.addEventListener("click", () => switchTo(s.key));
        sessionsListEl.appendChild(btn);
    }
}

async function renderHistoryList(projectPath, projectName) {
    document.getElementById("history-project").textContent = projectName;
    historyListEl.innerHTML = "";
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
    const session = {
        key: uuid(),
        name: h.summary,
        projectPath,
        projectName,
        model: modelSelect.value || "sonnet",
        resumeId: h.session_id,
        transcript: [],
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
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function appendBubble(role, text) {
    transcriptEl.querySelector(".claude-empty")?.remove();
    const el = document.createElement("div");
    el.className = `claude-msg claude-msg--${role}`;
    if (role !== "system") {
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
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
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
    sessionNameEl.textContent = `${session.name} · ${session.projectName}`;
    modelSelect.value = session.model || "sonnet";
    renderTranscript(session);
    resetUsageBars();
    renderSessionsList();
    ensureListener(session.key);
    renderHistoryList(session.projectPath, session.projectName);
}

async function createSession(projectPath, projectName) {
    const session = {
        key: uuid(),
        name: "New session",
        projectPath,
        projectName,
        model: modelSelect.value || "sonnet",
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
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                if (!live.assistantEl && isActive) {
                    live.assistantEl = appendBubble("assistant", "");
                }
                if (live.assistantEl) {
                    live.assistantEl.textContent += ev.delta.text;
                    transcriptEl.scrollTop = transcriptEl.scrollHeight;
                }
                live.assistantText = (live.assistantText || "") + ev.delta.text;
            }
            break;
        }
        case "assistant": {
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

            if (isActive) updateUsage(msg.usage, msg.modelUsage);
            persistSessions();
            renderSessionsList();
            break;
        }
        case "rate_limit_event": {
            if (isActive) updatePlanStatus(msg.rate_limit_info);
            break;
        }
        case "__stderr__": {
            if (isActive) appendBubble("system", msg.line);
            break;
        }
        case "__closed__": {
            session._dead = true;
            break;
        }
        default:
            break;
    }
}

function updateUsage(usage, modelUsage) {
    if (!usage) return;
    const contextWindow =
        Object.values(modelUsage || {})[0]?.contextWindow || CONTEXT_WINDOW_DEFAULT;
    const used =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
    const pct = Math.min(100, Math.round((used / contextWindow) * 100));
    contextFill.style.width = `${pct}%`;
    contextPct.textContent = `${pct}% · ${used.toLocaleString()} / ${contextWindow.toLocaleString()}`;
}

function updatePlanStatus(info) {
    if (!info) return;
    planStatus.textContent = info.status === "allowed" ? "OK" : info.status;
    planFill.style.width = info.status === "allowed" ? "10%" : "100%";
    planFill.style.background =
        info.status === "allowed" ? "var(--sage)" : "var(--rose)";
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
        });
        console.log("[claude] claude_send returned");
    } catch (err) {
        console.error("[claude] claude_send error", err);
        appendBubble("system", `Error: ${err}`);
    }
}

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

modelSelect.addEventListener("change", () => {
    const session = sessions.find((s) => s.key === activeKey);
    if (session) {
        session.model = modelSelect.value;
        persistSessions();
    }
});

sessionsToggle.addEventListener("click", () => {
    sessionsPanel.hidden = !sessionsPanel.hidden;
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
    if (sessions.length) {
        await switchTo(sessions[0].key);
    } else {
        resetUsageBars();
        const proj = await defaultProject();
        if (proj) renderHistoryList(proj.path, proj.name);
    }
})();
