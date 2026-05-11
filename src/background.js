chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "TABLE_EXTRACT_DOWNLOAD") {
    chrome.downloads.download(
      {
        url: message.url,
        filename: message.filename || "table-extract.xlsx",
        saveAs: true
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }

        sendResponse({ ok: true, downloadId });
      }
    );

    return true;
  }

  if (message.type === "TABLE_EXTRACT_FETCH_PAGES") {
    fetchPages(message.payload)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "请求失败" }));

    return true;
  }

  if (message.type === "TABLE_EXTRACT_GET_TAB_URL") {
    sendResponse({ ok: true, url: sender.tab && sender.tab.url ? sender.tab.url : "" });
    return false;
  }

  if (message.type === "TABLE_EXTRACT_SAVE_CAPTURE") {
    saveCapture(message.pageUrl, message.capture)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "保存捕获失败" }));

    return true;
  }

  if (message.type === "TABLE_EXTRACT_START_WEBREQUEST_CAPTURE") {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab && sender.tab.id;

    if (tabId != null) {
      activeNetworkTabs.set(tabId, message.pageUrl || sender.tab && sender.tab.url || "");
    }

    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "TABLE_EXTRACT_GET_CAPTURES") {
    getCaptures(message.pageUrl)
      .then((captures) => sendResponse({ ok: true, captures }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "读取捕获失败" }));

    return true;
  }

  if (message.type === "TABLE_EXTRACT_CLEAR_CAPTURES") {
    clearCaptures(message.pageUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "清除捕获失败" }));

    return true;
  }

  return false;
});

const NETWORK_CAPTURE_LIMIT = 20;
const activeNetworkTabs = new Map();
const memoryCaptures = new Map();

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!activeNetworkTabs.has(details.tabId)) {
      return;
    }

    const pageUrl = activeNetworkTabs.get(details.tabId);
    const contentTypeHeader = (details.responseHeaders || []).find((header) => header.name.toLowerCase() === "content-type");
    const contentType = contentTypeHeader ? contentTypeHeader.value || "" : "";

    const capture = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      signature: `${details.method}:${details.url}:webRequest`,
      capturedAt: Date.now(),
      pageUrl,
      request: {
        method: details.method,
        url: details.url,
        headers: {},
        body: ""
      },
      rowPath: "",
      rowCount: 0,
      columns: [],
      preview: `webRequest 已看到请求，但不能读取响应体 · HTTP ${details.statusCode}${contentType ? ` · ${contentType}` : ""}`
    };

    rememberCapture(pageUrl, capture);
    saveCapture(pageUrl, capture).catch(() => {});
  },
  { urls: ["<all_urls>"], types: ["xmlhttprequest", "other"] },
  ["responseHeaders"]
);

async function saveCapture(pageUrl, capture) {
  rememberCapture(pageUrl, capture);
  assertStorageAvailable();
  const key = captureStorageKey(pageUrl);
  const stored = await chrome.storage.local.get(key);
  const captures = Array.isArray(stored[key]) ? stored[key] : [];
  const nextCaptures = [
    capture,
    ...captures.filter((item) => item.signature !== capture.signature)
  ].slice(0, NETWORK_CAPTURE_LIMIT);

  await chrome.storage.local.set({ [key]: nextCaptures });
}

async function getCaptures(pageUrl) {
  const memory = memoryCaptures.get(captureStorageKey(pageUrl)) || [];
  if (!chrome.storage || !chrome.storage.local) {
    return memory;
  }

  const key = captureStorageKey(pageUrl);
  const stored = await chrome.storage.local.get(key);
  const captures = Array.isArray(stored[key]) ? stored[key] : [];
  const merged = mergeCaptures(memory, captures);

  if (merged.length) {
    return merged;
  }

  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([entryKey, value]) => entryKey.startsWith("networkCaptures:") && Array.isArray(value))
    .flatMap(([, value]) => value)
    .concat(Array.from(memoryCaptures.values()).flat())
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, NETWORK_CAPTURE_LIMIT);
}

function rememberCapture(pageUrl, capture) {
  const key = captureStorageKey(pageUrl);
  const captures = memoryCaptures.get(key) || [];
  memoryCaptures.set(key, mergeCaptures([capture], captures).slice(0, NETWORK_CAPTURE_LIMIT));
}

function mergeCaptures(...groups) {
  const bySignature = new Map();

  for (const capture of groups.flat()) {
    if (!capture || !capture.signature) {
      continue;
    }

    bySignature.set(capture.signature, capture);
  }

  return Array.from(bySignature.values()).sort((a, b) => b.capturedAt - a.capturedAt);
}

function captureStorageKey(pageUrl) {
  return `networkCaptures:${pageUrl || ""}`;
}

async function clearCaptures(pageUrl) {
  const key = captureStorageKey(pageUrl);
  memoryCaptures.delete(key);

  if (chrome.storage && chrome.storage.local) {
    await chrome.storage.local.remove(key);
  }
}

function assertStorageAvailable() {
  if (!chrome.storage || !chrome.storage.local) {
    throw new Error("chrome.storage 不可用，请在 chrome://extensions/ 重新加载插件。");
  }
}

async function fetchPages(payload) {
  const rows = [];
  const errors = [];
  const startPage = Number(payload.startPage);
  const endPage = Number(payload.endPage);
  const pageStep = Number(payload.pageStep || 1);
  const pageValues = buildPageValues(startPage, endPage, pageStep);
  let completed = 0;

  sendFetchProgress(payload.requestId, {
    completed,
    total: pageValues.length,
    currentValue: pageValues[0],
    rows: rows.length,
    errors: errors.length,
    phase: "start"
  });

  for (const page of pageValues) {
    try {
      const request = buildPagedRequest(
        payload.requestTemplate || payload.capture.request,
        payload.pageParam,
        page
      );
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" ? undefined : request.body,
        credentials: "include"
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      const pageRows = payload.capture.rowPath ? getPathValue(json, payload.capture.rowPath) : findBestRows(json).items;

      if (Array.isArray(pageRows)) {
        rows.push(...pageRows);
      }
    } catch (error) {
      errors.push(`第 ${page} 页: ${error.message || "失败"}`);
    } finally {
      completed += 1;
      sendFetchProgress(payload.requestId, {
        completed,
        total: pageValues.length,
        currentValue: page,
        rows: rows.length,
        errors: errors.length,
        phase: completed === pageValues.length ? "done" : "fetching"
      });
    }
  }

  return { rows, errors };
}

function buildPageValues(startPage, endPage, pageStep) {
  const values = [];

  for (let page = startPage; page <= endPage; page += pageStep) {
    values.push(page);
  }

  return values;
}

function sendFetchProgress(requestId, progress) {
  if (!requestId) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "TABLE_EXTRACT_FETCH_PROGRESS",
    requestId,
    progress
  }).catch(() => {});
}

function buildPagedRequest(request, pageParam, page) {
  if (hasTemplateMarker(request)) {
    return applyRequestTemplate(request, page);
  }

  const method = String(request.method || "GET").toUpperCase();
  const headers = { ...(request.headers || {}) };

  if (method === "GET") {
    const url = new URL(request.url);
    url.searchParams.set(pageParam, String(page));
    return { method, url: url.href, headers, body: "" };
  }

  if (looksLikeFormBody(request.body || "")) {
    const params = new URLSearchParams(request.body || "");
    params.set(pageParam, String(page));
    return { method, url: request.url, headers, body: params.toString() };
  }

  const body = updateJsonBodyPageParam(request.body || "", pageParam, page);
  return { method, url: request.url, headers, body };
}

function hasTemplateMarker(value) {
  if (typeof value === "string") {
    return /\{\{\s*[^{}\s]+\s*\}\}/.test(value);
  }

  if (Array.isArray(value)) {
    return value.some(hasTemplateMarker);
  }

  if (value && typeof value === "object") {
    return Object.values(value).some(hasTemplateMarker);
  }

  return false;
}

function applyRequestTemplate(template, page) {
  const request = replaceTemplateMarker(template, String(page));
  const method = String(request.method || "GET").toUpperCase();
  const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body || "");

  return {
    method,
    url: request.url,
    headers: request.headers || {},
    body
  };
}

function replaceTemplateMarker(value, replacement) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*[^{}\s]+\s*\}\}/g, replacement);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceTemplateMarker(item, replacement));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replaceTemplateMarker(child, replacement)])
    );
  }

  return value;
}

function looksLikeFormBody(body) {
  if (!body) {
    return false;
  }

  try {
    JSON.parse(body);
    return false;
  } catch (error) {
    return body.includes("=");
  }
}

function updateJsonBodyPageParam(body, pageParam, page) {
  const json = JSON.parse(body || "{}");
  setNestedValue(json, pageParam, page);
  return JSON.stringify(json);
}

function setNestedValue(target, path, value) {
  const parts = path.split(".").filter(Boolean);
  let current = target;

  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }

    current = current[part];
  }

  current[parts[parts.length - 1]] = value;
}

function getPathValue(target, path) {
  if (!path || path === "$") {
    return target;
  }

  const tokens = path
    .replace(/^\$\./, "")
    .replace(/^\$/, "")
    .split(".")
    .filter(Boolean);
  let current = target;

  for (const token of tokens) {
    const match = token.match(/^(.+?)\[(\d+)\]$/);

    if (match) {
      current = current && current[match[1]];
      current = Array.isArray(current) ? current[Number(match[2])] : undefined;
    } else {
      current = current && current[token];
    }

    if (current == null) {
      return undefined;
    }
  }

  return current;
}

function findBestRows(value) {
  let best = { items: [] };

  if (Array.isArray(value)) {
    if (value.length && value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      best = { items: value };
    }

    for (const item of value) {
      const candidate = findBestRows(item);

      if (candidate.items.length > best.items.length) {
        best = candidate;
      }
    }

    return best;
  }

  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      const candidate = findBestRows(child);

      if (candidate.items.length > best.items.length) {
        best = candidate;
      }
    }
  }

  return best;
}
