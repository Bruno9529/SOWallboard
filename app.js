console.log("APP STARTED");

/* =============================
   WALLBOARD – FULL app.js (CLEAN)
   - Auto CONFIG for all agents
   - Departments stacked
   - Status + View toggles
   - Reconnect banner
   - Stale detection
   - Support availability highlight
   - Clock update
============================= */

/* =============================
  🔧 CONFIG
============================= */
const WS_URL = "wss://alpha.api.voicehost.io/v3/websocket";
const TOKEN = "lg5hu94pdk6ptm92mvofknrjl6".trim(); // trim avoids hidden whitespace

// If your seat prefix differs, change this:
const SEAT_PREFIX = "10000";

// Timeframe for metrics (e.g. "today")
const TIMEFRAME = "today";

// The four metrics you display in each agent row:
const METRICS_TO_SUBSCRIBE = [
  "answered_inbound",
  "calls_outbound",
  "calls_internal",
  "duration_total",
];

/* =============================
  👤 AGENT INFO + ORDER
============================= */
const agentInfo = {
  // Sales
  "244": { name: "Adam",  role: "Sales Manager", ext: "244", dept: "Sales" },
  "233": { name: "Sean",  ext: "233", dept: "Sales" },
  "235": { name: "Dave",  ext: "235", dept: "Sales" },
  "227": { name: "Lee",   ext: "227", dept: "Sales" },

  // Support
  "206": { name: "Tom",      role: "Support Manager", ext: "206", dept: "Support" },
  "214": { name: "Ben",      ext: "214", dept: "Support" },
  "217": { name: "Connor P", ext: "217", dept: "Support" },
  "209": { name: "Aidan",    ext: "209", dept: "Support" },
  "211": { name: "Anton",    ext: "211", dept: "Support" },
  "212": { name: "Abbie",    ext: "212", dept: "Support" },
  "215": { name: "George",   ext: "215", dept: "Support" },
  "219": { name: "Connor B", ext: "219", dept: "Support" },

  // Admin
  "216": { name: "Jake",  ext: "216", dept: "Admin" },
  "221": { name: "Kaya",  ext: "221", dept: "Admin" },
  "232": { name: "Kelly", ext: "232", dept: "Admin" },
  "231": { name: "Chani", ext: "231", dept: "Admin" },
  "218": { name: "Anna",  ext: "218", dept: "Admin" },

  // Operations
  "213": { name: "Simon",    role: "Ops Manager", ext: "213", dept: "Operations" },
  "230": { name: "Connor H", ext: "230", dept: "Operations" },

  // Accounts
  "229": { name: "Emily", ext: "229", dept: "Accounts" },

  // Directors
  "201": { name: "Ross", role: "Technical Director", ext: "201", dept: "Directors" },
  "200": { name: "Phil", role: "Sales Director",     ext: "200", dept: "Directors" },
};

const DEPARTMENTS = ["Sales", "Support", "Admin", "Operations", "Accounts", "Directors"];

// Stable ordering (exactly as requested)
const AGENT_ORDER = [
  // Sales
  "244","233","235","227",
  // Support
  "206","214","217","209","211","212","215","219",
  // Admin
  "216","221","232","231","218",
  // Operations
  "213","230",
  // Accounts
  "229",
  // Directors
  "201","200",
];

/* =============================
  🧩 BUILD CONFIG FOR ALL AGENTS
============================= */
function buildConfigForAllAgents() {
  const cfg = [];
  let wid = 0;

  for (const agentId of AGENT_ORDER) {
    for (const metric of METRICS_TO_SUBSCRIBE) {
      cfg.push({
        widgetId: String(wid++),
        updateFunction: "onReceiveOneByOne",
        metricType: "seat_pick",
        metrics: [metric],
        subType: `${SEAT_PREFIX}*${agentId}`,
        timeframe: TIMEFRAME
      });
    }
  }
  return cfg;
}

const CONFIG = buildConfigForAllAgents();

/* =============================
  🧠 STATE
============================= */
const agents = {};          // agentId -> metric map
const presence = {};        // agentId -> presence payload
const widgetMap = {};       // widgetId -> { agent, metric }
const deptContainers = {};  // dept -> dept-body element
const lastSeen = {};        // agentId -> timestamp (ms)

// Toggles
let showStatusView = true;  // dept breakdown On/Off
let detailedView = true;    // Detailed vs Compact

// WebSocket
let ws = null;
let subscribed = false;
let reconnectAttempt = 0;

/* =============================
  🧩 WIDGET MAP
============================= */
function buildWidgetMap() {
  // clear
  for (const k of Object.keys(widgetMap)) delete widgetMap[k];

  if (!Array.isArray(CONFIG) || CONFIG.length === 0) {
    console.warn("CONFIG is empty — no metrics will update.");
    return;
  }

  CONFIG.forEach(w => {
    const agentId = String(w.subType || "").split("*")[1];
    const metricName = (w.metrics && w.metrics[0]) ? w.metrics[0] : null;
    if (!w.widgetId || !agentId || !metricName) return;

    widgetMap[w.widgetId] = { agent: agentId, metric: metricName };
  });
}

/* =============================
  🧱 DEPARTMENTS UI
============================= */
function initDepartments() {
  const root = document.getElementById("agentGrid");
  if (!root) return;

  root.innerHTML = "";

  DEPARTMENTS.forEach(dept => {
    const section = document.createElement("section");
    section.className = "dept";
    section.id = `dept_${dept}`;

    section.innerHTML = `
      <div class="dept-header">
        <div class="dept-title">
          <span class="dept-name">${dept}</span>
          <span class="dept-count" id="deptCount_${dept}">(0)</span>
          <span class="dept-status" id="deptStatus_${dept}"></span>
        </div>
        <div class="dept-columns">
          <span>Inbound</span>
          <span>Outbound</span>
          <span>Internal</span>
          <span>Total</span>
        </div>
      </div>
      <div class="dept-body" id="deptBody_${dept}"></div>
    `;

    root.appendChild(section);
    deptContainers[dept] = section.querySelector(`#deptBody_${dept}`);
  });
}

/* Keep agent rows in a stable order inside each dept body */
function insertAgentInOrder(parent, el, agentId) {
  const desiredIndex = AGENT_ORDER.indexOf(agentId);
  if (desiredIndex < 0) {
    parent.appendChild(el);
    return;
  }

  const children = Array.from(parent.children);
  for (const child of children) {
    const childId = (child.id || "").replace("agent_", "");
    const childIndex = AGENT_ORDER.indexOf(childId);
    if (childIndex < 0) continue;

    if (desiredIndex < childIndex) {
      parent.insertBefore(el, child);
      return;
    }
  }
  parent.appendChild(el);
}

/* =============================
  🔘 TOGGLES
============================= */
function applyStatusView() {
  document.body.classList.toggle("status-off", !showStatusView);

  const btn = document.getElementById("statusToggle");
  const stateText = document.getElementById("statusSwitchState");
  if (btn) btn.setAttribute("aria-checked", showStatusView ? "true" : "false");
  if (stateText) stateText.textContent = showStatusView ? "On" : "Off";

  try { localStorage.setItem("wallboard_showStatusView", showStatusView ? "1" : "0"); } catch {}
}

function initStatusToggle() {
  try {
    const saved = localStorage.getItem("wallboard_showStatusView");
    if (saved === "0") showStatusView = false;
  } catch {}

  applyStatusView();

  const btn = document.getElementById("statusToggle");
  if (btn) btn.addEventListener("click", () => {
    showStatusView = !showStatusView;
    applyStatusView();
  });
}

function applyViewMode() {
  document.body.classList.toggle("compact", !detailedView);

  const btn = document.getElementById("viewToggle");
  const stateText = document.getElementById("viewSwitchState");
  if (btn) btn.setAttribute("aria-checked", detailedView ? "true" : "false");
  if (stateText) stateText.textContent = detailedView ? "Detailed" : "Compact";

  try { localStorage.setItem("wallboard_detailedView", detailedView ? "1" : "0"); } catch {}
}

function initViewToggle() {
  try {
    const saved = localStorage.getItem("wallboard_detailedView");
    if (saved === "0") detailedView = false;
  } catch {}

  applyViewMode();

  const btn = document.getElementById("viewToggle");
  if (btn) btn.addEventListener("click", () => {
    detailedView = !detailedView;
    applyViewMode();
  });
}

/* =============================
  📣 CONNECTION BANNER
============================= */
let bannerHideTimer = null;

function showBanner(text, visible = true, autoHideMs = 0) {
  const banner = document.getElementById("connBanner");
  const t = document.getElementById("connText");
  if (!banner || !t) return;

  t.textContent = text;
  banner.classList.toggle("hidden", !visible);

  if (bannerHideTimer) clearTimeout(bannerHideTimer);
  bannerHideTimer = null;

  if (visible && autoHideMs > 0) {
    bannerHideTimer = setTimeout(() => banner.classList.add("hidden"), autoHideMs);
  }
}

/* =============================
  🔌 WEBSOCKET (RECONNECT)
============================= */
function connectWebSocket() {
  subscribed = false;

  if (!TOKEN) {
    showBanner("Missing token — cannot authenticate", true);
    console.error("TOKEN is empty.");
    return;
  }

  showBanner("Connecting…", true);

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectAttempt = 0;
    showBanner("Connected", true, 1500);

    // ✅ Authenticate ONCE, always with token
    ws.send(JSON.stringify({
      command: "authenticate",
      token: TOKEN
    }));
  };

  ws.onmessage = (msg) => {
    let parsed;
    try { parsed = JSON.parse(msg.data); }
    catch { return; }

    if (parsed.event === "hello") return;

    // ✅ Auth OK -> subscribe metrics once
    if (parsed.status === "OK" && parsed.command_reply === "authenticate" && !subscribed) {
      subscribed = true;

      ws.send(JSON.stringify({
        command: "updateMetrics",
        data: CONFIG
      }));

      return;
    }

    // ❌ Auth failed
    if (parsed.status === "UNAUTHORIZED" && parsed.command_reply === "authenticate") {
      showBanner("Auth failed (UNAUTHORIZED)", true);
      console.error("UNAUTHORIZED: token invalid/expired or wrong environment/origin.", parsed);
      return;
    }

    if (parsed.event === "updateMetrics") {
      handleUpdate(parsed.data);
      return;
    }

    if (parsed.event === "updatePresence") {
      handlePresence(parsed.data);
      return;
    }
  };

  ws.onclose = () => {
    showBanner("Disconnected — reconnecting…", true);
    scheduleReconnect();
  };

  ws.onerror = () => {
    showBanner("Connection error — reconnecting…", true);
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  reconnectAttempt += 1;
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempt - 1));
  showBanner(`Reconnecting in ${Math.round(delay / 1000)}s…`, true);
  setTimeout(() => connectWebSocket(), delay);
}

/* =============================
  📡 UPDATES + STALE
============================= */
function touchAgent(id) {
  lastSeen[id] = Date.now();
}

function handleUpdate(data) {
  const map = widgetMap[data?.widgetId];
  if (!map) return;

  const metricsObj = Array.isArray(data.metrics) ? data.metrics[0] : data.metrics;

  if (!agents[map.agent]) agents[map.agent] = {};
  agents[map.agent][map.metric] = metricsObj?.[map.metric] || 0;

  touchAgent(map.agent);
  renderAgent(map.agent);
  updateTotals();
  updateDeptHeaderCounts();
  updateHighlights();
}

function handlePresence(data) {
  const id = String(data?.seat || "").split("*")[1];
  if (!id) return;

  presence[id] = data;

  touchAgent(id);
  renderAgent(id);
  updateDeptHeaderCounts();
  updateHighlights();
}

const STALE_AFTER_MS = 30000;

setInterval(() => {
  const now = Date.now();

  AGENT_ORDER.forEach(id => {
    const el = document.getElementById("agent_" + id);
    if (!el) return;

    const seen = lastSeen[id];
    const ageMs = seen ? (now - seen) : null;

    if (ageMs !== null) el.classList.toggle("stale", ageMs > STALE_AFTER_MS);

    const upd = el.querySelector(".last-updated");
    if (upd) {
      upd.textContent = (ageMs === null)
        ? "No updates yet"
        : `Updated ${Math.floor(ageMs / 1000)}s ago`;
    }
  });
}, 1000);

/* =============================
  🧑‍💼 RENDER
============================= */
function renderAgent(id) {
  const a = agents[id] || {};
  const p = presence[id];
  const info = agentInfo[id] || { name: "Unknown", ext: id, dept: "Admin" };

  // Determine status
  let status = "offline";
  let statusText = "Off";

  if (p) {
    if (p.dnd) { status = "dnd"; statusText = "DND"; }
    else if (p.state === "AVAILABLE") { status = "available"; statusText = "Avail"; }
    else if (p.state === "INUSE") { status = "busy"; statusText = "Busy"; }
    else if (p.state === "RINGING") { status = "ringing"; statusText = "Ring"; }
  }

  const dept = info.dept || "Admin";
  const parent = deptContainers[dept] || deptContainers["Admin"] || document.getElementById("agentGrid");
  if (!parent) return;

  let el = document.getElementById("agent_" + id);

  if (!el) {
    el = document.createElement("div");
    el.id = "agent_" + id;
    el.className = "agent-row";
    insertAgentInOrder(parent, el, id);
  } else {
    // If dept changes, move it
    if (el.parentElement !== parent) {
      insertAgentInOrder(parent, el, id);
    }
  }

  el.className = `agent-row ${status}`;

  const last = lastSeen[id] ? Math.floor((Date.now() - lastSeen[id]) / 1000) : null;

  el.innerHTML = `
    <div class="agent-name">
      <div class="name">
        ${escapeHtml(info.name)}
        <span class="status-pill">${statusText}</span>
      </div>
      ${info.role ? `<div class="role">${escapeHtml(info.role)}</div>` : ""}
      <div class="ext">Ext ${escapeHtml(info.ext)}</div>
      <div class="last-updated">${last !== null ? `Updated ${last}s ago` : `No updates yet`}</div>
    </div>

    <div class="agent-stats">
      <div class="stat"><span class="val">${a.answered_inbound || 0}</span></div>
      <div class="stat hide-compact"><span class="val">${a.calls_outbound || 0}</span></div>
      <div class="stat hide-compact"><span class="val">${a.calls_internal || 0}</span></div>
      <div class="stat"><span class="val">${formatTime(a.duration_total || 0)}</span></div>
    </div>
  `;
}

/* =============================
  🔢 TOTALS
============================= */
function updateTotals() {
  let inbound = 0, outbound = 0, internal = 0, total = 0;

  Object.values(agents).forEach(a => {
    inbound  += a.answered_inbound || 0;
    outbound += a.calls_outbound || 0;
    internal += a.calls_internal || 0;
    total    += a.duration_total || 0;
  });

  setText("inboundCount", inbound);
  setText("outboundCount", outbound);
  setText("internalCount", internal);
  setText("totalDuration", formatTime(total));
}

/* =============================
  🧮 DEPARTMENT COUNTS
============================= */
function updateDeptHeaderCounts() {
  const deptStats = {};
  DEPARTMENTS.forEach(d => {
    deptStats[d] = { total: 0, available: 0, busy: 0, ringing: 0, offline: 0, dnd: 0 };
  });

  AGENT_ORDER.forEach(id => {
    const info = agentInfo[id];
    if (!info) return;

    const dept = info.dept || "Admin";
    if (!deptStats[dept]) {
      deptStats[dept] = { total: 0, available: 0, busy: 0, ringing: 0, offline: 0, dnd: 0 };
    }

    deptStats[dept].total += 1;

    const p = presence[id];
    let st = "offline";
    if (p) {
      if (p.dnd) st = "dnd";
      else if (p.state === "AVAILABLE") st = "available";
      else if (p.state === "INUSE") st = "busy";
      else if (p.state === "RINGING") st = "ringing";
    }
    deptStats[dept][st] += 1;
  });

  Object.keys(deptStats).forEach(dept => {
    const countEl = document.getElementById(`deptCount_${dept}`);
    if (countEl) countEl.textContent = `(${deptStats[dept].total})`;

    const statusEl = document.getElementById(`deptStatus_${dept}`);
    if (statusEl) {
      const s = deptStats[dept];
      statusEl.textContent = `• Avail ${s.available} • Busy ${s.busy} • Ring ${s.ringing} • DND ${s.dnd} • Off ${s.offline}`;
    }
  });
}

/* =============================
  🚨 HIGHLIGHTS (SUPPORT)
============================= */
function updateHighlights() {
  const supportIds = AGENT_ORDER.filter(id => agentInfo[id]?.dept === "Support");
  const total = supportIds.length;

  let available = 0;
  supportIds.forEach(id => {
    const p = presence[id];
    if (!p) return;
    if (!p.dnd && p.state === "AVAILABLE") available += 1;
  });

  const hlSupport = document.getElementById("hlSupportText");
  const dot = document.querySelector("#hl_support .hl-dot");

  if (hlSupport) {
    hlSupport.textContent = `Support availability low: ${available}/${total} available`;
  }

  if (dot) {
    dot.classList.remove("warn", "bad");
    if (total > 0 && available <= 1) dot.classList.add("bad");
    else if (total > 0 && available <= 2) dot.classList.add("warn");
  }
}

/* =============================
  🕒 CLOCK
============================= */
setInterval(() => {
  const now = new Date();
  const timeEl = document.getElementById("clockTime");
  const dateEl = document.getElementById("clockDate");

  if (timeEl) timeEl.innerText =
    now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  if (dateEl) dateEl.innerText =
    now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}, 1000);

/* =============================
  🧰 UTIL
============================= */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.innerText = val;
}

function formatTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =============================
  🚀 INIT
============================= */
window.addEventListener("DOMContentLoaded", () => {
  initDepartments();
  initStatusToggle();
  initViewToggle();

  buildWidgetMap();

  // Pre-render agents so they always show (even before data arrives)
  AGENT_ORDER.forEach(id => renderAgent(id));
  updateDeptHeaderCounts();
  updateHighlights();

  // Start WebSocket (auto reconnect enabled)
  connectWebSocket();
});
