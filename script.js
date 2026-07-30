// ============================================================
// Mitsubishi Meta Ads AI Dashboard — script.js (v4 Professional)
// Reads everything from dashboard.json (auto-detects whether it
// lives beside index.html or inside a /data folder).
// n8n only ever needs to overwrite that file — no HTML/CSS
// changes required to reflect new numbers or new date ranges.
//
// v4 additions (script.js only — schema, IDs, and n8n workflow
// are all unchanged):
//   - single-request path resolution (no throwaway probe fetch)
//   - auto-detects which ranges actually exist in ranges{} and
//     disables/enables the Today/7 Days/30 Days buttons to match
//   - animated KPI value transitions (not just the health gauge)
//   - defensive against 100+ campaign rows (single DOM write,
//     no per-row layout thrash)
// ============================================================

const REFRESH_INTERVAL_MS = 60000; // poll every 60s for n8n updates
const ANIMATE_MS = 700;

const CHART_COLORS = {
  primary: "#E60012",
  green: "#2ECC71",
  amber: "#F5A623",
  grid: "#2C2C2C",
  text: "#AAAAAA",
};

if (typeof Chart !== "undefined") {
  Chart.defaults.font.family = "'JetBrains Mono', monospace";
  Chart.defaults.color = CHART_COLORS.text;
}

let charts = {};
let currentData = null;
let currentRange = "today";
let sortState = { key: "spend", dir: "desc" };
let resolvedDataUrl = null; // cached once we know where dashboard.json lives
let prevKpiValues = {}; // last rendered numeric value per KPI id, for count-up animation
let rafHandles = {}; // in-flight animation frames per element id, so re-renders don't stack

// ---------------- PATH DETECTION + LOAD ----------------

// Tries "data/dashboard.json" first (since that's how this project
// is normally organized); if that 404s, falls back to
// "dashboard.json" beside index.html. Works on GitHub Pages because
// both are relative paths resolved against the page's own folder.
//
// Each candidate is fetched exactly once and that same response is
// used as the actual data — no throwaway probe request, so there's
// no window for GitHub Pages' edge cache to disagree with itself
// between a "check" request and a "real" request.
async function fetchDashboardData() {
  const candidates = resolvedDataUrl
    ? [resolvedDataUrl, "data/dashboard.json", "dashboard.json"]
    : ["data/dashboard.json", "dashboard.json"];

  let lastError = null;

  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        resolvedDataUrl = candidate;
        return data;
      }
      lastError = new Error(`HTTP ${res.status} at ${candidate}`);
    } catch (err) {
      lastError = err;
    }
  }

  // Nothing resolved this round — forget any cached path so the
  // next poll re-probes from scratch instead of getting stuck.
  resolvedDataUrl = null;
  throw lastError || new Error("dashboard.json not found");
}

async function loadDashboard() {
  try {
    const data = await fetchDashboardData();
    currentData = data || {};

    applyRangeAvailability();

    render();
    setStatus(true);
  } catch (err) {
    console.warn("Dashboard data unavailable:", err.message);
    setStatus(false);
  }
}

function setStatus(isLive) {
  const pill = document.getElementById("liveStatus");
  if (!pill) return;
  if (isLive) {
    pill.innerHTML = `<span class="dot"></span> LIVE`;
  } else {
    pill.innerHTML = `<span class="dot" style="background:#E60012;box-shadow:0 0 8px #E60012;"></span> NO DATA`;
  }
}

// ---------------- RANGE AVAILABILITY ----------------

// Disables any range button whose key isn't present in the current
// dashboard.json's ranges{} object, and makes sure currentRange
// always points at a range that actually has data. Never assumes
// "today"/"7d"/"30d" all exist — reads only from what's there.
function applyRangeAvailability() {
  const ranges = (currentData && currentData.ranges) || {};
  const availableKeys = Object.keys(ranges);

  document.querySelectorAll(".range-btn").forEach((btn) => {
    const key = btn.dataset.range;
    const available = availableKeys.includes(key);
    btn.disabled = !available;
    btn.classList.toggle("range-btn--disabled", !available);
    btn.title = available ? "" : "No data available for this range yet";
  });

  const requested = currentData?.activeRange;
  if (requested && availableKeys.includes(requested)) {
    currentRange = requested;
  } else if (!availableKeys.includes(currentRange)) {
    currentRange = availableKeys[0] || "today";
  }

  syncRangeButtons();
}

// ---------------- RENDER ----------------

function render() {
  if (!currentData) return;
  const ranges = currentData.ranges || {};
  const rangeData = ranges[currentRange] || {};

  setText("reportDate", currentData.reportDate ?? "—");
  setText("lastUpdated", `Last updated ${new Date().toLocaleTimeString()}`);

  animateGauge(currentData.accountHealth);

  // KPI cards + deltas (animated count-up on every render, including range switches)
  animateKpi("kpiSpend", rangeData.spend, formatCurrency);
  animateKpi("kpiMessages", rangeData.messages, formatNumber);
  animateKpi("kpiCtr", rangeData.ctr, formatPercent);
  animateKpi("kpiCpc", rangeData.cpc, formatCurrency);
  animateKpi("kpiCpm", rangeData.cpm, formatCurrency);
  animateKpi("kpiCostMsg", rangeData.costPerMessage, formatCurrency);

  renderDelta("deltaSpend", rangeData.spendChangeYesterday);
  renderDelta("deltaMessages", rangeData.messagesChangeYesterday);
  renderDelta("deltaCtr", rangeData.ctrChangeYesterday);
  renderDelta("deltaCpc", rangeData.cpcChangeYesterday, true);
  renderDelta("deltaCpm", rangeData.cpmChangeYesterday, true);
  renderDelta("deltaCostMsg", rangeData.costPerMessageChangeYesterday, true);

  // Budget pacing
  renderBudget(rangeData.budget);

  // Funnel
  renderFunnel(rangeData.funnel);

  // Top performers
  setText("topCampaignName", rangeData.bestCampaign ?? "—");
  setText("topCampaignRec", rangeData.bestCampaignRecommendation ?? "—");
  setText("topAdName", rangeData.bestAd ?? "—");
  setText("topAdCtr", formatPercent(rangeData.bestAdCtr));
  setText("topCreativeName", rangeData.bestCreative ?? "—");
  setText("topAudienceName", rangeData.bestAudience ?? "—");
  setText("topAudienceRange", rangeData.bestAudienceAgeRange ?? "—");

  // AI recommendations & alerts (account-level, not per range)
  renderReasonedList("recList", currentData.recommendations, "rec");
  renderReasonedList("alertList", currentData.alerts, "alert");

  // Prediction
  setText("predCtr", formatPercent(currentData.predictionTomorrow?.ctr));
  setText("predMessages", formatNumber(currentData.predictionTomorrow?.expectedMessages));

  // Charts
  renderTrendCharts(rangeData.trends);
  renderRankingChart(rangeData.campaigns);

  // Campaigns table
  renderCampaignsTable(rangeData.campaigns);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value ?? "—";
}

// ---------------- ANIMATED KPI VALUES ----------------

// Eases from whatever was last displayed to the new numeric value,
// re-formatting on every frame with the same formatter used at
// rest (formatCurrency/formatNumber/formatPercent), so it never
// drifts from the non-animated formatting rules. Non-numeric or
// missing values skip the animation and just show "—" immediately.
function animateKpi(id, rawValue, formatter) {
  const el = document.getElementById(id);
  if (!el) return;

  const target = Number(rawValue);
  if (rawValue === undefined || rawValue === null || rawValue === "" || isNaN(target)) {
    if (rafHandles[id]) cancelAnimationFrame(rafHandles[id]);
    prevKpiValues[id] = undefined;
    el.textContent = "—";
    return;
  }

  const start = typeof prevKpiValues[id] === "number" ? prevKpiValues[id] : target;
  prevKpiValues[id] = target;

  if (rafHandles[id]) cancelAnimationFrame(rafHandles[id]);

  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min(1, (now - startTime) / ANIMATE_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = start + (target - start) * eased;
    el.textContent = formatter(value);
    if (progress < 1) {
      rafHandles[id] = requestAnimationFrame(tick);
    } else {
      delete rafHandles[id];
    }
  }
  rafHandles[id] = requestAnimationFrame(tick);
}

// ---------------- DELTAS ----------------

function renderDelta(id, value, invert = false) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value === undefined || value === null || isNaN(Number(value))) {
    el.textContent = "—";
    el.className = "delta";
    return;
  }
  const num = Number(value);
  const isUp = num > 0;
  const isFlat = num === 0;
  // for cost metrics (CPC/CPM/Cost per message), a drop is good -> invert coloring
  let cls = "flat";
  if (!isFlat) {
    const good = invert ? !isUp : isUp;
    cls = good ? "up" : "down";
  }
  const arrow = isFlat ? "→" : isUp ? "▲" : "▼";
  el.textContent = `${arrow} ${Math.abs(num).toFixed(1)}%`;
  el.className = `delta ${cls}`;
}

// ---------------- BUDGET PACING ----------------

function renderBudget(budget) {
  const fill = document.getElementById("budgetFill");
  if (!budget || typeof budget !== "object") {
    if (fill) fill.style.width = "0%";
    setText("budgetReadout", "—");
    return;
  }
  const spent = Number(budget.spent) || 0;
  const daily = Number(budget.daily) || 0;
  const pct = daily > 0 ? Math.min(100, (spent / daily) * 100) : 0;
  if (fill) fill.style.width = `${pct}%`;
  setText(
    "budgetReadout",
    daily > 0
      ? `${formatCurrency(spent)} / ${formatCurrency(daily)} (${pct.toFixed(0)}%)`
      : "—"
  );
}

// ---------------- FUNNEL ----------------

function renderFunnel(funnel) {
  const el = document.getElementById("funnelRow");
  if (!el) return;

  if (!funnel || typeof funnel !== "object") {
    el.innerHTML = "";
    return;
  }

  const stages = [
    { label: "Impressions", value: funnel.impressions },
    { label: "Reach", value: funnel.reach },
    { label: "Clicks", value: funnel.clicks },
    { label: "Messages", value: funnel.messages },
    { label: "Conversions", value: funnel.conversions },
  ];

  const html = stages
    .map((stage, i) => {
      const prevVal = i > 0 ? Number(stages[i - 1].value) : null;
      const curVal = Number(stage.value);
      const pctOfPrev =
        i > 0 && prevVal && !isNaN(curVal)
          ? ((curVal / prevVal) * 100).toFixed(1) + "%"
          : "";

      const stageHtml = `
        <div class="funnel-stage">
          <span class="funnel-stage-value">${formatNumber(stage.value)}</span>
          <span class="funnel-stage-label">${stage.label}</span>
          ${pctOfPrev ? `<span class="funnel-stage-pct">${pctOfPrev}</span>` : ""}
        </div>`;

      const arrowHtml = i < stages.length - 1 ? `<span class="funnel-arrow">›</span>` : "";
      return stageHtml + arrowHtml;
    })
    .join("");

  el.innerHTML = html;
}

// ---------------- RECOMMENDATIONS / ALERTS ----------------

function renderReasonedList(containerId, items, type) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!Array.isArray(items) || items.length === 0) {
    el.innerHTML = `<li style="opacity:0.5;">${type === "alert" ? "No alerts" : "No recommendations"}</li>`;
    return;
  }

  const html = items
    .filter((item) => item !== null && item !== undefined)
    .map((item) => {
      const text = typeof item === "string" ? item : item.text ?? "—";
      const reason = typeof item === "string" ? null : item.reason;
      const priority = typeof item === "string" ? null : item.priority;

      return `
        <li>
          <div class="item-head">
            <span class="item-title">${escapeHtml(text)}</span>
            ${priority ? `<span class="priority-badge priority-${escapeHtml(String(priority))}">${escapeHtml(String(priority))}</span>` : ""}
          </div>
          ${reason ? `<span class="item-reason">${escapeHtml(reason)}</span>` : ""}
        </li>`;
    })
    .join("");

  el.innerHTML = html;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------- GAUGE ----------------

function animateGauge(rawScore) {
  const CIRCUMFERENCE = 251;
  const score = Number(rawScore);
  const safeScore = isNaN(score) ? 0 : score;
  const pct = Math.max(0, Math.min(100, safeScore)) / 100;
  const offset = CIRCUMFERENCE - CIRCUMFERENCE * pct;

  const fill = document.getElementById("gaugeFill");
  if (fill) fill.style.strokeDashoffset = offset;

  let color = CHART_COLORS.green;
  if (safeScore < 50) color = "#E60012";
  else if (safeScore < 80) color = "#F5A623";
  if (fill) fill.style.stroke = color;

  animateNumber("healthScore", safeScore);
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const safeTarget = isNaN(Number(target)) ? 0 : Number(target);
  const duration = 900;
  const start = performance.now();

  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(safeTarget * eased);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---------------- FORMATTERS ----------------

function formatCurrency(n) {
  if (n === undefined || n === null || n === "" || isNaN(Number(n))) return "—";
  return `₱${Number(n).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;
}
function formatNumber(n) {
  if (n === undefined || n === null || n === "" || isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-PH");
}
function formatPercent(n) {
  if (n === undefined || n === null || n === "" || isNaN(Number(n))) return "—";
  return `${Number(n).toFixed(2)}%`;
}

// ---------------- CHARTS ----------------

function baseLineOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 650, easing: "easeOutCubic" },
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
      y: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
    },
  };
}

function renderTrendCharts(trends) {
  const safeTrends = trends && typeof trends === "object" ? trends : {};
  const labels = Array.isArray(safeTrends.labels) ? safeTrends.labels : [];

  upsertChart("spendChart", "line", {
    labels,
    datasets: [{
      data: Array.isArray(safeTrends.spend) ? safeTrends.spend : [],
      borderColor: CHART_COLORS.primary,
      backgroundColor: "rgba(230,0,18,0.12)",
      fill: true,
      tension: 0.35,
      pointRadius: 3,
      pointBackgroundColor: CHART_COLORS.primary,
    }],
  }, baseLineOptions());

  upsertChart("ctrChart", "line", {
    labels,
    datasets: [{
      data: Array.isArray(safeTrends.ctr) ? safeTrends.ctr : [],
      borderColor: CHART_COLORS.green,
      backgroundColor: "rgba(46,204,113,0.12)",
      fill: true,
      tension: 0.35,
      pointRadius: 3,
      pointBackgroundColor: CHART_COLORS.green,
    }],
  }, baseLineOptions());

  upsertChart("messagesChart", "bar", {
    labels,
    datasets: [{
      data: Array.isArray(safeTrends.messages) ? safeTrends.messages : [],
      backgroundColor: CHART_COLORS.amber,
      borderRadius: 3,
      maxBarThickness: 28,
    }],
  }, baseLineOptions());
}

function renderRankingChart(campaigns) {
  const safeCampaigns = Array.isArray(campaigns) ? campaigns : [];
  const sorted = [...safeCampaigns].sort(
    (a, b) => (Number(b?.messages) || 0) - (Number(a?.messages) || 0)
  );
  const labels = sorted.map((c) => c?.name ?? "—");
  const messages = sorted.map((c) => Number(c?.messages) || 0);

  upsertChart("rankingChart", "bar", {
    labels,
    datasets: [{
      data: messages,
      backgroundColor: CHART_COLORS.primary,
      borderRadius: 3,
      maxBarThickness: 26,
    }],
  }, {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 650, easing: "easeOutCubic" },
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
      y: { grid: { display: false }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
    },
  });
}

// Always destroys any previous chart on this canvas before creating
// a new one, so ranges/updates never leave duplicate/stacked charts.
function upsertChart(canvasId, type, data, options) {
  if (typeof Chart === "undefined") return;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  if (charts[canvasId]) {
    charts[canvasId].destroy();
    delete charts[canvasId];
  }

  charts[canvasId] = new Chart(canvas.getContext("2d"), { type, data, options });
}

// ---------------- CAMPAIGNS TABLE ----------------

// Builds the whole tbody as one HTML string and writes it once —
// keeps this fast even at 100+ campaign rows, since the browser
// only has to do a single reflow instead of one per row.
function renderCampaignsTable(campaigns) {
  const tbody = document.getElementById("campaignsTableBody");
  if (!tbody) return;

  const safeCampaigns = Array.isArray(campaigns) ? campaigns : [];

  if (safeCampaigns.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;opacity:0.5;">No campaign data</td></tr>`;
    updateSortHeaders();
    return;
  }

  const sorted = [...safeCampaigns].sort((a, b) => {
    const av = a ? a[sortState.key] : undefined;
    const bv = b ? b[sortState.key] : undefined;

    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;

    if (typeof av === "string" || typeof bv === "string") {
      const aStr = String(av);
      const bStr = String(bv);
      return sortState.dir === "asc" ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
    }
    return sortState.dir === "asc" ? av - bv : bv - av;
  });

  const rowsHtml = sorted
    .filter((c) => c)
    .map(
      (c) => `
      <tr>
        <td>${escapeHtml(c.name ?? "—")}</td>
        <td><span class="status-chip status-${escapeHtml(c.status ?? "")}">${escapeHtml(c.status ?? "—")}</span></td>
        <td>${formatCurrency(c.spend)}</td>
        <td>${formatNumber(c.messages)}</td>
        <td>${formatPercent(c.ctr)}</td>
        <td>${formatCurrency(c.cpc)}</td>
        <td>${formatCurrency(c.costPerMessage)}</td>
      </tr>`
    )
    .join("");

  tbody.innerHTML = rowsHtml;
  updateSortHeaders();
}

function updateSortHeaders() {
  document.querySelectorAll("#campaignsTable th[data-key]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === sortState.key);
    th.classList.toggle("asc", th.dataset.key === sortState.key && sortState.dir === "asc");
  });
}

function initTableSorting() {
  document.querySelectorAll("#campaignsTable th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState = { key, dir: "desc" };
      }
      if (currentData) {
        const rangeData = currentData.ranges?.[currentRange];
        renderCampaignsTable(rangeData?.campaigns);
      }
    });
  });
}

// ---------------- RANGE SWITCHING ----------------

function syncRangeButtons() {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === currentRange);
  });
}

function initRangeSwitch() {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return; // range has no data yet — ignore
      const range = btn.dataset.range;
      if (!range) return;
      currentRange = range;
      syncRangeButtons();
      render();
    });
  });
}

// ---------------- EXPORT ----------------

function initExport() {
  const btn = document.getElementById("exportBtn");
  if (!btn) return;
  btn.addEventListener("click", () => window.print());
}

// ---------------- INIT ----------------

initRangeSwitch();
initTableSorting();
initExport();
loadDashboard();
setInterval(loadDashboard, REFRESH_INTERVAL_MS);

// ============================================================
// V5 ADDITIONS — Historical Intelligence Platform
// Reads ONLY from dashboard-history.json via its own fetch/state/
// render pipeline. Never touches dashboard.json, currentData,
// charts{}, or any V4 Overview function above this point — a
// missing or broken history file can never break Today/7 Days/
// 30 Days, and the two data sources are never merged.
// ============================================================

// ---------------- STATE ----------------

let historyData = null;          // raw dashboard-history.json
let processedCampaigns = [];      // historyData.campaigns + model + performanceScore
let dailyPerformance = [];        // historyData.dailyPerformance, unmodified (daily granularity preserved)
let historyResolvedUrl = null;    // cached path, same pattern as resolvedDataUrl
let historyAvailable = false;

let currentYearFilter = "all";
let rankingSortState = { key: "performanceScore", dir: "desc" };
let currentTimelineView = "launches";   // "launches" | "trend"
let currentTimelineMetric = "spend";    // "spend" | "messages"

const MODEL_LIST = [
  "L300", "Mirage G4", "Xpander", "Montero", "XForce",
  "Strada", "Destinator", "Triton", "Outlander", "Attrage", "Adventure",
];

// ---------------- MODEL DETECTION (client-side only) ----------------

function detectModel(campaignName) {
  if (!campaignName) return "Other";
  const name = String(campaignName).toLowerCase();
  const match = MODEL_LIST.find((model) => name.includes(model.toLowerCase()));
  return match || "Other";
}

// ---------------- PATH DETECTION + LOAD (mirrors fetchDashboardData) ----------------

async function fetchHistoryData() {
  const candidates = historyResolvedUrl
    ? [historyResolvedUrl, "data/dashboard-history.json", "dashboard-history.json"]
    : ["data/dashboard-history.json", "dashboard-history.json"];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        historyResolvedUrl = candidate;
        return data;
      }
      lastError = new Error(`HTTP ${res.status} at ${candidate}`);
    } catch (err) {
      lastError = err;
    }
  }
  historyResolvedUrl = null;
  throw lastError || new Error("dashboard-history.json not found");
}

async function loadHistoricalData() {
  try {
    const data = await fetchHistoryData();
    historyData = data || {};
    processHistoricalData();
    setHistoryAvailability(true);
    renderAllHistoricalTabs();
  } catch (err) {
    console.warn("Historical data unavailable:", err.message);
    historyData = null;
    processedCampaigns = [];
    dailyPerformance = [];
    setHistoryAvailability(false);
  }
}

// Orchestrator matching the requested V5 naming — loads BOTH the
// Overview (Daily Summary) and Historical (Campaign Performance)
// pipelines. Not required for either pipeline to function (each
// already self-initiates and self-polls independently below), but
// provided for callers that want to trigger a full refresh at once.
function loadDashboardData() {
  loadDashboard();
  loadHistoricalData();
}

// ---------------- AVAILABILITY / FALLBACK ----------------

// Shows "Historical data unavailable" in every V5 tab and hides
// their content sections when dashboard-history.json can't be
// loaded — Overview keeps working normally regardless.
function setHistoryAvailability(isAvailable) {
  historyAvailable = isAvailable;

  ["historicalEmptyState", "modelEmptyState", "objectivesEmptyState", "recommendationsEmptyState", "timelineEmptyState"]
    .forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = isAvailable;
    });

  ["historicalContent", "timelineContent"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !isAvailable;
  });

  document
    .querySelectorAll('[data-tab-panel="model"] > section, [data-tab-panel="objectives"] > section, [data-tab-panel="recommendations"] > section')
    .forEach((sec) => { sec.hidden = !isAvailable; });
}

// ---------------- PROCESSING ----------------

// Normalizes raw campaign rows, tags each with a client-detected
// model, and computes a transparent (not "AI") performance score:
// weighted CTR + message volume, penalized by cost-per-message.
// Documented here so it's clear this is a simple heuristic, not a
// model prediction.
function processHistoricalData() {
  const rawCampaigns = Array.isArray(historyData?.campaigns) ? historyData.campaigns : [];

  processedCampaigns = rawCampaigns.map((c) => {
    const spend = Number(c.spend) || 0;
    const messages = Number(c.messages) || 0;
    const clicks = Number(c.clicks) || 0;
    const impressions = Number(c.impressions) || 0;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : Number(c.ctr) || 0;
    const costPerMessage = messages > 0 ? spend / messages : (Number(c.cost_per_message) || null);
    const performanceScore = ctr * 10 + messages * 0.5 - (Number(costPerMessage) || 0) * 0.2;

    return {
      ...c,
      model: detectModel(c.campaign_name),
      ctr,
      costPerMessage,
      performanceScore,
    };
  });

  dailyPerformance = Array.isArray(historyData?.dailyPerformance) ? historyData.dailyPerformance : [];
}

function getFilteredCampaigns(yearFilter) {
  if (yearFilter === "all") return processedCampaigns;
  return processedCampaigns.filter((c) => String(c.year) === String(yearFilter));
}

function getFilteredDailyRows(yearFilter) {
  if (yearFilter === "all") return dailyPerformance;
  return dailyPerformance.filter((r) => r.date_meta && String(r.date_meta).slice(0, 4) === String(yearFilter));
}

function aggregateCampaigns(list) {
  let spend = 0, messages = 0, clicks = 0, impressions = 0;
  list.forEach((c) => {
    spend += Number(c.spend) || 0;
    messages += Number(c.messages) || 0;
    clicks += Number(c.clicks) || 0;
    impressions += Number(c.impressions) || 0;
  });
  return {
    spend, messages, clicks, impressions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    costPerMessage: messages > 0 ? spend / messages : null,
    count: list.length,
  };
}

// ---------------- MODULE 2: WINNING CAMPAIGN RANKING ----------------

function calculateCampaignRanking(yearFilter) {
  const list = getFilteredCampaigns(yearFilter);
  const ranked = [...list].sort((a, b) => (b.performanceScore || 0) - (a.performanceScore || 0));
  ranked.forEach((c, i) => { c.rank = i + 1; });
  return ranked;
}

// ---------------- MODULE 3: MODEL PERFORMANCE ----------------

function calculateModelPerformance(yearFilter) {
  const list = getFilteredCampaigns(yearFilter);
  const groups = {};

  list.forEach((c) => {
    const key = c.model || "Other";
    if (!groups[key]) groups[key] = { model: key, spend: 0, messages: 0, clicks: 0, impressions: 0, count: 0 };
    const g = groups[key];
    g.spend += Number(c.spend) || 0;
    g.messages += Number(c.messages) || 0;
    g.clicks += Number(c.clicks) || 0;
    g.impressions += Number(c.impressions) || 0;
    g.count += 1;
  });

  return Object.values(groups)
    .map((g) => ({
      ...g,
      ctr: g.impressions > 0 ? (g.clicks / g.impressions) * 100 : 0,
      costPerMessage: g.messages > 0 ? g.spend / g.messages : null,
    }))
    .sort((a, b) => b.spend - a.spend);
}

// ---------------- MODULE 4: OBJECTIVE COMPARISON ----------------

function calculateObjectiveComparison(yearFilter) {
  const list = getFilteredCampaigns(yearFilter);
  const groups = {};

  list.forEach((c) => {
    const key = c.objective || "Other";
    if (!groups[key]) groups[key] = { objective: key, spend: 0, messages: 0, clicks: 0, impressions: 0, scoreSum: 0, count: 0 };
    const g = groups[key];
    g.spend += Number(c.spend) || 0;
    g.messages += Number(c.messages) || 0;
    g.clicks += Number(c.clicks) || 0;
    g.impressions += Number(c.impressions) || 0;
    g.scoreSum += Number(c.performanceScore) || 0;
    g.count += 1;
  });

  return Object.values(groups)
    .map((g) => ({
      ...g,
      ctr: g.impressions > 0 ? (g.clicks / g.impressions) * 100 : 0,
      costPerMessage: g.messages > 0 ? g.spend / g.messages : null,
      avgPerformanceScore: g.count > 0 ? g.scoreSum / g.count : 0,
    }))
    .sort((a, b) => b.avgPerformanceScore - a.avgPerformanceScore);
}

// ---------------- MODULE 5: RECOMMENDATION CENTER ----------------

// Prefers real recommendation text written by n8n (historyData.recommendations).
// Falls back to simple, transparent rule-based insights computed from
// the aggregates above — never labeled as AI-generated when it isn't.
function generateRecommendations() {
  const list = getFilteredCampaigns(currentYearFilter);
  let items = [];

  if (Array.isArray(historyData?.recommendations) && historyData.recommendations.length > 0) {
    items = historyData.recommendations;
  } else if (list.length > 0) {
    const models = calculateModelPerformance(currentYearFilter).filter((m) => m.count >= 3 && m.costPerMessage !== null);
    const objectives = calculateObjectiveComparison(currentYearFilter);
    const agg = aggregateCampaigns(list);

    if (models.length > 0) {
      const cheapest = [...models].sort((a, b) => a.costPerMessage - b.costPerMessage)[0];
      items.push({
        text: `Increase budget allocation on ${cheapest.model} campaigns`,
        reason: `${cheapest.model} shows the lowest cost-per-message (${formatCurrency(cheapest.costPerMessage)}) among models with 3+ campaigns in this period.`,
        priority: "High",
      });

      const priciest = [...models].sort((a, b) => b.costPerMessage - a.costPerMessage)[0];
      if (priciest.model !== cheapest.model && agg.costPerMessage && priciest.costPerMessage > agg.costPerMessage * 1.3) {
        items.push({
          text: `Review ${priciest.model} campaign spend`,
          reason: `Cost-per-message (${formatCurrency(priciest.costPerMessage)}) is well above the period average (${formatCurrency(agg.costPerMessage)}).`,
          priority: "Medium",
        });
      }
    }

    if (objectives.length > 0) {
      const topObjective = objectives[0];
      items.push({
        text: `Prioritize ${topObjective.objective} campaigns`,
        reason: `${topObjective.objective} has the strongest average performance score across this period's campaigns.`,
        priority: "Medium",
      });
    }

    if (items.length === 0) {
      items.push({
        text: "Not enough data yet",
        reason: "More campaign history is needed to generate reliable recommendations.",
        priority: "Low",
      });
    }
  }

  renderReasonedList("histRecList", items, "rec");
}

// ---------------- MODULE 1: HISTORICAL OVERVIEW (lifetime KPIs + highlights) ----------------

function renderHistoricalOverview() {
  const filtered = getFilteredCampaigns(currentYearFilter);
  const useServerLifetime = currentYearFilter === "all" && historyData?.lifetime;

  const agg = useServerLifetime
    ? {
        spend: Number(historyData.lifetime.spend) || 0,
        messages: Number(historyData.lifetime.messages) || 0,
        clicks: Number(historyData.lifetime.clicks) || 0,
        ctr: Number(historyData.lifetime.avgCtr) || 0,
        costPerMessage: Number(historyData.lifetime.avgCostPerMessage) || null,
        count: Number(historyData.lifetime.totalCampaigns) || filtered.length,
      }
    : aggregateCampaigns(filtered);

  setText("histSpend", formatCurrency(agg.spend));
  setText("histMessages", formatNumber(agg.messages));
  setText("histClicks", formatNumber(agg.clicks));
  setText("histCtr", formatPercent(agg.ctr));
  setText("histCostPerMessage", formatCurrency(agg.costPerMessage));
  setText("histTotalCampaigns", formatNumber(agg.count));

  renderHighlights(filtered);
}

function renderHighlights(list) {
  if (!list || list.length === 0) {
    ["highlightBestCampaign", "highlightLowestCost", "highlightHighestCtr"].forEach((id) => setText(id, "—"));
    ["highlightBestCampaignMeta", "highlightLowestCostMeta", "highlightHighestCtrMeta"].forEach((id) => setText(id, "—"));
    return;
  }

  const bestByScore = [...list].sort((a, b) => (b.performanceScore || 0) - (a.performanceScore || 0))[0];
  setText("highlightBestCampaign", bestByScore.campaign_name ?? "—");
  setText("highlightBestCampaignMeta", bestByScore.model ? `${bestByScore.model} · ${formatNumber(bestByScore.messages)} messages` : "—");

  const withCost = list.filter((c) => c.costPerMessage !== null && c.costPerMessage !== undefined && !isNaN(c.costPerMessage));
  if (withCost.length > 0) {
    const lowestCost = [...withCost].sort((a, b) => a.costPerMessage - b.costPerMessage)[0];
    setText("highlightLowestCost", lowestCost.campaign_name ?? "—");
    setText("highlightLowestCostMeta", formatCurrency(lowestCost.costPerMessage));
  } else {
    setText("highlightLowestCost", "—");
    setText("highlightLowestCostMeta", "—");
  }

  const highestCtr = [...list].sort((a, b) => (b.ctr || 0) - (a.ctr || 0))[0];
  setText("highlightHighestCtr", highestCtr.campaign_name ?? "—");
  setText("highlightHighestCtrMeta", formatPercent(highestCtr.ctr));
}

// ---------------- RANKING TABLE ----------------

function renderRankingTable() {
  const tbody = document.getElementById("rankingTableBody");
  if (!tbody) return;

  const ranked = calculateCampaignRanking(currentYearFilter);

  if (ranked.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;opacity:0.5;">No campaign data for this period</td></tr>`;
    updateRankingSortHeaders();
    return;
  }

  const sorted = [...ranked].sort((a, b) => {
    const key = rankingSortState.key;
    const av = a[key];
    const bv = b[key];
    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      const aStr = String(av);
      const bStr = String(bv);
      return rankingSortState.dir === "asc" ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
    }
    return rankingSortState.dir === "asc" ? av - bv : bv - av;
  });

  tbody.innerHTML = sorted
    .map((c) => `
      <tr>
        <td>${formatNumber(c.rank)}</td>
        <td>${escapeHtml(c.campaign_name ?? "—")}</td>
        <td>${escapeHtml(c.objective ?? "—")}</td>
        <td>${formatCurrency(c.spend)}</td>
        <td>${formatNumber(c.messages)}</td>
        <td>${formatCurrency(c.costPerMessage)}</td>
        <td>${formatPercent(c.ctr)}</td>
        <td>${formatNumber(Math.round(c.performanceScore))}</td>
      </tr>`)
    .join("");

  updateRankingSortHeaders();
}

function updateRankingSortHeaders() {
  document.querySelectorAll('#rankingTable th[data-key]').forEach((th) => {
    th.classList.toggle("sorted", th.dataset.key === rankingSortState.key);
    th.classList.toggle("asc", th.dataset.key === rankingSortState.key && rankingSortState.dir === "asc");
  });
}

function initRankingSort() {
  document.querySelectorAll('#rankingTable th[data-key]').forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (rankingSortState.key === key) {
        rankingSortState.dir = rankingSortState.dir === "asc" ? "desc" : "asc";
      } else {
        rankingSortState = { key, dir: "desc" };
      }
      renderRankingTable();
    });
  });
}

// Orchestrator matching the requested V5 function name.
function renderTables() {
  renderRankingTable();
}

// ---------------- MODEL PERFORMANCE RENDER ----------------

function renderModelPerformance() {
  const grid = document.getElementById("modelGrid");
  if (!grid) return;

  const models = calculateModelPerformance(currentYearFilter);
  if (models.length === 0) {
    grid.innerHTML = `<div class="model-card-empty">No campaign data for this period</div>`;
    return;
  }

  grid.innerHTML = models
    .map((m) => `
      <div class="model-card">
        <span class="model-card-name">${escapeHtml(m.model)}</span>
        <div class="model-card-metrics">
          <span>Spend<b>${formatCurrency(m.spend)}</b></span>
          <span>Messages<b>${formatNumber(m.messages)}</b></span>
          <span>Cost/Msg<b>${formatCurrency(m.costPerMessage)}</b></span>
          <span>CTR<b>${formatPercent(m.ctr)}</b></span>
        </div>
      </div>`)
    .join("");
}

// ---------------- OBJECTIVE COMPARISON RENDER ----------------

function renderObjectiveChart(objectives) {
  upsertChart("objectiveChart", "bar", {
    labels: objectives.map((o) => o.objective),
    datasets: [{
      data: objectives.map((o) => o.messages),
      backgroundColor: CHART_COLORS.primary,
      borderRadius: 4,
      maxBarThickness: 40,
    }],
  }, baseLineOptions());
}

function renderObjectiveComparison() {
  const objectives = calculateObjectiveComparison(currentYearFilter);
  const grid = document.getElementById("objectiveGrid");

  if (grid) {
    grid.innerHTML = objectives.length === 0
      ? `<div class="objective-card-empty">No campaign data for this period</div>`
      : objectives
          .map((o) => `
            <div class="objective-card">
              <span class="objective-card-name">${escapeHtml(o.objective)}</span>
              <div class="objective-card-metrics">
                <span>Spend<b>${formatCurrency(o.spend)}</b></span>
                <span>Messages<b>${formatNumber(o.messages)}</b></span>
                <span>Cost/Msg<b>${formatCurrency(o.costPerMessage)}</b></span>
                <span>CTR<b>${formatPercent(o.ctr)}</b></span>
              </div>
            </div>`)
          .join("");
  }

  renderObjectiveChart(objectives);
}

// ---------------- TIMELINE RENDER ----------------

function renderTimelineTrendChart() {
  const rows = getFilteredDailyRows(currentYearFilter);
  const byDate = {};

  rows.forEach((r) => {
    const date = r.date_meta;
    if (!date) return;
    if (!byDate[date]) byDate[date] = { spend: 0, messages: 0 };
    byDate[date].spend += Number(r.spend) || 0;
    byDate[date].messages += Number(r.messages) || 0;
  });

  const sortedDates = Object.keys(byDate).sort();
  const values = sortedDates.map((d) => byDate[d][currentTimelineMetric]);

  upsertChart("timelineTrendChart", "line", {
    labels: sortedDates,
    datasets: [{
      data: values,
      borderColor: currentTimelineMetric === "spend" ? CHART_COLORS.primary : CHART_COLORS.green,
      backgroundColor: currentTimelineMetric === "spend" ? "rgba(230,0,18,0.12)" : "rgba(46,204,113,0.12)",
      fill: true,
      tension: 0.3,
      pointRadius: 2,
    }],
  }, baseLineOptions());
}

function renderTimelineLaunches() {
  const el = document.getElementById("timelineLaunches");
  if (!el) return;

  const list = getFilteredCampaigns(currentYearFilter);
  if (list.length === 0) {
    el.innerHTML = `<div class="timeline-empty">No campaign launches for this period</div>`;
    return;
  }

  const sorted = [...list].sort((a, b) => new Date(a.start_date || 0) - new Date(b.start_date || 0));

  let lastYear = null;
  let html = "";
  sorted.forEach((c) => {
    const year = c.year ?? (c.start_date ? String(c.start_date).slice(0, 4) : "—");
    if (year !== lastYear) {
      html += `<div class="timeline-year-group">${escapeHtml(String(year))}</div>`;
      lastYear = year;
    }
    html += `
      <div class="timeline-item">
        <div class="timeline-item-main">
          <span class="timeline-item-name">${escapeHtml(c.campaign_name ?? "—")}</span>
          <span class="timeline-item-meta">${escapeHtml(c.start_date ?? "—")} → ${escapeHtml(c.end_date ?? "—")} · ${formatNumber(c.days_running)} days · ${escapeHtml(c.model ?? "Other")}</span>
        </div>
        <div class="timeline-item-stats"><b>${formatNumber(c.messages)}</b> msgs · ${formatPercent(c.ctr)} CTR</div>
      </div>`;
  });

  el.innerHTML = html;
}

function renderTimeline() {
  const isTrend = currentTimelineView === "trend";
  const trendCard = document.getElementById("timelineTrendCard");
  const launchesCard = document.getElementById("timelineLaunchesCard");
  if (trendCard) trendCard.hidden = !isTrend;
  if (launchesCard) launchesCard.hidden = isTrend;

  if (isTrend) {
    renderTimelineTrendChart();
  } else {
    renderTimelineLaunches();
  }
}

// Orchestrator matching the requested V5 function name — renders
// every Chart.js visual in the historical tabs. The individual
// render*() functions above already call the specific chart they
// need at the right moment (only once their tab is visible), so
// this is provided for completeness / manual re-render, not wired
// into the automatic load flow.
function renderCharts() {
  renderObjectiveChart(calculateObjectiveComparison(currentYearFilter));
  renderTimelineTrendChart();
}

// ---------------- MASTER RENDER ----------------

function renderAllHistoricalTabs() {
  if (!historyAvailable) return;
  renderHistoricalOverview();
  renderTables();
  renderModelPerformance();
  renderObjectiveComparison();
  generateRecommendations();
  renderTimeline();
}

// ---------------- TAB NAVIGATION ----------------

function initTabNav() {
  document.querySelectorAll(".tab-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab-nav-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.tabPanel === target);
      });

      // Re-render on activation so any Chart.js canvas that was
      // hidden (and therefore zero-size) at creation time gets
      // rebuilt at its correct dimensions.
      if (!historyAvailable) return;
      if (target === "historical") { renderHistoricalOverview(); renderTables(); }
      if (target === "model") renderModelPerformance();
      if (target === "objectives") renderObjectiveComparison();
      if (target === "recommendations") generateRecommendations();
      if (target === "timeline") renderTimeline();
    });
  });
}

// ---------------- YEAR FILTER ----------------

function initYearFilter() {
  document.querySelectorAll("#yearSwitch .year-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentYearFilter = btn.dataset.year;
      document.querySelectorAll("#yearSwitch .year-btn").forEach((b) => b.classList.toggle("active", b === btn));
      if (!historyAvailable) return;
      renderAllHistoricalTabs();
    });
  });
}

// ---------------- TIMELINE CONTROLS ----------------

function initTimelineControls() {
  document.querySelectorAll("#timelineViewSwitch .timeline-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTimelineView = btn.dataset.view;
      document.querySelectorAll("#timelineViewSwitch .timeline-btn").forEach((b) => b.classList.toggle("active", b === btn));
      if (historyAvailable) renderTimeline();
    });
  });

  document.querySelectorAll("#timelineMetricSwitch .timeline-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTimelineMetric = btn.dataset.metric;
      document.querySelectorAll("#timelineMetricSwitch .timeline-btn").forEach((b) => b.classList.toggle("active", b === btn));
      if (historyAvailable && currentTimelineView === "trend") renderTimelineTrendChart();
    });
  });
}

// ---------------- V5 INIT ----------------
// Independent of V4's init block above — runs alongside it, never
// replacing it. If dashboard-history.json never loads, Overview
// (already initialized above) is completely unaffected.

initTabNav();
initYearFilter();
initRankingSort();
initTimelineControls();
loadHistoricalData();
setInterval(loadHistoricalData, REFRESH_INTERVAL_MS);
