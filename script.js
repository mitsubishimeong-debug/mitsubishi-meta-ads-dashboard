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
