(function installChatGptDriveSyncProbe() {
  const PROBE_VERSION = "0.1.3";
  if (window.__chatGptDriveSyncProbeInstalled === PROBE_VERSION) return;
  window.__chatGptDriveSyncProbeInstalled = PROBE_VERSION;

  const CONVERSATION_API_RE = /\/backend-api\/(?:f\/)?conversation(?:\/|$)/;
  const latestHeaders = {};
  const REPLAY_HEADER_NAMES = new Set([
    "authorization",
    "oai-client-build-number",
    "oai-client-version",
    "oai-device-id",
    "oai-language",
    "oai-session-id",
    "x-oai-is",
  ]);

  function getConversationIdFromLocation() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function getUrl(value) {
    if (typeof value === "string") return value;
    if (value && typeof value.url === "string") return value.url;
    return "";
  }

  function captureReplayHeaders(input, init) {
    for (const [name, value] of readHeaders(input && input.headers)) {
      saveReplayHeader(name, value);
    }

    for (const [name, value] of readHeaders(init && init.headers)) {
      saveReplayHeader(name, value);
    }
  }

  function readHeaders(headers) {
    if (!headers) return [];

    try {
      if (headers instanceof Headers) return Array.from(headers.entries());
      if (Array.isArray(headers)) return headers;
      if (typeof headers === "object") return Object.entries(headers);
    } catch (error) {
      return [];
    }

    return [];
  }

  function saveReplayHeader(name, value) {
    const lowerName = String(name || "").toLowerCase();
    if (!REPLAY_HEADER_NAMES.has(lowerName)) return;
    if (!value) return;
    latestHeaders[lowerName] = String(value);
  }

  function buildConversationHeaders(path) {
    const headers = {
      accept: "application/json",
      ...latestHeaders,
      "x-openai-target-path": path,
      "x-openai-target-route": path.includes("/backend-api/f/conversation/")
        ? "/backend-api/f/conversation/{conversation_id}"
        : "/backend-api/conversation/{conversation_id}",
    };

    return headers;
  }

  function post(type, payload) {
    window.postMessage(
      {
        source: "chatgpt-drive-sync",
        type,
        payload: payload || {},
      },
      "*",
    );
  }

  function maybeExtractConversationId(text) {
    if (!text) return null;
    const match = text.match(/"conversation_id"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  }

  function inspectStreamChunk(text, state) {
    if (!text) return;

    const conversationId = maybeExtractConversationId(text);
    if (conversationId) state.conversationId = conversationId;

    if (
      text.includes('"type":"message_stream_complete"') ||
      text.includes("\"type\": \"message_stream_complete\"") ||
      text.includes("message_stream_complete")
    ) {
      state.completed = true;
      post("CHATGPT_STREAM_COMPLETE", {
        conversationId: state.conversationId || getConversationIdFromLocation(),
        reason: "message_stream_complete",
        at: Date.now(),
      });
    }

    if (text.includes("[DONE]")) {
      state.completed = true;
      post("CHATGPT_STREAM_COMPLETE", {
        conversationId: state.conversationId || getConversationIdFromLocation(),
        reason: "done",
        at: Date.now(),
      });
    }
  }

  async function monitorResponse(response, requestUrl) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") || !response.body) return;

    const state = {
      conversationId: getConversationIdFromLocation(),
      completed: false,
    };

    post("CHATGPT_STREAM_STARTED", {
      conversationId: state.conversationId,
      url: requestUrl,
      at: Date.now(),
    });

    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        inspectStreamChunk(decoder.decode(value, { stream: true }), state);
      }

      const tail = decoder.decode();
      inspectStreamChunk(tail, state);

      if (!state.completed) {
        post("CHATGPT_STREAM_CLOSED", {
          conversationId: state.conversationId || getConversationIdFromLocation(),
          reason: "closed",
          at: Date.now(),
        });
      }
    } catch (error) {
      post("CHATGPT_STREAM_ERROR", {
        conversationId: state.conversationId || getConversationIdFromLocation(),
        message: String(error && error.message ? error.message : error),
        at: Date.now(),
      });
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function chatGptDriveSyncFetch(input, init) {
    const response = await originalFetch.apply(this, arguments);
    const url = getUrl(input);

    if (CONVERSATION_API_RE.test(url)) {
      captureReplayHeaders(input, init);
      post("CHATGPT_CONVERSATION_API", {
        conversationId: getConversationIdFromLocation(),
        url,
        method: (init && init.method) || (input && input.method) || "GET",
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        at: Date.now(),
      });

      monitorResponse(response, url);
    }

    return response;
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "chatgpt-drive-sync-content" || data.type !== "FETCH_CONVERSATION_V2") return;

    const { requestId, conversationId } = data.payload || {};
    if (!requestId || !conversationId) return;

    try {
      post("FETCH_CONVERSATION_RESULT", {
        requestId,
        conversationId,
        conversation: await fetchConversationSnapshot(conversationId),
      });
    } catch (error) {
      post("FETCH_CONVERSATION_RESULT", {
        requestId,
        conversationId,
        error: String(error && error.message ? error.message : error),
      });
    }
  });

  async function fetchConversationSnapshot(conversationId) {
    const encoded = encodeURIComponent(conversationId);
    const paths = [
      `/backend-api/conversation/${encoded}`,
      `/backend-api/f/conversation/${encoded}`,
    ];
    const failures = [];

    for (const path of paths) {
      const response = await originalFetch(path, {
        credentials: "include",
        headers: buildConversationHeaders(path),
      });

      if (response.ok) {
        return response.json();
      }

      failures.push(`${path} -> ${response.status}`);
    }

    const headerState = latestHeaders.authorization ? "auth-header-captured" : "no-auth-header-captured";
    throw new Error(`ChatGPT conversation fetch failed: ${failures.join("; ")}; ${headerState}`);
  }

  post("CHATGPT_PROBE_READY", {
    conversationId: getConversationIdFromLocation(),
    at: Date.now(),
  });
})();
