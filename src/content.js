(function chatGptDriveSyncContent() {
  const CONTENT_VERSION = "0.1.3";
  if (window.__chatGptDriveSyncContentInstalled === CONTENT_VERSION) return;
  window.__chatGptDriveSyncContentInstalled = CONTENT_VERSION;

  const INJECTED_SRC = chrome.runtime.getURL("src/injected.js");
  const SYNC_DEBOUNCE_MS = 1500;
  const pendingFetches = new Map();
  let lastConversationId = null;
  let urlTimer = null;

  function injectProbe() {
    const script = document.createElement("script");
    script.src = INJECTED_SRC;
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  function getConversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function sendSync(conversationId, reason) {
    if (!conversationId) return;
    chrome.runtime.sendMessage({
      type: "SYNC_CONVERSATION",
      conversationId,
      reason,
      url: location.href,
    });
  }

  function fetchConversationFromPage(conversationId) {
    const requestId = crypto.randomUUID();

    window.postMessage(
      {
        source: "chatgpt-drive-sync-content",
        type: "FETCH_CONVERSATION_V2",
        payload: {
          requestId,
          conversationId,
        },
      },
      "*",
    );

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingFetches.delete(requestId);
        reject(new Error("Timed out waiting for ChatGPT conversation fetch."));
      }, 30000);

      pendingFetches.set(requestId, {
        resolve,
        reject,
        timeoutId,
      });
    });
  }

  function checkUrl(reason) {
    const conversationId = getConversationIdFromUrl();
    if (!conversationId || conversationId === lastConversationId) return;
    lastConversationId = conversationId;
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => sendSync(conversationId, reason), SYNC_DEBOUNCE_MS);
  }

  function installHistoryHooks() {
    const notify = () => setTimeout(() => checkUrl("url-change"), 100);
    const pushState = history.pushState;
    const replaceState = history.replaceState;

    history.pushState = function patchedPushState() {
      const result = pushState.apply(this, arguments);
      notify();
      return result;
    };

    history.replaceState = function patchedReplaceState() {
      const result = replaceState.apply(this, arguments);
      notify();
      return result;
    };

    window.addEventListener("popstate", notify);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "chatgpt-drive-sync") return;

    const payload = data.payload || {};
    if (data.type === "CHATGPT_STREAM_COMPLETE") {
      sendSync(payload.conversationId || getConversationIdFromUrl(), payload.reason || "stream-complete");
    }

    if (data.type === "CHATGPT_STREAM_CLOSED") {
      sendSync(payload.conversationId || getConversationIdFromUrl(), payload.reason || "stream-closed");
    }

    if (data.type === "FETCH_CONVERSATION_RESULT") {
      const pending = pendingFetches.get(payload.requestId);
      if (!pending) return;

      clearTimeout(pending.timeoutId);
      pendingFetches.delete(payload.requestId);

      if (payload.error) {
        pending.reject(new Error(payload.error));
      } else if (!payload.conversation || payload.conversation.conversation_id !== payload.conversationId) {
        pending.reject(new Error("Conversation response id mismatch."));
      } else {
        pending.resolve(payload.conversation);
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "SHOW_SYNC_TOAST") {
      showToast(message.message || "Synced");
      sendResponse({ ok: true });
      return false;
    }

    if (!message || message.type !== "FETCH_CONVERSATION_FROM_PAGE_V2") return false;
    if (!isValidConversationId(message.conversationId)) {
      sendResponse({ ok: false, error: "Invalid conversation id." });
      return false;
    }

    fetchConversationFromPage(message.conversationId)
      .then((conversation) => sendResponse({ ok: true, conversation }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));

    return true;
  });

  function showToast(message) {
    const existing = document.getElementById("chatgpt-drive-sync-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "chatgpt-drive-sync-toast";
    const icon = document.createElement("div");
    const content = document.createElement("div");
    const title = document.createElement("div");
    const subtitle = document.createElement("div");

    icon.textContent = "S";
    title.textContent = message;
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
      setTimeout(() => toast.remove(), 160);
    }, 1200);
  }

  function isValidConversationId(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
  }

  injectProbe();
  installHistoryHooks();
  checkUrl("initial-open");
})();
