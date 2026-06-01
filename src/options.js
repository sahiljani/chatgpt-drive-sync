const folderNameInput = document.getElementById("folderName");
const saveFolderButton = document.getElementById("saveFolder");
const connectButton = document.getElementById("connect");
const clearLogsButton = document.getElementById("clearLogs");
const copyLogsButton = document.getElementById("copyLogs");
const statusEl = document.getElementById("status");
const logsEl = document.getElementById("logs");
const setupEl = document.getElementById("setup");
let latestData = null;

async function load() {
  const data = await chrome.storage.local.get(["folderName", "driveFolderId", "conversationsFolderId", "status", "logs"]);
  latestData = data;
  folderNameInput.value = data.folderName || "ChatGPT Sync";
  renderSetup();
  renderStatus(data);
  renderLogs(data.logs || []);
}

function renderSetup() {
  const manifest = chrome.runtime.getManifest();
  setupEl.textContent = [
    "Use these values when creating the Google Cloud OAuth client:",
    "",
    `Extension ID / Item ID: ${chrome.runtime.id}`,
    `Current client ID: ${(manifest.oauth2 && manifest.oauth2.client_id) || "Not set"}`,
    "",
    "Steps:",
    "1. In Google Cloud, create an OAuth client.",
    "2. Choose type: Chrome extension / Chrome app.",
    "3. Paste the Extension ID above as the Item ID.",
    "4. Copy the generated client ID into manifest.json.",
    "5. Reload this extension from chrome://extensions.",
    "",
    "Note: Chrome requires the client ID in manifest.json, so it cannot be changed from this page.",
  ].join("\n");
}

function renderStatus(data) {
  const status = data.status || {};
  statusEl.textContent = [
    `State: ${status.state || "unknown"}`,
    `Last chat: ${status.title || status.conversationId || ""}`,
    `Messages: ${status.messageCount || ""}`,
    `Updated: ${status.at || ""}`,
    `Drive path: ${data.folderName || "ChatGPT Sync"}/conversations`,
  ].join("\n");
}

function renderLogs(logs) {
  logsEl.textContent = logs
    .slice(0, 50)
    .map((log) => {
      const details = log.details || {};
      const detail = details.title || details.name || details.message || details.conversationId || "";
      return `${log.at}  ${log.type}${detail ? `  ${detail}` : ""}`;
    })
    .join("\n");
}

saveFolderButton.addEventListener("click", async () => {
  const folderName = folderNameInput.value.trim() || "ChatGPT Sync";
  const all = await chrome.storage.local.get(null);
  const resetKeys = Object.keys(all).filter((key) => key.startsWith("driveFile:"));
  resetKeys.push("driveFolderId", "conversationsFolderId", "indexFileId", "index");
  await chrome.storage.local.remove(resetKeys);
  await chrome.storage.local.set({
    folderName,
  });
  await load();
});

connectButton.addEventListener("click", async () => {
  statusEl.textContent = "Connecting...";
  chrome.runtime.sendMessage({ type: "CONNECT_GOOGLE_DRIVE" }, async (response) => {
    if (!response || !response.ok) {
      statusEl.textContent = response && response.error ? response.error : "Connection failed.";
      return;
    }
    await load();
  });
});

clearLogsButton.addEventListener("click", async () => {
  await chrome.storage.local.set({ logs: [] });
  await load();
});

copyLogsButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(latestData || {}, null, 2));
  logsEl.textContent = "Copied diagnostics.";
});

load();
