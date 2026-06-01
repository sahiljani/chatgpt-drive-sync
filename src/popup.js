const stateEl = document.getElementById("state");
const statusEl = document.getElementById("status");
const logsEl = document.getElementById("logs");
const connectButton = document.getElementById("connect");
const syncButton = document.getElementById("sync");
const optionsButton = document.getElementById("options");
const clearButton = document.getElementById("clear");
const copyButton = document.getElementById("copy");
let latestDiagnostics = null;

async function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function load() {
  const response = await send({ type: "GET_DIAGNOSTICS" });
  if (!response || !response.ok) {
    statusEl.textContent = response && response.error ? response.error : "Failed to load diagnostics.";
    return;
  }

  const data = response.data || {};
  latestDiagnostics = data;
  const status = data.status || {};
  stateEl.textContent = status.state || "unknown";
  renderStatus(data);

  renderLogs(data.logs || []);
}

function renderStatus(data) {
  const status = data.status || {};
  const state = status.state || "unknown";
  const title = status.title || status.conversationId || "No conversation synced yet";
  const when = status.at ? formatTime(status.at) : "";
  const folder = data.folderName || "ChatGPT Sync";
  const messageCount = Number.isFinite(status.messageCount) ? `${status.messageCount} messages` : "";

  const stateText = {
    synced: "Synced",
    syncing: "Syncing",
    connected: "Connected",
    installed: "Not connected",
    error: "Needs attention",
  }[state] || state;

  statusEl.replaceChildren();
  const titleEl = document.createElement("div");
  const metaEl = document.createElement("div");
  const detailEl = document.createElement("div");

  titleEl.className = "status-title";
  metaEl.className = "status-meta";
  detailEl.className = "status-meta";

  titleEl.textContent = state === "synced" ? `${stateText}: ${title}` : stateText;
  metaEl.textContent = [messageCount, when].filter(Boolean).join(" · ") || status.message || "";
  detailEl.textContent = `Drive: ${folder}/conversations`;

  statusEl.append(titleEl, metaEl, detailEl);
}

function renderLogs(logs) {
  logsEl.textContent = "";
  for (const log of logs.slice(0, 14)) {
    const item = document.createElement("li");
    const type = document.createElement("span");
    const time = document.createElement("span");
    const detail = document.createElement("span");

    type.className = "log-type";
    time.className = "log-time";
    detail.className = "log-detail";
    type.textContent = logLabel(log);
    time.textContent = formatTime(log.at);
    detail.textContent = logDetail(log);

    item.append(type, time, detail);
    logsEl.append(item);
  }
}

function logLabel(log) {
  const labels = {
    "sync-requested": "Sync queued",
    "sync-started": "Sync started",
    "conversation-fetch-page": "Fetched ChatGPT data",
    "auth-token-request": "Checking Google access",
    "auth-token-ok": "Google access ok",
    "drive-file-create": "Created Drive file",
    "drive-file-update": "Updated Drive file",
    "drive-index-create": "Created index",
    "drive-index-update": "Updated index",
    "sync-complete": "Sync complete",
    "toast-sent": "Notification shown",
    "sync-error": "Sync failed",
    "drive-contents": "Drive checked",
    "manual-sync-requested": "Manual sync",
    installed: "Extension ready",
    "drive-connected": "Drive connected",
  };

  return labels[log.type] || log.type;
}

function logDetail(log) {
  const d = log.details || {};
  if (log.type === "sync-complete") return `${d.title || d.conversationId || "Conversation"} · ${d.messageCount || 0} messages`;
  if (log.type === "drive-file-create" || log.type === "drive-file-update") return d.name || d.fileId || "";
  if (log.type === "sync-error") return d.message || "Unknown error";
  if (log.type === "toast-sent") return `Method: ${d.method || "unknown"}`;
  if (d.reason) return `Reason: ${d.reason}`;
  if (d.conversationId) return d.conversationId;
  if (d.message) return d.message;
  return "";
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

connectButton.addEventListener("click", async () => {
  statusEl.textContent = "Connecting...";
  const response = await send({ type: "CONNECT_GOOGLE_DRIVE" });
  if (!response || !response.ok) {
    statusEl.textContent = response && response.error ? response.error : "Connection failed.";
  }
  await load();
});

syncButton.addEventListener("click", async () => {
  statusEl.textContent = "Scheduling sync...";
  const response = await send({ type: "MANUAL_SYNC_ACTIVE_TAB" });
  if (!response || !response.ok) {
    statusEl.textContent = response && response.error ? response.error : "Manual sync failed.";
    return;
  }
  await load();
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

clearButton.addEventListener("click", async () => {
  await send({ type: "CLEAR_LOGS" });
  await load();
});

copyButton.addEventListener("click", async () => {
  const text = JSON.stringify(latestDiagnostics || {}, null, 2);
  await navigator.clipboard.writeText(text);
  statusEl.textContent = "Diagnostics copied.";
});

load();
