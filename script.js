// ============================================================
// Mitsubishi Meta Ads AI Dashboard — script.js (v2)
// Reads everything from data/dashboard.json.
// n8n only ever needs to overwrite that file — no HTML/CSS/JS
// changes required to reflect new numbers or new date ranges.
// ============================================================

const DATA_URL = "data/dashboard.json";
const REFRESH_INTERVAL_MS = 60000; // poll every 60s for n8n updates

const CHART_COLORS = {
  primary: "#E60012",
  green: "#2ECC71",
  amber: "#F5A623",
  grid: "#2C2C2C",
  text: "#AAAAAA",
};

Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.color = CHART_COLORS.text;

let charts = {};
let currentData = null;
let currentRange = "today";
let sortState = { key: "spend", dir: "desc" };

// ---------------- LOAD ----------------

async function loadDashboard() {
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentData = data;
    currentRange = data.activeRange || "today";
    syncRangeButtons();
    render();
    setStatus(true);
  } catch (err) {
    console.error("Failed to load dashboard.json:", err);
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

// ---------------- RENDER ----------------

function render() {
  if (!currentData) return;
  const rangeData = currentData.ranges?.[currentRange];
  if (!rangeData) return;

  setText("reportDate", currentData.reportDate ?? "—");
  setText("lastUpdated", `Last updated ${new Date().toLocaleTimeString()}`);

  animateGauge(currentData.accountHealth ?? 0);

  // KPI cards + deltas
  setText("kpiSpend", formatCurrency(rangeData.spend));
  setText("kpiMessages", formatNumber(rangeData.messages));
  setText("kpiCtr", formatPercent(rangeData.ctr));
  setText("kpiCpc", formatCurrency(rangeData.cpc));
  setText("kpiCpm", formatCurrency(rangeData.cpm));
  setText("kpiCostMsg", formatCurrency(rangeData.costPerMessage));

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
  setText("topCampaignRec", rangeData.bestCampaignRecommendation ?? "SCALE");
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
  if (el) el.textContent = value;
}

// ---------------- DELTAS ----------------

function renderDelta(id, value, invert = false) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value === undefined || value === null) {
    el.textContent = "";
    el.className = "delta";
    return;
  }
  const isUp = value > 0;
  const isFlat = value === 0;
  // for cost metrics (CPC/CPM/Cost per message), a drop is good -> invert coloring
  let cls = "flat";
  if (!isFlat) {
    const good = invert ? !isUp : isUp;
    cls = good ? "up" : "down";
  }
  const arrow = isFlat ? "→" : isUp ? "▲" : "▼";
  el.textContent = `${arrow} ${Math.abs(value).toFixed(1)}%`;
  el.className = `delta ${cls}`;
}

// ---------------- BUDGET PACING ----------------

function renderBudget(budget) {
  if (!budget) return;
  const pct = Math.min(100, (budget.spent / budget.daily) * 100);
  const fill = document.getElementById("budgetFill");
  if (fill) fill.style.width = `${pct}%`;
  setText("budgetReadout", `${formatCurrency(budget.spent)} / ${formatCurrency(budget.daily)} (${pct.toFixed(0)}%)`);
}

// ---------------- FUNNEL ----------------

function renderFunnel(funnel) {
  const el = document.getElementById("funnelRow");
  if (!el || !funnel) return;

  const stages = [
    { label: "Impressions", value: funnel.impressions },
    { label: "Reach", value: funnel.reach },
    { label: "Clicks", value: funnel.clicks },
    { label: "Messages", value: funnel.messages },
    { label: "Conversions", value: funnel.conversions },
  ];

  el.innerHTML = "";
  stages.forEach((stage, i) => {
    const pctOfPrev = i > 0 && stages[i - 1].value
      ? ((stage.value / stages[i - 1].value) * 100).toFixed(1) + "%"
      : "";

    const div = document.createElement("div");
    div.className = "funnel-stage";
    div.innerHTML = `
      <span class="funnel-stage-value">${formatNumber(stage.value)}</span>
      <span class="funnel-stage-label">${stage.label}</span>
      ${pctOfPrev ? `<span class="funnel-stage-pct">${pctOfPrev}</span>` : ""}
    `;
    el.appendChild(div);

    if (i < stages.length - 1) {
      const arrow = document.createElement("span");
      arrow.className = "funnel-arrow";
      arrow.textContent = "›";
      el.appendChild(arrow);
    }
  });
}

// ---------------- RECOMMENDATIONS / ALERTS ----------------

function renderReasonedList(containerId, items, type) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = "";

  if (!items || items.length === 0) {
    const li = document.createElement("li");
    li.textContent = type === "alert" ? "No alerts" : "No recommendations";
    li.style.opacity = "0.5";
    el.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const text = typeof item === "string" ? item : item.text;
    const reason = typeof item === "string" ? null : item.reason;
    const priority = typeof item === "string" ? null : item.priority;

    const li = document.createElement("li");
    li.innerHTML = `
      <div class="item-head">
        <span class="item-title">${text}</span>
        ${priority ? `<span class="priority-badge priority-${priority}">${priority}</span>` : ""}
      </div>
      ${reason ? `<span class="item-reason">${reason}</span>` : ""}
    `;
    el.appendChild(li);
  });
}

// ---------------- GAUGE ----------------

function animateGauge(score) {
  const CIRCUMFERENCE = 251;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const offset = CIRCUMFERENCE - CIRCUMFERENCE * pct;

  const fill = document.getElementById("gaugeFill");
  if (fill) fill.style.strokeDashoffset = offset;

  let color = CHART_COLORS.green;
  if (score < 50) color = "#E60012";
  else if (score < 80) color = "#F5A623";
  if (fill) fill.style.stroke = color;

  animateNumber("healthScore", score);
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const duration = 900;
  const start = performance.now();

  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---------------- FORMATTERS ----------------

function formatCurrency(n) {
  if (n === undefined || n === null) return "—";
  return `₱${Number(n).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;
}
function formatNumber(n) {
  if (n === undefined || n === null) return "—";
  return Number(n).toLocaleString("en-PH");
}
function formatPercent(n) {
  if (n === undefined || n === null) return "—";
  return `${Number(n).toFixed(2)}%`;
}

// ---------------- CHARTS ----------------

function baseLineOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
      y: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
    },
  };
}

function renderTrendCharts(trends) {
  if (!trends) return;
  const labels = trends.labels ?? [];

  upsertChart("spendChart", "line", {
    labels,
    datasets: [{
      data: trends.spend ?? [],
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
      data: trends.ctr ?? [],
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
      data: trends.messages ?? [],
      backgroundColor: CHART_COLORS.amber,
      borderRadius: 3,
      maxBarThickness: 28,
    }],
  }, baseLineOptions());
}

function renderRankingChart(campaigns) {
  if (!campaigns) return;
  const sorted = [...campaigns].sort((a, b) => b.messages - a.messages);
  const labels = sorted.map((c) => c.name);
  const messages = sorted.map((c) => c.messages);

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
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
      y: { grid: { display: false }, ticks: { color: CHART_COLORS.text, font: { size: 10 } } },
    },
  });
}

function upsertChart(canvasId, type, data, options) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (charts[canvasId]) {
    charts[canvasId].data = data;
    charts[canvasId].update();
    return;
  }
  charts[canvasId] = new Chart(canvas.getContext("2d"), { type, data, options });
}

// ---------------- CAMPAIGNS TABLE ----------------

function renderCampaignsTable(campaigns) {
  const tbody = document.getElementById("campaignsTableBody");
  if (!tbody || !campaigns) return;

  const sorted = [...campaigns].sort((a, b) => {
    const av = a[sortState.key];
    const bv = b[sortState.key];
    if (typeof av === "string") {
      return sortState.dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return sortState.dir === "asc" ? av - bv : bv - av;
  });

  tbody.innerHTML = "";
  sorted.forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${c.name}</td>
      <td><span class="status-chip status-${c.status}">${c.status}</span></td>
      <td>${formatCurrency(c.spend)}</td>
      <td>${formatNumber(c.messages)}</td>
      <td>${formatPercent(c.ctr)}</td>
      <td>${formatCurrency(c.cpc)}</td>
      <td>${formatCurrency(c.costPerMessage)}</td>
    `;
    tbody.appendChild(tr);
  });

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
        renderCampaignsTable(currentData.ranges[currentRange].campaigns);
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
      currentRange = btn.dataset.range;
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
