(() => {
if (window.__tableExtractContentLoaded) {
  return;
}

window.__tableExtractContentLoaded = true;

const SELECTABLE_SELECTOR = "table, ul";
let isSelecting = false;
let hoveredElement = null;
let highlightBox = null;
let highlightLabel = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "TABLE_EXTRACT_START_SELECT") {
    startSelecting();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "TABLE_EXTRACT_SCAN") {
    sendResponse({ ok: true, tables: scanTables() });
    return false;
  }

  if (message.type === "TABLE_EXTRACT_HIGHLIGHT") {
    highlightScannedTable(message.tableId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "TABLE_EXTRACT_CLEAR_HIGHLIGHT") {
    clearHover();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "TABLE_EXTRACT_START_NETWORK_CAPTURE") {
    injectNetworkHook();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

window.addEventListener("TABLE_EXTRACT_START_SELECT", startSelecting);
window.addEventListener("message", handleNetworkCaptureMessage);

function startSelecting() {
  if (isSelecting) {
    return;
  }

  isSelecting = true;
  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("keydown", handleKeyDown, true);
  window.addEventListener("scroll", handleViewportChange, true);
  window.addEventListener("resize", handleViewportChange, true);
  showToast("移动鼠标高亮表格，点击导出。按 Esc 取消。");
}

function stopSelecting() {
  isSelecting = false;
  clearHover();
  document.removeEventListener("mousemove", handleMouseMove, true);
  document.removeEventListener("click", handleClick, true);
  document.removeEventListener("keydown", handleKeyDown, true);
  window.removeEventListener("scroll", handleViewportChange, true);
  window.removeEventListener("resize", handleViewportChange, true);
}

function handleMouseMove(event) {
  const candidate = findSelectableElement(event.target);

  if (candidate === hoveredElement) {
    return;
  }

  clearHover();

  if (candidate) {
    hoveredElement = candidate;
    hoveredElement.classList.add("table-extract-hover");
    updateHighlight(candidate);
  }
}

async function handleClick(event) {
  const candidate = findSelectableElement(event.target);

  if (!candidate) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  stopSelecting();
  candidate.classList.add("table-extract-selected");

  try {
    const rows = extractRows(candidate);

    if (!rows.length || !rows.some((row) => row.some(Boolean))) {
      throw new Error("没有从所选元素中提取到有效数据");
    }

    const filename = `table-extract-${formatTimestamp(new Date())}.xlsx`;
    const buffer = createXlsx(rows);
    const dataUrl = await arrayBufferToDataUrl(buffer);
    const response = await chrome.runtime.sendMessage({
      type: "TABLE_EXTRACT_DOWNLOAD",
      filename,
      url: dataUrl
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "下载失败");
    }

    showToast(`已导出 ${rows.length} 行数据。`);
  } catch (error) {
    showToast(error.message || "导出失败");
  } finally {
    setTimeout(() => candidate.classList.remove("table-extract-selected"), 900);
  }
}

function handleKeyDown(event) {
  if (event.key === "Escape") {
    stopSelecting();
    showToast("已取消选择。");
  }
}

function handleViewportChange() {
  if (hoveredElement) {
    updateHighlight(hoveredElement);
  }
}

function clearHover() {
  if (hoveredElement) {
    hoveredElement.classList.remove("table-extract-hover");
    hoveredElement = null;
  }

  removeHighlight();
}

function findSelectableElement(start) {
  const element = start && start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
  const candidate = element ? element.closest(SELECTABLE_SELECTOR) : null;

  if (!candidate || !document.documentElement.contains(candidate)) {
    return null;
  }

  if (candidate.matches("table")) {
    return candidate;
  }

  return isListTable(candidate) ? candidate : null;
}

function scanTables() {
  return Array.from(document.querySelectorAll(SELECTABLE_SELECTOR))
    .map((element, index) => {
      if (element.matches("ul") && !isListTable(element)) {
        return null;
      }

      const rows = extractRows(element);

      if (!rows.length || !rows.some((row) => row.some(Boolean))) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      const type = element.tagName.toLowerCase();
      const rowCount = rows.length;
      const columnCount = Math.max(0, ...rows.map((row) => row.length));
      const preview = rows
        .flat()
        .filter(Boolean)
        .slice(0, 3)
        .join(" / ");

      element.dataset.tableExtractId = `${Date.now()}-${index}`;

      return {
        id: element.dataset.tableExtractId,
        type,
        rows,
        rowCount,
        columnCount,
        preview,
        visible: rect.width > 0 && rect.height > 0,
        top: Math.round(rect.top + window.scrollY),
        left: Math.round(rect.left + window.scrollX)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.top - b.top || a.left - b.left);
}

function highlightScannedTable(tableId) {
  clearHover();

  const element = document.querySelector(`[data-table-extract-id="${cssEscape(tableId)}"]`);

  if (!element) {
    return;
  }

  hoveredElement = element;
  hoveredElement.classList.add("table-extract-hover");
  updateHighlight(element);
  element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, "\\$&");
}

function injectNetworkHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/network-hook.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
  showToast("已开始监听 JSON 网络请求，请在页面中点击一次分页。");
}

async function handleNetworkCaptureMessage(event) {
  if (!event.data || event.data.source !== "TABLE_EXTRACT_NETWORK") {
    return;
  }

  const captured = buildCapturedRequest(event.data.payload);

  if (!captured) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      type: "TABLE_EXTRACT_SAVE_CAPTURE",
      pageUrl: await getTopPageUrl(),
      capture: captured
    });
  } catch (error) {
    showToast(error.message || "保存网络捕获失败");
  }
}

async function getTopPageUrl() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "TABLE_EXTRACT_GET_TAB_URL" });
    return response && response.url ? response.url : location.href;
  } catch (error) {
    return location.href;
  }
}

function buildCapturedRequest(payload) {
  if (!payload || payload.status >= 400 || !payload.responseText) {
    return buildDiagnosticCapture(payload, "响应为空或 HTTP 状态失败");
  }

  let json;

  try {
    json = JSON.parse(payload.responseText);
  } catch (error) {
    return buildDiagnosticCapture(payload, `JSON 解析失败: ${error.message || "未知错误"}`);
  }

  const rows = findBestRows(json);

  const request = {
    method: String(payload.method || "GET").toUpperCase(),
    url: payload.url,
    headers: payload.headers || {},
    body: payload.body || ""
  };

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    signature: `${request.method}:${request.url}:${request.body}`,
    capturedAt: Date.now(),
    pageUrl: location.href,
    request,
    rowPath: rows.path,
    rowCount: rows.items.length,
    columns: inferColumns(rows.items),
    preview: rows.items.length ? previewRows(rows.items) : "已捕获 JSON，但未识别到表格数组"
  };
}

function buildDiagnosticCapture(payload, reason) {
  if (!payload || !payload.url) {
    return null;
  }

  const request = {
    method: String(payload.method || "GET").toUpperCase(),
    url: payload.url,
    headers: payload.headers || {},
    body: payload.body || ""
  };

  const responseText = payload.responseText || "";

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    signature: `${request.method}:${request.url}:${request.body}`,
    capturedAt: Date.now(),
    pageUrl: location.href,
    request,
    rowPath: "",
    rowCount: 0,
    columns: [],
    preview: `${reason}${responseText ? ` · ${cleanText(responseText).slice(0, 80)}` : ""}`
  };
}

function findBestRows(value, path = "$") {
  let best = { path: "", items: [] };

  if (Array.isArray(value)) {
    if (value.length && value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      best = { path, items: value };
    }

    value.forEach((item, index) => {
      const candidate = findBestRows(item, `${path}[${index}]`);

      if (candidate.items.length > best.items.length) {
        best = candidate;
      }
    });

    return best;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const candidate = findBestRows(child, `${path}.${key}`);

      if (candidate.items.length > best.items.length) {
        best = candidate;
      }
    }
  }

  return best;
}

function inferColumns(items) {
  const columns = [];
  const seen = new Set();

  for (const item of items.slice(0, 20)) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  return columns;
}

function previewRows(items) {
  return items
    .slice(0, 2)
    .flatMap((item) => Object.values(item).slice(0, 3))
    .map((value) => cleanText(value == null ? "" : value))
    .filter(Boolean)
    .slice(0, 4)
    .join(" / ");
}

function updateHighlight(element) {
  const rows = extractRows(element);
  const rowCount = rows.length;
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const rect = element.getBoundingClientRect();

  if (!highlightBox) {
    highlightBox = document.createElement("div");
    highlightBox.className = "table-extract-highlight-box";
    document.documentElement.appendChild(highlightBox);
  }

  if (!highlightLabel) {
    highlightLabel = document.createElement("div");
    highlightLabel.className = "table-extract-highlight-label";
    document.documentElement.appendChild(highlightLabel);
  }

  highlightBox.style.left = `${rect.left}px`;
  highlightBox.style.top = `${rect.top}px`;
  highlightBox.style.width = `${rect.width}px`;
  highlightBox.style.height = `${rect.height}px`;
  highlightLabel.textContent = `${element.tagName.toLowerCase()} · ${rowCount} 行 × ${columnCount} 列`;
  positionHighlightLabel(rect);
}

function positionHighlightLabel(rect) {
  const labelWidth = Math.min(260, Math.max(130, rect.width));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - labelWidth - 8));
  const top = rect.top >= 34 ? rect.top - 30 : rect.bottom + 6;

  highlightLabel.style.left = `${left}px`;
  highlightLabel.style.top = `${Math.max(8, Math.min(top, window.innerHeight - 34))}px`;
  highlightLabel.style.maxWidth = `${labelWidth}px`;
}

function removeHighlight() {
  if (highlightBox) {
    highlightBox.remove();
    highlightBox = null;
  }

  if (highlightLabel) {
    highlightLabel.remove();
    highlightLabel = null;
  }
}

function isListTable(ul) {
  const rows = Array.from(ul.children).filter((child) => child.matches("li"));

  if (rows.length < 1) {
    return false;
  }

  const columnCounts = rows.map((row) => getListCells(row).length);
  const maxColumns = Math.max(...columnCounts);
  return maxColumns >= 2;
}

function extractRows(element) {
  if (element.matches("table")) {
    return normalizeRows(extractTableRows(element));
  }

  if (element.matches("ul")) {
    return normalizeRows(extractListRows(element));
  }

  return [];
}

function extractTableRows(table) {
  return Array.from(table.rows).map((row) => {
    return Array.from(row.cells).map((cell) => cleanText(cell.innerText || cell.textContent || ""));
  });
}

function extractListRows(ul) {
  return Array.from(ul.children)
    .filter((child) => child.matches("li"))
    .map((row) => getListCells(row).map((cell) => cleanText(cell.innerText || cell.textContent || "")));
}

function getListCells(row) {
  const directChildren = Array.from(row.children).filter(isVisibleElement);

  if (directChildren.length === 1) {
    const nested = Array.from(directChildren[0].children).filter(isVisibleElement);

    if (nested.length >= 2) {
      return nested;
    }
  }

  return directChildren;
}

function isVisibleElement(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

function normalizeRows(rows) {
  const cleaned = rows.map((row) => row.map(cleanText));
  const maxColumns = Math.max(0, ...cleaned.map((row) => row.length));

  return cleaned
    .filter((row) => row.length && row.some(Boolean))
    .map((row) => {
      const next = row.slice(0, maxColumns);

      while (next.length < maxColumns) {
        next.push("");
      }

      return next;
    });
}

function cleanText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function createXlsx(rows) {
  const files = [
    {
      name: "[Content_Types].xml",
      content: xmlToBytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`)
    },
    {
      name: "_rels/.rels",
      content: xmlToBytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: xmlToBytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`)
    },
    {
      name: "xl/workbook.xml",
      content: xmlToBytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`)
    },
    {
      name: "xl/styles.xml",
      content: xmlToBytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`)
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: xmlToBytes(createWorksheetXml(rows))
    }
  ];

  return createZip(files);
}

function createWorksheetXml(rows) {
  const sheetRows = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = row
        .map((value, columnIndex) => {
          const ref = `${columnName(columnIndex + 1)}${rowNumber}`;
          return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join("");

      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

function columnName(index) {
  let name = "";
  let current = index;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }

  return name;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlToBytes(xml) {
  return new TextEncoder().encode(xml);
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = xmlToBytes(file.name);
    const data = file.content;
    const crc = crc32(data);
    const localHeader = concatBytes(
      uint32(0x04034b50),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(crc),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes
    );

    localParts.push(localHeader, data);
    centralParts.push(
      concatBytes(
        uint32(0x02014b50),
        uint16(20),
        uint16(20),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(crc),
        uint32(data.length),
        uint32(data.length),
        uint16(nameBytes.length),
        uint16(0),
        uint16(0),
        uint16(0),
        uint16(0),
        uint32(0),
        uint32(offset),
        nameBytes
      )
    );

    offset += localHeader.length + data.length;
  }

  const centralDirectory = concatBytes(...centralParts);
  const endRecord = concatBytes(
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(files.length),
    uint16(files.length),
    uint32(centralDirectory.length),
    uint32(offset),
    uint16(0)
  );

  return concatBytes(...localParts, centralDirectory, endRecord).buffer;
}

function uint16(value) {
  const bytes = new Uint8Array(2);
  bytes[0] = value & 0xff;
  bytes[1] = (value >>> 8) & 0xff;
  return bytes;
}

function uint32(value) {
  const bytes = new Uint8Array(4);
  bytes[0] = value & 0xff;
  bytes[1] = (value >>> 8) & 0xff;
  bytes[2] = (value >>> 16) & 0xff;
  bytes[3] = (value >>> 24) & 0xff;
  return bytes;
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function crc32(data) {
  let crc = 0xffffffff;

  for (let index = 0; index < data.length; index += 1) {
    crc ^= data[index];

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function arrayBufferToDataUrl(buffer) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
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

function showToast(message) {
  const oldToast = document.querySelector(".table-extract-toast");

  if (oldToast) {
    oldToast.remove();
  }

  const toast = document.createElement("div");
  toast.className = "table-extract-toast";
  toast.textContent = message;
  document.documentElement.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
})();
