// ============================================================
// Mitsubishi Meta Ads AI Dashboard — script.js (v7 Enterprise)
// Reads everything from dashboard.json (auto-detects whether it
// lives beside index.html or inside a /data folder).
// n8n only ever needs to overwrite that file — no HTML/CSS
// changes required to reflect new numbers or new date ranges.
//
// v7 additions on top of v4/v5/v6 (script.js only — schema, IDs,
// HTML structure, and CSS are all unchanged; every v4/v5/v6
// function below is left in place and still does exactly what it
// did before):
//   - DOM element cache (getEl) to cut down repeated
//     getElementById lookups on every 60s render pass
//   - AI Health Score: a transparent, client-computed 0-100 score
//     derived from CTR / CPM / Cost-per-Message / Messages / Clicks
//     for the CURRENT overview range, with an Excellent / Good /
//     Needs Attention / Critical label and its own animated gauge
//   - Full rendering of reports/ai-analysis.json: adds metrics,
//     best_campaigns and worst_campaigns on top of the v6
//     executive_summary / winning_ads / creative_insights /
//     historical_insights / recommendations rendering — nothing
//     from that file is left un-rendered, nothing is hardcoded
//   - Additional Chart.js visuals: Historical CTR trend, Historical
//     Cost-per-Message trend, Monthly Performance trend, a Campaign
//     Ranking bar chart, and a Model Performance bar chart — all
//     built on the existing upsertChart() helper, so a canvas is
//     always destroyed before it's rebuilt and nothing ever stacks
//   - Every new render function is defensive: if the HTML doesn't
//     have the target id yet, the function is a silent no-op
//     (same pattern the v4 code already used for setText/animateKpi
//     etc.), so nothing here can throw or break Overview/Historical
//     if a given container hasn't been added to the page yet
//
// v7.1 CHANGE (this update, budget pacing only — everything else
// in this file is byte-for-byte identical to the previous version):
//   - dashboard.json's ranges.<range>.budget was replaced upstream
//     by ranges.<range>.budgetPacing = { active_campaigns,
//     allocated_daily_budget }. Backend/JSON structure is NOT
//     touched here — only the two spots below that read it:
//     1) the render() call site (Overview module)
//     2) the renderBudget() function itself (Budget Pacing section)
//   See the "CHANGED" comments at both spots for the exact diff.
//
// The file is still one flat script (no bundler/module system in
// this project), so "modules" below are organized as clearly
// commented sections — Utilities / Overview / Historical / AI /
// Charts / Table / Timeline — rather than separate files. Function
// names are unchanged from v4/v5/v6 so nothing that already
// references them (event listeners, other functions) breaks.
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
let prevKpiValues = {}; // last rendered numeric value per KPI id, for count-up animation
let rafHandles = {}; // in-flight animation frames per element id, so re-renders don't stack

// ============================================================
// ===================== UTILITIES MODULE ====================
// Shared helpers used by every other module below: DOM element
// caching, safe text/number setting, formatting, and escaping.
// ============================================================

// Simple memoized getElementById. The dashboard's HTML is static
// (no ids are added/removed at runtime), so it's safe to look an
// id up once and reuse the reference on every subsequent 60s
// render pass instead of re-querying the DOM each time. A miss
// (element not present in this build of the HTML) is cached too,
// as `null`, so repeated lookups for an id that doesn't exist stay
// O(1) instead of re-scanning the DOM tree every render.
function getEl(id) {
  if (!(id in domCache)) {
    domCache[id] = document.getElementById(id);
  }
  return domCache[id];
}
const domCache = {};

// ---------------- PATH DETECTION + LOAD ----------------

// dashboard.json lives in the repo root, beside index.html — this
// is a single direct fetch, resolved as a relative path against the
// page's own folder (works the same on GitHub Pages as locally).
async function fetchDashboardData() {
  // dashboard.json lives in the repo root next to index.html — no
  // data/ folder, so this is a single direct fetch with no fallback
  // probing. Cache-busting query param + no-store are kept so n8n's
  // overwrites are picked up on the very next 60s poll.
  const res = await fetch(`./dashboard.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} at ./dashboard.json`);
  }
  return res.json();
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
  const pill = getEl("liveStatus");
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

// ============================================================
// ===================== OVERVIEW MODULE ======================
// Renders dashboard.json for the currently selected range: KPI
// cards, deltas, budget pacing, funnel, top performers, the
// account-level recommendations/alerts lists, prediction, and the
// three trend charts + campaigns table that belong to Overview.
// ============================================================

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

  // CHANGED (v7.1): was `renderBudget(rangeData.budget)`.
  // dashboard.json now provides ranges.<range>.budgetPacing instead
  // of ranges.<range>.budget — same call site, new field name only.
  renderBudget(rangeData.budgetPacing);

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

  // v7 ADD: client-computed AI Health Score for the active range.
  // Purely additive — no-ops safely if the optional gauge markup
  // isn't present in this build of the HTML (see function below).
  renderAIHealthScore(rangeData);
}

function setText(id, value) {
  const el = getEl(id);
  if (el) el.textContent = value ?? "—";
}

// ---------------- ANIMATED KPI VALUES ----------------

// Eases from whatever was last displayed to the new numeric value,
// re-formatting on every frame with the same formatter used at
// rest (formatCurrency/formatNumber/formatPercent), so it never
// drifts from the non-animated formatting rules. Non-numeric or
// missing values skip the animation and just show "—" immediately.
function animateKpi(id, rawValue, formatter) {
  const el = getEl(id);
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
  const el = getEl(id);
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
// CHANGED (v7.1): this function used to take `budget` shaped as
// { spent, daily } and render a filled progress bar + "spent / daily"
// readout. dashboard.json now provides `budgetPacing` shaped as
// { active_campaigns, allocated_daily_budget } instead — there is no
// "spent" figure anymore, so the fill bar has nothing to measure a
// percentage against and is simply kept at 0% (element left in place,
// layout untouched). The readout now shows:
//   "<active_campaigns> Active Campaigns • <allocated_daily_budget> Daily Budget"
// Field names (active_campaigns / allocated_daily_budget) are read
// exactly as n8n writes them — not renamed on the frontend.
function renderBudget(budgetPacing) {
  const fill = getEl("budgetFill");

  if (!budgetPacing || typeof budgetPacing !== "object") {
    if (fill) fill.style.width = "0%";
    setText("budgetReadout", "—");
    return;
  }

  const activeCampaigns = Number(budgetPacing.active_campaigns) || 0;
  const allocatedDailyBudget = Number(budgetPacing.allocated_daily_budget) || 0;

  // No "spent vs daily" ratio exists in this schema anymore, so the
  // bar no longer represents a percentage — left at 0% rather than
  // removed, so the surrounding layout/markup is untouched.
  if (fill) fill.style.width = "0%";

  setText(
    "budgetReadout",
    `${formatNumber(activeCampaigns)} Active Campaign${activeCampaigns === 1 ? "" : "s"} • ${formatCurrency(allocatedDailyBudget)} Daily Budget`
  );
}

// ---------------- FUNNEL ----------------

function renderFunnel(funnel) {
  const el = getEl("funnelRow");
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
  const el = getEl(containerId);
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

// ---------------- GAUGE (account health, server-computed) ----------------

function animateGauge(rawScore) {
  const CIRCUMFERENCE = 251;
  const score = Number(rawScore);
  const safeScore = isNaN(score) ? 0 : score;
  const pct = Math.max(0, Math.min(100, safeScore)) / 100;
  const offset = CIRCUMFERENCE - CIRCUMFERENCE * pct;

  const fill = getEl("gaugeFill");
  if (fill) fill.style.strokeDashoffset = offset;

  let color = CHART_COLORS.green;
  if (safeScore < 50) color = "#E60012";
  else if (safeScore < 80) color = "#F5A623";
  if (fill) fill.style.stroke = color;

  animateNumber("healthScore", safeScore);
}

function animateNumber(id, target) {
  const el = getEl(id);
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

// ---------------- AI HEALTH SCORE (v7 addition, client-computed) ----------------
// This is a SEPARATE, transparent score from currentData.accountHealth
// above (which comes pre-computed from n8n/dashboard.json). This one
// is computed here in the browser from five inputs — CTR, CPM, Cost
// per Message, Messages, Clicks — for the currently selected Overview
// range, exactly as requested. It's a weighted heuristic, not a
// model prediction, so the math is kept simple and documented inline.
//
// Optional markup (all guarded — if any id is missing nothing breaks):
//   #aiHealthScoreValue   — numeric 0-100 readout (animated count-up)
//   #aiHealthScoreLabel   — "Excellent" / "Good" / "Needs Attention" / "Critical"
//   #aiHealthGaugeFill    — an SVG <circle> stroke, same ring pattern as #gaugeFill
// If your HTML doesn't have these ids yet, add a small ring + two
// spans with these ids anywhere on the Overview tab and this section
// will start rendering into them on the very next 60s refresh — no
// other code changes required.
function calculateAIHealthScore(rangeData) {
  if (!rangeData || typeof rangeData !== "object") return 0;

  const ctr = Number(rangeData.ctr) || 0; // percent, e.g. 2.4
  const cpm = Number(rangeData.cpm) || 0; // currency
  const costPerMessage = Number(rangeData.costPerMessage) || 0; // currency
  const messages = Number(rangeData.messages) || 0;
  const clicks = Number(rangeData.clicks) || 0;

  // Each sub-score is normalized to 0-100 against a reasonable
  // benchmark for Meta lead-gen/messaging campaigns, then clamped.
  // CTR: 3%+ CTR scores full marks; 0% scores 0.
  const ctrScore = clamp01(ctr / 3) * 100;

  // CPM: lower is better. ₱300 CPM or below scores full marks;
  // ₱900+ scores 0. (No CPM data at all is treated as neutral (50)
  // rather than penalizing, since some accounts don't report it.)
  const cpmScore = cpm > 0 ? clamp01(1 - (cpm - 300) / 600) * 100 : 50;

  // Cost per message: lower is better. ₱50 or below is full marks;
  // ₱250+ is 0.
  const costScore = costPerMessage > 0 ? clamp01(1 - (costPerMessage - 50) / 200) * 100 : 50;

  // Volume signals (messages, clicks) are scored on a log curve so
  // a campaign doesn't need thousands of messages to score well —
  // diminishing returns kick in the same way real performance
  // reviews treat volume.
  const messagesScore = clamp01(Math.log10(messages + 1) / Math.log10(201)) * 100; // 200 msgs ≈ full marks
  const clicksScore = clamp01(Math.log10(clicks + 1) / Math.log10(2001)) * 100; // 2000 clicks ≈ full marks

  // Weighted blend — CTR and cost-per-message are the strongest
  // day-to-day signals of ad quality, so they carry the most weight.
  const weighted =
    ctrScore * 0.3 +
    costScore * 0.3 +
    cpmScore * 0.15 +
    messagesScore * 0.15 +
    clicksScore * 0.1;

  return Math.max(0, Math.min(100, Math.round(weighted)));
}

function clamp01(n) {
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function getHealthScoreLabel(score) {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Needs Attention";
  return "Critical";
}

function getHealthScoreColor(score) {
  if (score >= 80) return CHART_COLORS.green;
  if (score >= 60) return "#8BC34A";
  if (score >= 40) return CHART_COLORS.amber;
  return CHART_COLORS.primary;
}

function renderAIHealthScore(rangeData) {
  const valueEl = getEl("aiHealthScoreValue");
  const labelEl = getEl("aiHealthScoreLabel");
  const fillEl = getEl("aiHealthGaugeFill");

  // Nothing to render into — no-op, same defensive pattern as
  // every other render*() function in this file.
  if (!valueEl && !labelEl && !fillEl) return;

  const score = calculateAIHealthScore(rangeData);
  const color = getHealthScoreColor(score);

  if (labelEl) {
    labelEl.textContent = getHealthScoreLabel(score);
    labelEl.style.color = color;
  }

  if (fillEl) {
    const CIRCUMFERENCE = 251; // same ring geometry as the main #gaugeFill
    const pct = score / 100;
    const offset = CIRCUMFERENCE - CIRCUMFERENCE * pct;
    fillEl.style.strokeDashoffset = offset;
    fillEl.style.stroke = color;
  }

  if (valueEl) animateNumber("aiHealthScoreValue", score);
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

// ============================================================
// ====================== CHARTS MODULE ========================
// Every Chart.js visual in the dashboard is built through
// upsertChart(), which always destroys any previous chart on a
// given canvas before creating a new one — so no range switch,
// tab switch, or 60s refresh can ever leave stacked/duplicate
// charts behind, no matter how many times render() runs.
// ============================================================

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
// v7: also no-ops cleanly (and cheaply, via getEl's cached miss) if
// the canvas id isn't present in this build of the HTML, which is
// what lets the new v7 chart functions below be purely additive.
function upsertChart(canvasId, type, data, options) {
  if (typeof Chart === "undefined") return;
  const canvas = getEl(canvasId);
  if (!canvas) return;

  if (charts[canvasId]) {
    charts[canvasId].destroy();
    delete charts[canvasId];
  }

  charts[canvasId] = new Chart(canvas.getContext("2d"), { type, data, options });
}

// ============================================================
// ===================== TABLE MODULE ==========================
// Builds the whole tbody as one HTML string and writes it once —
// keeps rendering fast even at 100+ rows, since the browser only
// has to do a single reflow instead of one per row, for both the
// Overview campaigns table and the Historical ranking table below.
// ============================================================

function renderCampaignsTable(campaigns) {
  const tbody = getEl("campaignsTableBody");
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
  const btn = getEl("exportBtn");
  if (!btn) return;
  btn.addEventListener("click", () => window.print());
}

// ---------------- INIT (v4 Overview) ----------------

initRangeSwitch();
initTableSorting();
initExport();
loadDashboard();
setInterval(loadDashboard, REFRESH_INTERVAL_MS); // v6 note: setInterval only — the page itself is never reloaded

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

// ============================================================
// ==================== HISTORICAL MODULE ======================
// Everything below (until the AI MODULE section) reads only from
// dashboard-history.json: path detection/load, processing into
// processedCampaigns/dailyPerformance, and the Historical / Model
// Performance / Objective Comparison / Timeline tab renderers.
// ============================================================

// ---------------- PATH DETECTION + LOAD (mirrors fetchDashboardData) ----------------

async function fetchHistoryData() {
  // dashboard-history.json lives in the repo root, beside index.html —
  // single direct fetch, no data/ folder, no fallback probing.
  //
  // One short retry is included because this file is large (40KB+)
  // and gets overwritten by n8n periodically — an occasional poll
  // can land mid-write (partial/invalid JSON) or hit GitHub Pages'
  // edge cache mid-propagation right after a commit. A single retry
  // after a brief pause almost always lands on the settled file.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`./dashboard-history.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} at ./dashboard-history.json`);
      return await res.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
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
    // Only show the "unavailable" empty state if we've never
    // successfully loaded historical data. If a previous poll
    // already succeeded, keep showing that last-known-good data
    // instead of flashing the empty state over working numbers on
    // a single transient failure — the next 60s poll will refresh
    // it automatically once the source file settles.
    if (!historyData) {
      processedCampaigns = [];
      dailyPerformance = [];
      setHistoryAvailability(false);
    }
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
  loadAIAnalysis(); // MODIFY: V6 — added third independent source
}

// ============================================================
// ======================== AI MODULE ===========================
// Renders reports/ai-analysis.json end-to-end: executive_summary,
// metrics, best_campaigns, worst_campaigns, winning_ads,
// creative_insights, historical_insights, and recommendations.
// Entirely independent of dashboard.json and dashboard-history.json
// — a failure here never affects Overview or the Historical/Model/
// Objectives/Timeline tabs, and vice versa.
// ============================================================
// ADD: entirely new, independent pipeline — its own state, its own
// fetch, its own availability flag. Never touches dashboard.json or
// dashboard-history.json, and a failure here never affects Overview
// or the Historical/Model/Objectives/Timeline tabs.

let aiData = {};
let aiAvailable = false;

async function fetchAIAnalysis() {
  // MODIFY (bugfix): this fetch previously had no retry, unlike
  // fetchHistoryData() above. reports/ai-analysis.json is written by
  // the same n8n run that overwrites dashboard-history.json, so it's
  // exposed to the exact same failure window — a poll landing mid-
  // write, or hitting GitHub Pages' CDN mid-propagation right after a
  // commit. Mirrors fetchHistoryData()'s one-retry-after-a-pause
  // pattern so a single transient miss doesn't flip the whole
  // Recommendations tab to "unavailable" when the file is actually fine.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`./reports/ai-analysis.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} at ./reports/ai-analysis.json`);
      return await res.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
}

async function loadAIAnalysis() {
  try {
    const data = await fetchAIAnalysis();
    aiData = data || {};
    setAIAvailability(true);
    renderAIAnalysis();
  } catch (err) {
    console.warn("AI analysis unavailable:", err.message);
    // MODIFY (bugfix): only blank the tab out on the very first load
    // failure. If a previous poll already succeeded, keep showing
    // that last-known-good data instead of flashing "unavailable"
    // over working numbers on a single transient miss — same pattern
    // loadHistoricalData() already uses for dashboard-history.json.
    if (!aiData || Object.keys(aiData).length === 0) {
      aiData = {};
      setAIAvailability(false);
    }
  }
}

// Shows "AI analysis unavailable" in the Recommendations tab and
// hides its content sections when reports/ai-analysis.json can't be
// loaded. Independent of setHistoryAvailability() — Overview and the
// Historical/Model/Objectives/Timeline tabs are unaffected either way.
function setAIAvailability(isAvailable) {
  aiAvailable = isAvailable;

  const emptyEl = getEl("recommendationsEmptyState");
  if (emptyEl) emptyEl.hidden = isAvailable;

  document
    .querySelectorAll('[data-tab-panel="recommendations"] > section')
    .forEach((sec) => { sec.hidden = !isAvailable; });
}

// ---------------- AVAILABILITY / FALLBACK ----------------

// Shows "Historical data unavailable" in the Historical/Model/
// Objectives/Timeline tabs and hides their content sections when
// dashboard-history.json can't be loaded — Overview keeps working
// normally regardless.
// MODIFY: "recommendationsEmptyState" and the Recommendations
// panel's <section>s are no longer governed by this function —
// that tab now depends on reports/ai-analysis.json instead of
// dashboard-history.json, so its availability is controlled by
// setAIAvailability() below.
function setHistoryAvailability(isAvailable) {
  historyAvailable = isAvailable;

  ["historicalEmptyState", "modelEmptyState", "objectivesEmptyState", "timelineEmptyState"]
    .forEach((id) => {
      const el = getEl(id);
      if (el) el.hidden = isAvailable;
    });

  ["historicalContent", "timelineContent"].forEach((id) => {
    const el = getEl(id);
    if (el) el.hidden = !isAvailable;
  });

  document
    .querySelectorAll('[data-tab-panel="model"] > section, [data-tab-panel="objectives"] > section')
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

// ---------------- MODULE 5: AI ANALYSIS (reports/ai-analysis.json) ----------------
// MODIFY: This module previously computed recommendations from
// historyData's campaign aggregates. It no longer calculates
// anything — it only renders whatever Gemini/n8n already wrote to
// aiData. historyData and dashboard.json are never read here.

// MODIFY: generateRecommendations() renders aiData.recommendations
// directly. No computation, no fallback rules — if aiData has no
// recommendations, the list simply shows its built-in empty state.
function generateRecommendations() {
  const items = Array.isArray(aiData?.recommendations) ? aiData.recommendations : [];
  renderReasonedList("histRecList", items, "rec");
}

// ADD
function renderExecutiveSummary() {
  const el = getEl("execSummary");
  if (!el) return;
  const summary = aiData?.executive_summary;
  el.textContent = summary ? String(summary) : "—";
}

// ADD
// Schema assumption (adjust field names once the real n8n output is
// confirmed): aiData.winning_ads is an array of objects such as
// { ad_name, reason, ctr, messages }. Falls back gracefully if any
// field is missing rather than crashing.
function renderWinningAds() {
  const ads = Array.isArray(aiData?.winning_ads) ? aiData.winning_ads : [];
  const items = ads.map((ad) => ({
    text: ad.ad_name ?? ad.name ?? "—",
    reason: ad.reason ?? [
      ad.ctr !== undefined ? `${formatPercent(ad.ctr)} CTR` : null,
      ad.messages !== undefined ? `${formatNumber(ad.messages)} messages` : null,
    ].filter(Boolean).join(" · "),
    priority: ad.priority ?? null,
  }));
  renderReasonedList("winningAdsList", items, "rec");
}

// ADD
function renderCreativeInsights() {
  const items = Array.isArray(aiData?.creative_insights) ? aiData.creative_insights : [];
  renderReasonedList("creativeInsightsList", items, "rec");
}

// ADD
function renderHistoricalAIInsights() {
  const items = Array.isArray(aiData?.historical_insights) ? aiData.historical_insights : [];
  renderReasonedList("historicalInsightsList", items, "rec");
}

// v7 ADD — renders aiData.metrics (an object of top-level KPI
// key/value pairs written by n8n, e.g. { avg_ctr: 2.4, total_spend:
// 84210, ... }). Nothing here is hardcoded: whatever keys exist in
// the object are turned into cards, in the order n8n wrote them, so
// adding/removing a metric on the n8n side needs no script.js change.
// Numeric-looking values are formatted as numbers; everything else
// (already-formatted strings from n8n, like "2.4%") is shown as-is.
// Container: #aiMetricsGrid (guarded — no-op if not present).
function renderAIMetrics() {
  const grid = getEl("aiMetricsGrid");
  if (!grid) return;

  const metrics = aiData?.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics) || Object.keys(metrics).length === 0) {
    grid.innerHTML = `<div class="model-card-empty">No AI metrics available</div>`;
    return;
  }

  const html = Object.entries(metrics)
    .map(([key, rawValue]) => {
      const label = labelizeKey(key);
      const numeric = Number(rawValue);
      const display = rawValue !== null && rawValue !== "" && !isNaN(numeric) && typeof rawValue !== "string"
        ? formatNumber(numeric)
        : escapeHtml(String(rawValue ?? "—"));
      return `
        <div class="model-card">
          <span class="model-card-name">${escapeHtml(label)}</span>
          <div class="model-card-metrics">
            <span><b>${display}</b></span>
          </div>
        </div>`;
    })
    .join("");

  grid.innerHTML = html;
}

// Turns a snake_case / camelCase JSON key into a readable label,
// e.g. "avg_cost_per_message" -> "Avg Cost Per Message".
function labelizeKey(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// v7 ADD — renders aiData.best_campaigns and aiData.worst_campaigns.
// Schema assumption (adjust once the real n8n output is confirmed):
// each entry is an object such as { campaign_name, reason, spend,
// messages, ctr, cost_per_message }. Falls back gracefully field by
// field rather than crashing on a missing key.
// Containers: #bestCampaignsList / #worstCampaignsList (guarded).
function renderCampaignInsightCards(containerId, items) {
  const el = getEl(containerId);
  if (!el) return;

  const list = Array.isArray(items) ? items.filter((i) => i) : [];
  if (list.length === 0) {
    el.innerHTML = `<li style="opacity:0.5;">No data available</li>`;
    return;
  }

  const html = list
    .map((c) => {
      const name = c.campaign_name ?? c.name ?? "—";
      const reason = c.reason ?? null;
      const statLine = [
        c.spend !== undefined ? formatCurrency(c.spend) + " spend" : null,
        c.messages !== undefined ? formatNumber(c.messages) + " messages" : null,
        c.ctr !== undefined ? formatPercent(c.ctr) + " CTR" : null,
        c.cost_per_message !== undefined ? formatCurrency(c.cost_per_message) + "/msg" : null,
      ].filter(Boolean).join(" · ");

      return `
        <li>
          <div class="item-head">
            <span class="item-title">${escapeHtml(name)}</span>
          </div>
          ${statLine ? `<span class="item-reason">${escapeHtml(statLine)}</span>` : ""}
          ${reason ? `<span class="item-reason">${escapeHtml(reason)}</span>` : ""}
        </li>`;
    })
    .join("");

  el.innerHTML = html;
}

function renderBestWorstCampaigns() {
  renderCampaignInsightCards("bestCampaignsList", aiData?.best_campaigns);
  renderCampaignInsightCards("worstCampaignsList", aiData?.worst_campaigns);
}

// ADD — orchestrator for the whole Recommendations tab
// v7 MODIFY: now also renders metrics and best/worst campaigns so
// every field in reports/ai-analysis.json is displayed somewhere —
// nothing from that file is left un-rendered.
function renderAIAnalysis() {
  if (!aiAvailable) return;
  renderExecutiveSummary();
  renderAIMetrics();
  renderBestWorstCampaigns();
  generateRecommendations();
  renderWinningAds();
  renderCreativeInsights();
  renderHistoricalAIInsights();
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

  // v7 ADD: historical trend charts. Each is independently guarded
  // (see CHARTS MODULE additions below) so a missing canvas id just
  // means that one chart is skipped — everything else above still
  // renders exactly as it did in v6.
  renderHistoricalCtrChart();
  renderHistoricalCostChart();
  renderMonthlyTrendChart();
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
  const tbody = getEl("rankingTableBody");
  if (!tbody) return;

  const ranked = calculateCampaignRanking(currentYearFilter);

  if (ranked.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;opacity:0.5;">No campaign data for this period</td></tr>`;
    updateRankingSortHeaders();
    renderCampaignRankingChart([]);
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

  // v7 ADD: bar chart mirror of this table (top 12 by rank), guarded.
  renderCampaignRankingChart(ranked);
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
  const grid = getEl("modelGrid");
  const models = calculateModelPerformance(currentYearFilter);

  if (grid) {
    grid.innerHTML = models.length === 0
      ? `<div class="model-card-empty">No campaign data for this period</div>`
      : models
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

  // v7 ADD: bar chart mirror of the model cards, guarded.
  renderModelPerformanceChart(models);
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
  const grid = getEl("objectiveGrid");

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

// ============================================================
// v7 ADD — ADDITIONAL HISTORICAL CHARTS
// Historical CTR trend, Historical Cost-per-Message trend, Monthly
// Performance trend, Campaign Ranking bar chart, and Model
// Performance bar chart. All go through upsertChart() (destroy
// before create) and all no-op safely if their canvas id isn't in
// the current HTML — none of this can affect the charts that
// already existed in v4/v5/v6 (spendChart, ctrChart, messagesChart,
// rankingChart, objectiveChart), which are untouched above.
//
// Optional canvas ids used here (add to the Historical/Timeline
// tab markup whenever convenient — nothing above depends on them
// existing yet):
//   #historicalCtrChart      — line: CTR over time, filtered by year
//   #historicalCostChart     — line: cost-per-message over time
//   #monthlyTrendChart       — bar: spend by month, filtered by year
//   #campaignRankingChart    — bar: top 12 campaigns by performanceScore
//   #modelPerformanceChart   — bar: spend by model
// ============================================================

// Historical CTR trend — reuses dailyPerformance rows (daily
// granularity, same source as the existing Timeline "trend" view)
// but plots CTR (clicks/impressions) instead of spend/messages.
function renderHistoricalCtrChart() {
  const canvas = getEl("historicalCtrChart");
  if (!canvas) return;

  const rows = getFilteredDailyRows(currentYearFilter);
  const byDate = {};
  rows.forEach((r) => {
    const date = r.date_meta;
    if (!date) return;
    if (!byDate[date]) byDate[date] = { clicks: 0, impressions: 0 };
    byDate[date].clicks += Number(r.clicks) || 0;
    byDate[date].impressions += Number(r.impressions) || 0;
  });

  const sortedDates = Object.keys(byDate).sort();
  const ctrValues = sortedDates.map((d) => {
    const day = byDate[d];
    return day.impressions > 0 ? (day.clicks / day.impressions) * 100 : 0;
  });

  upsertChart("historicalCtrChart", "line", {
    labels: sortedDates,
    datasets: [{
      data: ctrValues,
      borderColor: CHART_COLORS.green,
      backgroundColor: "rgba(46,204,113,0.12)",
      fill: true,
      tension: 0.3,
      pointRadius: 2,
    }],
  }, baseLineOptions());
}

// Historical Cost-per-Message trend — same daily rows, plots
// spend/messages per day so cost efficiency over time is visible
// at a glance next to the CTR trend above.
function renderHistoricalCostChart() {
  const canvas = getEl("historicalCostChart");
  if (!canvas) return;

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
  const costValues = sortedDates.map((d) => {
    const day = byDate[d];
    return day.messages > 0 ? day.spend / day.messages : 0;
  });

  upsertChart("historicalCostChart", "line", {
    labels: sortedDates,
    datasets: [{
      data: costValues,
      borderColor: CHART_COLORS.amber,
      backgroundColor: "rgba(245,166,35,0.12)",
      fill: true,
      tension: 0.3,
      pointRadius: 2,
    }],
  }, baseLineOptions());
}

// Monthly Performance trend — aggregates the same daily rows up to
// month granularity (YYYY-MM) so long date ranges (multi-year) stay
// readable instead of showing hundreds of daily points.
function renderMonthlyTrendChart() {
  const canvas = getEl("monthlyTrendChart");
  if (!canvas) return;

  const rows = getFilteredDailyRows(currentYearFilter);
  const byMonth = {};
  rows.forEach((r) => {
    const date = r.date_meta;
    if (!date) return;
    const month = String(date).slice(0, 7); // YYYY-MM
    if (!byMonth[month]) byMonth[month] = { spend: 0, messages: 0 };
    byMonth[month].spend += Number(r.spend) || 0;
    byMonth[month].messages += Number(r.messages) || 0;
  });

  const sortedMonths = Object.keys(byMonth).sort();
  const spendValues = sortedMonths.map((m) => byMonth[m].spend);
  const messagesValues = sortedMonths.map((m) => byMonth[m].messages);

  upsertChart("monthlyTrendChart", "bar", {
    labels: sortedMonths,
    datasets: [
      {
        label: "Spend",
        data: spendValues,
        backgroundColor: CHART_COLORS.primary,
        borderRadius: 3,
        maxBarThickness: 24,
        yAxisID: "y",
      },
      {
        label: "Messages",
        data: messagesValues,
        backgroundColor: CHART_COLORS.green,
        borderRadius: 3,
        maxBarThickness: 24,
        yAxisID: "y1",
      },
    ],
  }, {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 650, easing: "easeOutCubic" },
    plugins: { legend: { display: true, labels: { color: CHART_COLORS.text, font: { size: 10 } } } },
    scales: {
      x: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
      y: { position: "left", grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
      y1: { position: "right", grid: { display: false }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
    },
  });
}

// Campaign Ranking chart — bar-chart mirror of the Historical
// ranking table, capped at the top 12 by performanceScore so labels
// stay legible even when there are 100+ campaigns in the period.
function renderCampaignRankingChart(ranked) {
  const canvas = getEl("campaignRankingChart");
  if (!canvas) return;

  const top = [...(Array.isArray(ranked) ? ranked : [])]
    .sort((a, b) => (b.performanceScore || 0) - (a.performanceScore || 0))
    .slice(0, 12);

  upsertChart("campaignRankingChart", "bar", {
    labels: top.map((c) => c.campaign_name ?? "—"),
    datasets: [{
      data: top.map((c) => Math.round(c.performanceScore) || 0),
      backgroundColor: CHART_COLORS.primary,
      borderRadius: 3,
      maxBarThickness: 22,
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

// Model Performance chart — bar-chart mirror of the Model
// Performance cards, plotting spend per model.
function renderModelPerformanceChart(models) {
  const canvas = getEl("modelPerformanceChart");
  if (!canvas) return;

  const safeModels = Array.isArray(models) ? models : [];

  upsertChart("modelPerformanceChart", "bar", {
    labels: safeModels.map((m) => m.model),
    datasets: [{
      data: safeModels.map((m) => m.spend),
      backgroundColor: CHART_COLORS.green,
      borderRadius: 4,
      maxBarThickness: 34,
    }],
  }, baseLineOptions());
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
  const el = getEl("timelineLaunches");
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
  const trendCard = getEl("timelineTrendCard");
  const launchesCard = getEl("timelineLaunchesCard");
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
// v7 MODIFY: now also re-renders the additional v7 charts, so a
// manual call to renderCharts() refreshes everything Historical
// owns, not just the original two.
function renderCharts() {
  renderObjectiveChart(calculateObjectiveComparison(currentYearFilter));
  renderTimelineTrendChart();
  renderHistoricalCtrChart();
  renderHistoricalCostChart();
  renderMonthlyTrendChart();
  renderCampaignRankingChart(calculateCampaignRanking(currentYearFilter));
  renderModelPerformanceChart(calculateModelPerformance(currentYearFilter));
}

// ---------------- MASTER RENDER ----------------

function renderAllHistoricalTabs() {
  // MODIFY: generateRecommendations()/AI panels removed from here —
  // Recommendations now belongs to the independent AI pipeline
  // (renderAIAnalysis(), triggered by loadAIAnalysis()), not to
  // dashboard-history.json's load cycle.
  if (!historyAvailable) return;
  renderHistoricalOverview();
  renderTables();
  renderModelPerformance();
  renderObjectiveComparison();
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
      // MODIFY: "recommendations" now checks aiAvailable and calls
      // renderAIAnalysis() — it no longer depends on historyAvailable.
      if (target === "recommendations") { if (aiAvailable) renderAIAnalysis(); return; }
      if (!historyAvailable) return;
      if (target === "historical") { renderHistoricalOverview(); renderTables(); }
      if (target === "model") renderModelPerformance();
      if (target === "objectives") renderObjectiveComparison();
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
loadAIAnalysis(); // ADD
setInterval(loadAIAnalysis, REFRESH_INTERVAL_MS); // ADD — never reloads the page, only re-fetches JSON
setInterval(loadHistoricalData, REFRESH_INTERVAL_MS); // never reloads the page, only re-fetches JSON
