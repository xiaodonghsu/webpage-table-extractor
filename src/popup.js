const scanButton = document.getElementById("scan-tables");
const tabButtons = Array.from(document.querySelectorAll(".tab-button"));
const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
const exportButton = document.getElementById("export-tables");
const smartSelectButton = document.getElementById("smart-select");
const selectAllButton = document.getElementById("select-all");
const selectNoneButton = document.getElementById("select-none");
const includeHiddenCheckbox = document.getElementById("include-hidden");
const startNetworkButton = document.getElementById("start-network");
const refreshCapturesButton = document.getElementById("refresh-captures");
const clearCapturesButton = document.getElementById("clear-captures");
const captureList = document.getElementById("capture-list");
const requestDetail = document.getElementById("request-detail");
const pageParamInput = document.getElementById("page-param");
const startPageInput = document.getElementById("start-page");
const endPageInput = document.getElementById("end-page");
const pageStepInput = document.getElementById("page-step");
const exportNetworkButton = document.getElementById("export-network");
const resultsPanel = document.getElementById("results");
const summaryText = document.getElementById("summary");
const tableList = document.getElementById("table-list");
const statusText = document.getElementById("status");

let activeTabId = null;
let activePageUrl = "";
let tables = [];
let captures = [];
let activeNetworkRequestId = "";

initTabs();
scanButton.addEventListener("click", scanTables);
smartSelectButton.addEventListener("click", smartSelectTables);
selectAllButton.addEventListener("click", () => setAllChecked(true));
selectNoneButton.addEventListener("click", () => setAllChecked(false));
exportButton.addEventListener("click", exportSelectedTables);
startNetworkButton.addEventListener("click", startNetworkCapture);
refreshCapturesButton.addEventListener("click", loadCaptures);
clearCapturesButton.addEventListener("click", clearCaptures);
captureList.addEventListener("change", updateCaptureSelection);
requestDetail.addEventListener("input", updateTemplateParamList);
exportNetworkButton.addEventListener("click", exportNetworkPages);
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "TABLE_EXTRACT_FETCH_PROGRESS" || message.requestId !== activeNetworkRequestId) {
    return;
  }

  updateNetworkProgress(message.progress);
});

async function initTabs() {
  let activeTab = "scan";

  try {
    const stored = await chrome.storage.local.get("activeTab");
    activeTab = stored.activeTab === "network" ? "network" : "scan";
  } catch (error) {
    activeTab = "scan";
  }

  setActiveTab(activeTab, false);

  for (const button of tabButtons) {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab, true));
  }
}

async function setActiveTab(tabName, persist) {
  for (const button of tabButtons) {
    button.classList.toggle("active", button.dataset.tab === tabName);
  }

  for (const panel of tabPanels) {
    panel.hidden = panel.dataset.panel !== tabName;
  }

  if (persist) {
    try {
      await chrome.storage.local.set({ activeTab: tabName });
    } catch (error) {
      // Tab persistence is a convenience; the extension still works without it.
    }
  }
}

async function scanTables() {
  scanButton.disabled = true;
  statusText.textContent = "正在扫描页面表格...";
  const includeHidden = includeHiddenCheckbox.checked;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      throw new Error("没有找到当前标签页");
    }

    activeTabId = tab.id;
    activePageUrl = tab.url || "";
    const frameIds = await ensureContentScripts(activeTabId);
    const responses = await Promise.all(
      frameIds.map(async (frameId) => {
        try {
          const response = await chrome.tabs.sendMessage(
            activeTabId,
            { type: "TABLE_EXTRACT_SCAN" },
            { frameId }
          );
          return { frameId, response };
        } catch (error) {
          return { frameId, response: null };
        }
      })
    );

    const scannedTables = responses
      .flatMap(({ frameId, response }) => {
        if (!response || !response.ok || !Array.isArray(response.tables)) {
          return [];
        }

        return response.tables.map((table, index) => ({
          ...table,
          uid: `${frameId}:${table.id}`,
          frameId,
          frameLabel: frameId === 0 ? "主页面" : `iframe ${frameId}`,
          order: index
        }));
      })
      .sort((a, b) => a.frameId - b.frameId || a.top - b.top || a.left - b.left || a.order - b.order);
    tables = includeHidden ? scannedTables : scannedTables.filter((table) => table.visible);

    renderTableList();
    statusText.textContent = tables.length
      ? "鼠标移到列表项可在页面中定位表格。"
      : includeHidden
        ? "没有扫描到可导出的表格。"
        : "没有扫描到可见的可导出表格。";
  } catch (error) {
    statusText.textContent = error.message || "扫描失败";
  } finally {
    scanButton.disabled = false;
  }
}

async function startNetworkCapture() {
  startNetworkButton.disabled = true;
  statusText.textContent = "正在启动网络监听...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      throw new Error("没有找到当前标签页");
    }

    activeTabId = tab.id;
    activePageUrl = tab.url || "";
    const frameIds = await ensureContentScripts(activeTabId);
    await chrome.runtime.sendMessage({
      type: "TABLE_EXTRACT_START_WEBREQUEST_CAPTURE",
      tabId: activeTabId,
      pageUrl: activePageUrl
    });
    await Promise.all(
      frameIds.map(async (frameId) => {
        try {
          await chrome.tabs.sendMessage(activeTabId, { type: "TABLE_EXTRACT_START_NETWORK_CAPTURE" }, { frameId });
        } catch (error) {
          // Browser-managed frames may reject extension messages.
        }
      })
    );
    statusText.textContent = "监听已启动，请在页面中连续点击两次分页，然后回到这里刷新捕获。";
  } catch (error) {
    statusText.textContent = error.message || "启动监听失败";
  } finally {
    startNetworkButton.disabled = false;
  }
}

async function loadCaptures() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab && tab.id;
    activePageUrl = (tab && tab.url) || activePageUrl;

    if (!activePageUrl) {
      throw new Error("没有找到当前页面地址");
    }

    const response = await chrome.runtime.sendMessage({
      type: "TABLE_EXTRACT_GET_CAPTURES",
      pageUrl: activePageUrl
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "读取捕获失败");
    }

    captures = Array.isArray(response.captures) ? response.captures : [];
    renderCaptures();
    statusText.textContent = captures.length ? `已捕获 ${captures.length} 个请求，已尝试自动推断分页参数。` : "暂无捕获请求。";
  } catch (error) {
    statusText.textContent = error.message || "读取捕获失败";
  }
}

async function clearCaptures() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activePageUrl = (tab && tab.url) || activePageUrl;

    if (!activePageUrl) {
      throw new Error("没有找到当前页面地址");
    }

    const response = await chrome.runtime.sendMessage({
      type: "TABLE_EXTRACT_CLEAR_CAPTURES",
      pageUrl: activePageUrl
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "清除捕获失败");
    }

    captures = [];
    renderCaptures();
    requestDetail.value = "";
    pageParamInput.value = "";
    statusText.textContent = "已清除当前页面的捕获记录。";
  } catch (error) {
    statusText.textContent = error.message || "清除捕获失败";
  }
}

function renderCaptures() {
  captureList.textContent = "";

  if (!captures.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无捕获请求";
    captureList.appendChild(option);
    exportNetworkButton.disabled = true;
    return;
  }

  for (const capture of captures) {
    const option = document.createElement("option");
    option.value = capture.id;
    option.textContent = `${capture.request.method} ${shortUrl(capture.request.url)} · ${capture.rowCount} 行 · ${capture.columns.length} 列${capture.rowPath ? "" : " · 诊断"}`;
    captureList.appendChild(option);
  }

  updateCaptureSelection();
}

function updateCaptureSelection() {
  const capture = getSelectedCapture();
  exportNetworkButton.disabled = !capture;
  requestDetail.value = capture ? formatRequestDetail(capture) : "";

  if (!capture) {
    return;
  }

  const inference = inferPagingConfig(capture);
  requestDetail.value = applyInferredTemplateMarker(requestDetail.value, inference);
  updateTemplateParamList();
  startPageInput.value = String(inference.start);
  endPageInput.value = String(inference.end);
  pageStepInput.value = String(inference.step);
}

function getSelectedCapture() {
  return captures.find((capture) => capture.id === captureList.value) || null;
}

function inferPagingConfig(capture) {
  const group = captures
    .filter((item) => sameRequestGroup(item, capture))
    .sort((a, b) => a.capturedAt - b.capturedAt);
  const index = group.findIndex((item) => item.id === capture.id);
  const previous = index > 0 ? group[index - 1] : group[group.length - 2];
  const current = capture;
  const defaultValue = {
    location: "auto",
    param: guessPageParam(capture) || "page",
    start: 1,
    end: 1,
    step: 1
  };

  if (!previous || previous.id === current.id) {
    return {
      ...defaultValue,
      param: guessPageParam(capture) || "para-value"
    };
  }

  const candidates = comparePagingCandidates(previous.request, current.request);
  const best = candidates[0];

  if (!best) {
    return {
      ...defaultValue,
      param: guessPageParam(capture) || "para-value"
    };
  }

  const step = Math.abs(best.to - best.from) || 1;
  const start = inferStartValue(best.param, best.from, step);

  return {
    location: best.location,
    param: best.param,
    start,
    end: Math.max(best.to, start),
    step
  };
}

function sameRequestGroup(left, right) {
  if (!left || !right || !left.request || !right.request) {
    return false;
  }

  const leftUrl = new URL(left.request.url);
  const rightUrl = new URL(right.request.url);
  return left.request.method === right.request.method && leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname && left.rowPath === right.rowPath;
}

function comparePagingCandidates(previous, current) {
  return [
    ...compareMaps("query", parseQuery(previous.url), parseQuery(current.url)),
    ...compareMaps("form", parseForm(previous.body), parseForm(current.body)),
    ...compareMaps("json", flattenJson(parseJson(previous.body)), flattenJson(parseJson(current.body)))
  ].sort((a, b) => scorePagingCandidate(b) - scorePagingCandidate(a));
}

function compareMaps(location, previous, current) {
  const result = [];
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);

  for (const key of keys) {
    const from = Number(previous[key]);
    const to = Number(current[key]);

    if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
      result.push({ location, param: key, from, to });
    }
  }

  return result;
}

function scorePagingCandidate(candidate) {
  const name = candidate.param.toLowerCase();
  let score = 0;

  if (["page", "pageno", "pagenum", "current", "currentpage", "pageindex"].includes(name)) {
    score += 5;
  }

  if (["start", "offset", "skip"].includes(name)) {
    score += 6;
  }

  if (candidate.to > candidate.from) {
    score += 2;
  }

  return score;
}

function inferStartValue(param, observedValue, step) {
  const name = param.toLowerCase();

  if (["start", "offset", "skip"].includes(name)) {
    return 0;
  }

  if (["page", "pageno", "pagenum", "current", "currentpage"].includes(name)) {
    return 1;
  }

  return Math.max(0, observedValue - step);
}

function parseQuery(url) {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

function parseForm(body) {
  if (!body) {
    return {};
  }

  try {
    JSON.parse(body);
    return {};
  } catch (error) {
    return Object.fromEntries(new URLSearchParams(body).entries());
  }
}

function parseJson(body) {
  try {
    return JSON.parse(body || "{}");
  } catch (error) {
    return {};
  }
}

function flattenJson(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((result, [key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    if (child && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(result, flattenJson(child, path));
    } else {
      result[path] = child;
    }

    return result;
  }, {});
}

function formatRequestDetail(capture) {
  const request = capture.request;
  return JSON.stringify(
    {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body
    },
    null,
    2
  );
}

function applyInferredTemplateMarker(requestText, inference) {
  if (!inference.param || requestText.includes("{{")) {
    return requestText;
  }

  try {
    const detail = JSON.parse(requestText);
    const request = markInferredParam(detail, inference);
    return JSON.stringify(request, null, 2);
  } catch (error) {
    return requestText;
  }
}

function markInferredParam(detail, inference) {
  const marker = `{{${inference.param}}}`;
  const request = { ...detail };

  if (inference.location === "query" && request.url) {
    const url = new URL(request.url);
    url.searchParams.set(inference.param, marker);
    request.url = url.href;
    return request;
  }

  if (inference.location === "form" && typeof request.body === "string") {
    request.body = replaceUrlEncodedParamValue(request.body, inference.param, marker);
    return request;
  }

  if (inference.location === "json" && typeof request.body === "string") {
    const json = JSON.parse(request.body || "{}");
    setNestedTemplateValue(json, inference.param, marker);
    request.body = JSON.stringify(json);
    return request;
  }

  return request;
}

function extractTemplateParamNames(text) {
  return [...new Set(Array.from(text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)).map((match) => match[1]))];
}

function replaceUrlEncodedParamValue(value, param, replacement) {
  const parts = String(value).split("&");
  let replaced = false;
  const nextParts = parts.map((part) => {
    const equalsIndex = part.indexOf("=");
    const rawKey = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));

    if (key !== param) {
      return part;
    }

    replaced = true;
    return `${rawKey}=${replacement}`;
  });

  if (!replaced) {
    nextParts.push(`${encodeURIComponent(param)}=${replacement}`);
  }

  return nextParts.join("&");
}

function updateTemplateParamList() {
  const names = extractTemplateParamNames(requestDetail.value);
  pageParamInput.value = names.join("\n");
  pageParamInput.style.height = `${Math.max(32, names.length * 18 + 12)}px`;
}

function setNestedTemplateValue(target, path, value) {
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

function readRequestTemplate() {
  const text = requestDetail.value.trim();

  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    return {
      method: parsed.method || "GET",
      url: parsed.url || "",
      headers: parsed.headers || {},
      body: parsed.body == null ? "" : parsed.body
    };
  } catch (error) {
    throw new Error("请求消息不是有效 JSON。");
  }
}

function guessPageParam(capture) {
  const request = capture.request;
  const candidates = ["page", "pageNo", "pageNum", "current", "currentPage", "pageIndex"];

  if (request.method === "GET") {
    const params = new URL(request.url).searchParams;
    return candidates.find((name) => params.has(name)) || "";
  }

  try {
    const json = JSON.parse(request.body || "{}");
    for (const name of candidates) {
      const path = findNestedKeyPath(json, name);

      if (path) {
        return path;
      }
    }

    return "";
  } catch (error) {
    const params = new URLSearchParams(request.body || "");
    return candidates.find((name) => params.has(name)) || "";
  }
}

function findNestedKeyPath(value, key, prefix = "") {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return prefix ? `${prefix}.${key}` : key;
  }

  for (const [childKey, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${childKey}` : childKey;
    const found = findNestedKeyPath(child, key, childPath);

    if (found) {
      return found;
    }
  }

  return "";
}

async function exportNetworkPages() {
  const capture = getSelectedCapture();

  if (!capture) {
    return;
  }

  const startPage = Number(startPageInput.value);
  const endPage = Number(endPageInput.value);
  const pageStep = Number(pageStepInput.value);
  const pageParam = pageParamInput.value.trim();

  if (!Number.isFinite(startPage) || !Number.isFinite(endPage) || !Number.isFinite(pageStep) || pageStep <= 0 || endPage < startPage) {
    statusText.textContent = "请填写有效的起止值和步长。";
    return;
  }

  exportNetworkButton.disabled = true;
  activeNetworkRequestId = `network-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  statusText.textContent = "正在拉取分页数据...";

  try {
    const requestTemplate = readRequestTemplate();
    const templateParams = extractTemplateParamNames(requestDetail.value);

    if (!templateParams.length) {
      statusText.textContent = "请在请求消息中使用 {{参数名}} 标记分页变化值。";
      return;
    }

    updateTemplateParamList();
    const response = await chrome.runtime.sendMessage({
      type: "TABLE_EXTRACT_FETCH_PAGES",
      payload: { capture, requestTemplate, pageParam, startPage, endPage, pageStep, requestId: activeNetworkRequestId }
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "分页请求失败");
    }

    const rows = jsonRowsToSheetRows(response.payload.rows, capture.columns);

    if (!rows.length) {
      throw new Error("没有提取到分页数据");
    }

    const buffer = window.TableExtractXlsx.create(rows);
    const dataUrl = await window.TableExtractXlsx.toDataUrl(buffer);
    const download = await chrome.runtime.sendMessage({
      type: "TABLE_EXTRACT_DOWNLOAD",
      filename: `network-table-${formatTimestamp(new Date())}.xlsx`,
      url: dataUrl
    });

    if (!download || !download.ok) {
      throw new Error((download && download.error) || "下载失败");
    }

    const errorText = response.payload.errors.length ? `，失败 ${response.payload.errors.length} 页` : "";
    statusText.textContent = `已导出 ${rows.length - 1} 行网络数据${errorText}。`;
  } catch (error) {
    statusText.textContent = error.message || "网络分页导出失败";
  } finally {
    activeNetworkRequestId = "";
    exportNetworkButton.disabled = !getSelectedCapture();
  }
}

function updateNetworkProgress(progress) {
  if (!progress) {
    return;
  }

  const total = progress.total || 0;
  const completed = progress.completed || 0;
  const current = progress.currentValue == null ? "-" : progress.currentValue;
  const rows = progress.rows || 0;
  const errors = progress.errors || 0;
  const suffix = errors ? `，失败 ${errors} 次` : "";

  if (progress.phase === "start") {
    statusText.textContent = `准备拉取 ${total} 次请求，当前值 ${current}。`;
    return;
  }

  statusText.textContent = `正在拉取 ${completed}/${total}，当前值 ${current}，已提取 ${rows} 行${suffix}。`;
}

async function ensureContentScripts(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId, allFrames: true },
    files: ["src/content.css"]
  });
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["src/content.js"]
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["src/network-hook.js"],
    world: "MAIN"
  });

  return [...new Set(injections.map((item) => item.frameId))];
}

function renderTableList() {
  tableList.textContent = "";
  resultsPanel.hidden = false;

  for (const table of tables) {
    const item = document.createElement("li");
    item.className = "table-item";
    item.dataset.uid = table.uid;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.uid = table.uid;

    const main = document.createElement("div");
    main.className = "table-item-main";

    const title = document.createElement("div");
    title.className = "table-item-title";
    title.textContent = `${table.type.toUpperCase()} · ${table.rowCount} 行 × ${table.columnCount} 列`;

    const meta = document.createElement("div");
    meta.className = "table-item-meta";
    meta.textContent = `${table.frameLabel}${table.visible ? "" : " · 当前不可见"}`;

    const preview = document.createElement("div");
    preview.className = "table-item-preview";
    preview.textContent = table.preview || "无预览文本";

    main.append(title, meta, preview);
    item.append(checkbox, main);
    item.addEventListener("mouseenter", () => highlightTable(table));
    item.addEventListener("mouseleave", () => clearHighlight(table.frameId));
    item.addEventListener("click", (event) => {
      if (event.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
      }

      updateSelectionState();
    });
    checkbox.addEventListener("change", updateSelectionState);
    tableList.appendChild(item);
  }

  updateSelectionState();
}

function setAllChecked(checked) {
  for (const checkbox of tableList.querySelectorAll("input[type='checkbox']")) {
    checkbox.checked = checked;
  }

  updateSelectionState();
}

function smartSelectTables() {
  if (!tables.length) {
    return;
  }

  const counts = new Map();

  for (const table of tables) {
    const key = tableShapeKey(table);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const maxCount = Math.max(...counts.values());
  const selectedKeys = new Set(
    Array.from(counts.entries())
      .filter((entry) => entry[1] === maxCount)
      .map((entry) => entry[0])
  );

  for (const checkbox of tableList.querySelectorAll("input[type='checkbox']")) {
    const table = tables.find((item) => item.uid === checkbox.dataset.uid);
    checkbox.checked = table ? selectedKeys.has(tableShapeKey(table)) : false;
  }

  updateSelectionState();
}

function tableShapeKey(table) {
  return `${table.rowCount}x${table.columnCount}`;
}

function updateSelectionState() {
  const selectedCount = getSelectedTables().length;
  summaryText.textContent = `扫描到 ${tables.length} 个，已选择 ${selectedCount} 个`;
  exportButton.disabled = selectedCount === 0;
}

function getSelectedTables() {
  const checkedIds = new Set(
    Array.from(tableList.querySelectorAll("input[type='checkbox']:checked")).map((checkbox) => checkbox.dataset.uid)
  );

  return tables.filter((table) => checkedIds.has(table.uid));
}

async function highlightTable(table) {
  if (!activeTabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(
      activeTabId,
      { type: "TABLE_EXTRACT_HIGHLIGHT", tableId: table.id },
      { frameId: table.frameId }
    );
  } catch (error) {
    statusText.textContent = "当前表格无法在页面中定位。";
  }
}

async function clearHighlight(frameId) {
  if (!activeTabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeTabId, { type: "TABLE_EXTRACT_CLEAR_HIGHLIGHT" }, { frameId });
  } catch (error) {
    // Some browser-managed frames cannot receive extension messages.
  }
}

async function exportSelectedTables() {
  const selectedTables = getSelectedTables();

  if (!selectedTables.length) {
    return;
  }

  exportButton.disabled = true;
  statusText.textContent = "正在生成 XLSX...";

  try {
    const rows = mergeTables(selectedTables);
    const buffer = window.TableExtractXlsx.create(rows);
    const dataUrl = await window.TableExtractXlsx.toDataUrl(buffer);
    const response = await chrome.runtime.sendMessage({
      type: "TABLE_EXTRACT_DOWNLOAD",
      filename: `table-extract-${formatTimestamp(new Date())}.xlsx`,
      url: dataUrl
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "下载失败");
    }

    statusText.textContent = `已导出 ${selectedTables.length} 个表格，共 ${rows.length} 行。`;
  } catch (error) {
    statusText.textContent = error.message || "导出失败";
  } finally {
    exportButton.disabled = getSelectedTables().length === 0;
  }
}

function mergeTables(selectedTables) {
  const rows = selectedTables.flatMap((table) => table.rows);
  const maxColumns = Math.max(0, ...rows.map((row) => row.length));

  return rows.map((row) => {
    const next = row.slice(0, maxColumns);

    while (next.length < maxColumns) {
      next.push("");
    }

    return next;
  });
}

function jsonRowsToSheetRows(items, baseColumns) {
  const columns = [...baseColumns];
  const seen = new Set(columns);

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  const rows = [columns];

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    rows.push(columns.map((column) => formatCellValue(item[column])));
  }

  return rows;
}

function formatCellValue(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}`;
    return path.length > 42 ? `${path.slice(0, 39)}...` : path;
  } catch (error) {
    return value.length > 42 ? `${value.slice(0, 39)}...` : value;
  }
}

function formatTimestamp(date) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ];

  return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}
