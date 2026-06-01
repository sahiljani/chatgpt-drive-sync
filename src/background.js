const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DEFAULT_FOLDER_NAME = "ChatGPT Sync";
const CONVERSATIONS_FOLDER_NAME = "conversations";
const SYNC_DELAY_MS = 3000;
const timers = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "SYNC_CONVERSATION") return false;
  if (!isTrustedChatGptSender(sender) || !isValidConversationId(message.conversationId)) {
    sendResponse({ ok: false, error: "Rejected untrusted or invalid sync request." });
    return true;
  }

  logEvent("sync-requested", {
    conversationId: message.conversationId,
    reason: message.reason || "unknown",
    tabId: sender.tab && sender.tab.id,
  });

  scheduleSync({
    conversationId: message.conversationId,
    reason: message.reason || "unknown",
    tabId: sender.tab && sender.tab.id,
    url: message.url,
  });

  sendResponse({ ok: true });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["driveFolderId", "conversationsFolderId"]).then((stored) => {
    if (stored.driveFolderId && stored.conversationsFolderId) {
      setStatus({
        state: "connected",
        message: "Google Drive connected.",
        at: new Date().toISOString(),
      });
      logEvent("installed", { message: "Extension reloaded; existing Drive connection found." });
      return;
    }

    setStatus({ state: "installed", message: "Ready to connect Google Drive." });
    logEvent("installed", { message: "Extension installed." });
  });
});

async function scheduleSync(job) {
  if (!job.conversationId) return;
  clearTimeout(timers.get(job.conversationId));
  timers.set(
    job.conversationId,
    setTimeout(() => {
      timers.delete(job.conversationId);
      syncConversation(job).catch((error) => {
        console.error("ChatGPT Drive Sync failed", error);
        logEvent("sync-error", {
          conversationId: job.conversationId,
          reason: job.reason,
          message: String(error && error.message ? error.message : error),
        });
        setStatus({
          state: "error",
          conversationId: job.conversationId,
          message: String(error && error.message ? error.message : error),
          at: new Date().toISOString(),
        });
      });
    }, SYNC_DELAY_MS),
  );
}

async function syncConversation(job) {
  await logEvent("sync-started", {
    conversationId: job.conversationId,
    reason: job.reason,
    tabId: job.tabId,
  });

  await setStatus({
    state: "syncing",
    conversationId: job.conversationId,
    reason: job.reason,
    at: new Date().toISOString(),
  });

  const conversation = await fetchConversation(job);
  const normalized = normalizeConversation(conversation);
  const json = JSON.stringify(normalized, null, 2);
  const token = await getAuthToken(false);
  const folders = await ensureDriveFolders(token);
  const jsonFileName = `${sanitizeDriveFileName(normalized.title)}.json`;

  await upsertConversationFile({
    token,
    conversationId: normalized.conversation_id,
    name: jsonFileName,
    extension: "json",
    mimeType: "application/json",
    content: json,
    parentId: folders.conversationsFolderId,
  });

  await updateIndexFile(token, folders.rootFolderId, normalized);

  await setStatus({
    state: "synced",
    conversationId: normalized.conversation_id,
    title: normalized.title,
    messageCount: normalized.messages.length,
    at: new Date().toISOString(),
  });

  await logEvent("sync-complete", {
    conversationId: normalized.conversation_id,
    title: normalized.title,
    messageCount: normalized.messages.length,
  });

  if (job.tabId) {
    try {
      await chrome.tabs.sendMessage(job.tabId, {
        type: "SHOW_SYNC_TOAST",
        state: "synced",
        message: "Synced",
      });
      await logEvent("toast-sent", { tabId: job.tabId, method: "content-script" });
    } catch (error) {
      await logEvent("toast-content-script-failed", {
        tabId: job.tabId,
        message: String(error && error.message ? error.message : error),
      });
      await showToastByInjection(job.tabId, "Synced");
    }
  }

}

async function fetchConversation(job) {
  if (!isValidConversationId(job.conversationId)) {
    throw new Error("Invalid conversation id.");
  }

  if (job.tabId) {
    try {
      await logEvent("conversation-fetch-page", {
        conversationId: job.conversationId,
        tabId: job.tabId,
      });
      const response = await fetchConversationFromTab(job.tabId, job.conversationId);

      if (response && response.ok && response.conversation) {
        return validateFetchedConversation(response.conversation, job.conversationId);
      }

      if (response && response.error) {
        throw new Error(response.error);
      }
    } catch (error) {
      console.warn("Page-context fetch failed, trying injection retry", error);
      await logEvent("conversation-fetch-page-failed", {
        conversationId: job.conversationId,
        message: String(error && error.message ? error.message : error),
      });

      try {
        await ensureContentScript(job.tabId);
        await logEvent("conversation-fetch-page-retry", {
          conversationId: job.conversationId,
          tabId: job.tabId,
        });

        const response = await fetchConversationFromTab(job.tabId, job.conversationId);
        if (response && response.ok && response.conversation) {
          return validateFetchedConversation(response.conversation, job.conversationId);
        }

        if (response && response.error) {
          throw new Error(response.error);
        }
      } catch (retryError) {
        await logEvent("conversation-fetch-page-retry-failed", {
          conversationId: job.conversationId,
          message: String(retryError && retryError.message ? retryError.message : retryError),
        });
        throw retryError;
      }
    }
  }

  throw new Error("Could not fetch ChatGPT conversation from the page. Reload the ChatGPT tab and try again.");
}

async function fetchConversationFromTab(tabId, conversationId) {
  return chrome.tabs.sendMessage(tabId, {
    type: "FETCH_CONVERSATION_FROM_PAGE_V2",
    conversationId,
  });
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content.js"],
  });
}

async function showToastByInjection(tabId, message) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (toastMessage) => {
      const existing = document.getElementById("chatgpt-drive-sync-toast");
      if (existing) existing.remove();

      const toast = document.createElement("div");
      toast.id = "chatgpt-drive-sync-toast";
      const icon = document.createElement("div");
      const content = document.createElement("div");
      const title = document.createElement("div");
      const subtitle = document.createElement("div");

      icon.textContent = "S";
      title.textContent = toastMessage;
      subtitle.textContent = "Synced to Google Drive";

      toast.append(icon, content);
      content.append(title, subtitle);

      Object.assign(toast.style, {
        position: "fixed",
        right: "22px",
        top: "68px",
        zIndex: "2147483647",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        minWidth: "310px",
        maxWidth: "420px",
        padding: "14px 16px",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        borderRadius: "18px",
        background: "rgba(32, 32, 32, 0.96)",
        color: "#fff",
        fontFamily: "Arial, sans-serif",
        boxShadow: "0 10px 34px rgba(0, 0, 0, 0.34)",
        opacity: "0",
        transform: "translateY(-8px)",
        transition: "opacity 140ms ease, transform 140ms ease",
        pointerEvents: "none",
      });
      Object.assign(icon.style, {
        width: "28px",
        height: "28px",
        flex: "0 0 28px",
        borderRadius: "7px",
        display: "grid",
        placeItems: "center",
        background: "#0f9d58",
        color: "#fff",
        fontSize: "15px",
        fontWeight: "700",
      });
      Object.assign(title.style, {
        maxWidth: "350px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: "14px",
        fontWeight: "700",
        lineHeight: "18px",
      });
      Object.assign(subtitle.style, {
        maxWidth: "350px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        marginTop: "2px",
        color: "rgba(255, 255, 255, 0.72)",
        fontSize: "13px",
        lineHeight: "17px",
      });

      document.documentElement.appendChild(toast);
      requestAnimationFrame(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
      });

      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-6px)";
        setTimeout(() => toast.remove(), 180);
      }, 1200);
    },
    args: [message],
  });
  await logEvent("toast-sent", { tabId, method: "scripting" });
}

function normalizeConversation(raw) {
  if (!raw || !raw.conversation_id || !raw.mapping || !raw.current_node) {
    throw new Error("ChatGPT conversation response is missing required fields.");
  }

  const mapping = raw.mapping || {};
  const currentNode = raw.current_node;
  const path = [];
  let nodeId = currentNode;
  const visited = new Set();

  while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
    visited.add(nodeId);
    path.push(nodeId);
    nodeId = mapping[nodeId].parent;
  }

  path.reverse();

  const messages = path
    .map((id) => normalizeMessageNode(id, mapping[id]))
    .filter(Boolean);

  return {
    conversation_id: raw.conversation_id,
    title: raw.title || "Untitled ChatGPT conversation",
    url: raw.conversation_id ? `https://chatgpt.com/c/${raw.conversation_id}` : "",
    create_time: raw.create_time || null,
    update_time: raw.update_time || null,
    current_node: raw.current_node || null,
    synced_at: new Date().toISOString(),
    messages,
  };
}

function validateFetchedConversation(conversation, expectedConversationId) {
  if (!conversation || conversation.conversation_id !== expectedConversationId) {
    throw new Error("Fetched conversation id did not match requested conversation id.");
  }

  return conversation;
}

function normalizeMessageNode(nodeId, node) {
  const message = node && node.message;
  if (!message) return null;

  const role = message.author && message.author.role;
  if (role !== "user" && role !== "assistant") return null;

  const content = message.content || {};
  if (content.content_type !== "text" && content.content_type !== "multimodal_text") return null;

  const text = extractText(content);
  if (!text.trim()) return null;

  return {
    id: message.id || nodeId,
    node_id: nodeId,
    role,
    create_time: message.create_time || null,
    update_time: message.update_time || null,
    status: message.status || null,
    text,
  };
}

function extractText(content) {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function toIso(epochSeconds) {
  if (!epochSeconds) return "";
  return new Date(epochSeconds * 1000).toISOString();
}

async function getAuthToken(interactive) {
  await logEvent("auth-token-request", { interactive });
  const result = await chrome.identity.getAuthToken({
    interactive,
    scopes: [DRIVE_SCOPE],
  });
  const token = typeof result === "string" ? result : result && result.token;

  if (!token) {
    throw new Error("Google Drive is not connected. Open extension options and connect first.");
  }

  await logEvent("auth-token-ok", { interactive });
  return token;
}

async function ensureDriveFolders(token) {
  const stored = await chrome.storage.local.get(["driveFolderId", "conversationsFolderId", "folderName"]);
  if (stored.driveFolderId && stored.conversationsFolderId) {
    return {
      rootFolderId: stored.driveFolderId,
      conversationsFolderId: stored.conversationsFolderId,
    };
  }

  const folderName = stored.folderName || DEFAULT_FOLDER_NAME;
  const rootFolderId = await findOrCreateFolder(token, folderName, "root");
  const conversationsFolderId = await findOrCreateFolder(token, CONVERSATIONS_FOLDER_NAME, rootFolderId);

  await chrome.storage.local.set({
    driveFolderId: rootFolderId,
    conversationsFolderId,
    folderName,
  });

  await logEvent("drive-folders-ready", {
    rootFolderId,
    conversationsFolderId,
    folderName,
  });

  return { rootFolderId, conversationsFolderId };
}

async function findOrCreateFolder(token, name, parentId) {
  const existing = await findDriveFile(token, {
    name,
    parentId,
    mimeType: "application/vnd.google-apps.folder",
  });

  if (existing) return existing.id;

  await logEvent("drive-folder-create", { name, parentId });
  const response = await driveFetch(token, `${DRIVE_API}/files?fields=id,name`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });

  return response.id;
}

async function upsertConversationFile({ token, conversationId, name, extension, mimeType, content, parentId }) {
  const key = `driveFile:${conversationId}:${extension}`;
  const stored = await chrome.storage.local.get(key);
  let fileId = stored[key];

  if (!fileId) {
    const existing = await findDriveFile(token, { name, parentId });
    fileId = existing && existing.id;
  }

  if (fileId) {
    await logEvent("drive-file-update", { name, fileId });
    await updateDriveFileContent(token, fileId, mimeType, content);
    await renameDriveFile(token, fileId, name);
  } else {
    await logEvent("drive-file-create", { name, parentId });
    const created = await createDriveFile(token, {
      name,
      parentId,
      mimeType,
      content,
    });
    fileId = created.id;
  }

  await chrome.storage.local.set({ [key]: fileId });
  return fileId;
}

async function renameDriveFile(token, fileId, name) {
  return driveFetch(token, `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
}

function sanitizeDriveFileName(value) {
  const cleaned = String(value || "Untitled ChatGPT conversation")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

  return cleaned || "Untitled ChatGPT conversation";
}

async function updateIndexFile(token, parentId, conversation) {
  const stored = await chrome.storage.local.get(["indexFileId", "index"]);
  const index = stored.index || { conversations: {} };
  index.updated_at = new Date().toISOString();
  index.conversations[conversation.conversation_id] = {
    conversation_id: conversation.conversation_id,
    title: conversation.title,
    url: conversation.url,
    create_time: conversation.create_time,
    update_time: conversation.update_time,
    synced_at: conversation.synced_at,
    message_count: conversation.messages.length,
  };

  const content = JSON.stringify(index, null, 2);
  let fileId = stored.indexFileId;
  if (!fileId) {
    const existing = await findDriveFile(token, { name: "index.json", parentId });
    fileId = existing && existing.id;
  }

  if (fileId) {
    await logEvent("drive-index-update", { fileId });
    await updateDriveFileContent(token, fileId, "application/json", content);
  } else {
    await logEvent("drive-index-create", { parentId });
    const created = await createDriveFile(token, {
      name: "index.json",
      parentId,
      mimeType: "application/json",
      content,
    });
    fileId = created.id;
  }

  await chrome.storage.local.set({ indexFileId: fileId, index });
}

async function createDriveFile(token, { name, parentId, mimeType, content }) {
  const boundary = `chatgpt-drive-sync-${crypto.randomUUID()}`;
  const metadata = {
    name,
    parents: [parentId],
    mimeType,
  };

  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}; charset=UTF-8`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return driveFetch(token, `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
}

async function updateDriveFileContent(token, fileId, mimeType, content) {
  return driveFetch(token, `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name`, {
    method: "PATCH",
    headers: {
      "Content-Type": `${mimeType}; charset=UTF-8`,
    },
    body: content,
  });
}

async function findDriveFile(token, { name, parentId, mimeType }) {
  const clauses = [
    `name = '${escapeDriveQueryString(name)}'`,
    `'${escapeDriveQueryString(parentId)}' in parents`,
    "trashed = false",
  ];

  if (mimeType) {
    clauses.push(`mimeType = '${escapeDriveQueryString(mimeType)}'`);
  }

  const params = new URLSearchParams({
    q: clauses.join(" and "),
    fields: "files(id,name,mimeType)",
    spaces: "drive",
    pageSize: "1",
  });

  const result = await driveFetch(token, `${DRIVE_API}/files?${params.toString()}`);
  return result.files && result.files[0] ? result.files[0] : null;
}

function escapeDriveQueryString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token });
    throw new Error("Google token expired. Reconnect Google Drive from extension options.");
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(payload.error && payload.error.message ? payload.error.message : `Drive API failed: ${response.status}`);
  }

  return payload;
}

async function setStatus(status) {
  await chrome.storage.local.set({ status });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "CONNECT_GOOGLE_DRIVE") return false;

  connectGoogleDrive()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "GET_DIAGNOSTICS") return false;

  chrome.storage.local
    .get(["status", "logs", "folderName", "driveFolderId", "conversationsFolderId"])
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "CLEAR_LOGS") return false;

  chrome.storage.local
    .set({ logs: [] })
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "MANUAL_SYNC_ACTIVE_TAB") return false;

  manualSyncActiveTab()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "CHECK_DRIVE_CONTENTS") return false;

  checkDriveContents()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));

  return true;
});

async function connectGoogleDrive() {
  const token = await getAuthToken(true);
  const folders = await ensureDriveFolders(token);
  await setStatus({
    state: "connected",
    message: "Google Drive connected.",
    at: new Date().toISOString(),
  });
  await logEvent("drive-connected", folders);
  return folders;
}

async function manualSyncActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) {
    throw new Error("No active tab found.");
  }

  const match = tab.url.match(/^https:\/\/chatgpt\.com\/c\/([^/?#]+)/);
  if (!match) {
    throw new Error("Open a ChatGPT conversation tab first.");
  }

  const conversationId = decodeURIComponent(match[1]);
  if (!isValidConversationId(conversationId)) {
    throw new Error("Invalid ChatGPT conversation URL.");
  }

  await logEvent("manual-sync-requested", { conversationId, tabId: tab.id });
  await scheduleSync({
    conversationId,
    reason: "manual-popup",
    tabId: tab.id,
    url: tab.url,
  });

  return { conversationId };
}

async function checkDriveContents() {
  const token = await getAuthToken(false);
  const folders = await ensureDriveFolders(token);
  const rootFiles = await listDriveChildren(token, folders.rootFolderId);
  const conversationFiles = await listDriveChildren(token, folders.conversationsFolderId);
  const result = {
    rootFolderId: folders.rootFolderId,
    conversationsFolderId: folders.conversationsFolderId,
    rootFiles,
    conversationFiles,
  };

  await logEvent("drive-contents", result);
  return result;
}

async function listDriveChildren(token, parentId) {
  const params = new URLSearchParams({
    q: `'${escapeDriveQueryString(parentId)}' in parents and trashed = false`,
    fields: "files(id,name,mimeType,modifiedTime)",
    spaces: "drive",
    pageSize: "100",
  });

  const result = await driveFetch(token, `${DRIVE_API}/files?${params.toString()}`);
  return result.files || [];
}

async function logEvent(type, details = {}) {
  try {
    const current = await chrome.storage.local.get(["logs"]);
    const logs = Array.isArray(current.logs) ? current.logs : [];
    logs.unshift({
      type,
      details: sanitizeLogDetails(details),
      at: new Date().toISOString(),
    });
    await chrome.storage.local.set({ logs: logs.slice(0, 80) });
  } catch (error) {
    console.warn("Failed to write diagnostic log", error);
  }
}

function isTrustedChatGptSender(sender) {
  const url = sender && sender.tab && sender.tab.url;
  return typeof url === "string" && /^https:\/\/chatgpt\.com(\/|$)/.test(url);
}

function isValidConversationId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function sanitizeLogDetails(value) {
  const sensitiveKeys = new Set(["authorization", "cookie", "token", "access_token", "refresh_token", "stack"]);

  if (Array.isArray(value)) {
    return value.slice(0, 25).map(sanitizeLogDetails);
  }

  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKeys.has(key.toLowerCase())) {
        result[key] = "<redacted>";
      } else {
        result[key] = sanitizeLogDetails(item);
      }
    }
    return result;
  }

  if (typeof value === "string") {
    return value.length > 600 ? `${value.slice(0, 600)}...` : value;
  }

  return value;
}
