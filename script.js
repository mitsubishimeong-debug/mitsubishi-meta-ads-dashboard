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

// v6 ADD: paste your n8n webhook's PRODUCTION URL here (the "Manual
// Receipt Webhook" node, path "billing-receipt") to enable the "Log a
// Receipt" form on the Historical Intelligence tab. Leave as "" to
// keep the form disabled.
const RECEIPT_WEBHOOK_URL = "https://propeller-quake-maker.ngrok-free.dev/webhook/billing-receipt";

// v10 ADD: Meta does not expose per-charge VAT invoice PDFs through any
// public API (confirmed dead end — see RECEIPT_WEBHOOK_URL comment above
// for the related "no transactions edge" finding). The only place these
// PDFs exist is the Billing & Payments > Payment Activity page in Meta
// Business Suite, and only "Download all as ZIP/PDF" there produces them.
// This button can't pull the files into the dashboard, but it removes the
// menu-hunting: one click here jumps straight to the right ad account's
// billing page, new tab, ready for the ZIP download.
const META_AD_ACCOUNT_ID = "282527975908557";
const META_BUSINESS_ID = "178087108528215";

function getMetaInvoicesUrl() {
  return `https://business.facebook.com/billing_hub/payment_activity/?asset_id=${META_AD_ACCOUNT_ID}&business_id=${META_BUSINESS_ID}`;
}

function initMetaInvoicesLink() {
  const link = document.getElementById("metaInvoicesLink");
  if (!link) return;
  link.href = getMetaInvoicesUrl();
}

// v11 ADD: same webhook pattern as RECEIPT_WEBHOOK_URL above, but for the
// "Manual Closed Sale Webhook" node (path "closed-sale") — powers the
// "Log a Closed Sale" form below.
const CLOSED_SALE_WEBHOOK_URL = "https://propeller-quake-maker.ngrok-free.dev/webhook/closed-sale";

// v11 ADD: used only for the CSV export header row ("Facebook page
// name: ..."). Update this if the page name changes.
const FB_PAGE_NAME = "Citimotors Las Piñas Best Offer by Romeo - Meong";

const CHART_COLORS = {
  primary: "#DC2626",
  green: "#16A34A",
  amber: "#D97706",
  grid: "#E6EAF0",
  text: "#64748B",
};

if (typeof Chart !== "undefined") {
  Chart.defaults.font.family = "'Inter', sans-serif";
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
    pill.innerHTML = `<span class="dot" style="background:#DC2626;"></span> NO DATA`;
  }
}

// ---------------- RANGE AVAILABILITY ----------------

// Disables any range button whose key isn't present in the current
// dashboard.json's ranges{} object, and makes sure currentRange
// always points at a range that actually has data. Never assumes
// "today"/"7d"/"30d" all exist — reads only from what's there.
function applyRangeAvailability() {
  // v9 FIX (filters going dead): dashboard.json's ranges{} object is
  // built upstream in n8n ("Build Dashboard Ranges" -> "Prepare
  // Dashboard JSON"). When that node chain doesn't produce output for
  // a given run (Merge node waiting on a branch, HTTP Request auth
  // failure, etc.) "Prepare Dashboard JSON" falls back to `ranges: {}`
  // — which used to disable ALL THREE range buttons and leave the
  // whole Overview tab blank, even though dashboard.json still has a
  // perfectly good legacy top-level `overview` object with real
  // numbers. This synthesizes a `today` range from `overview` in that
  // case so Today keeps working instead of every button going dark.
  // 7d/30d still correctly stay disabled since there's no way to
  // derive a multi-day window from a single snapshot — the real fix
  // for those is upstream in n8n (see notes shared separately).
  if (
    currentData &&
    (!currentData.ranges || Object.keys(currentData.ranges).length === 0) &&
    currentData.overview &&
    Object.keys(currentData.overview).length > 0
  ) {
    const o = currentData.overview;
    currentData.ranges = {
      today: {
        label: "Today",
        spend: Number(o.spend || 0),
        messages: Number(o.messages || 0),
        ctr: Number(o.ctr || 0),
        cpc: Number(o.cpc || 0),
        cpm: Number(o.cpm || 0),
        costPerMessage: Number(o.cost_per_message ?? o.costPerMessage ?? 0),
        funnel: {},
        trends: {},
        budgetPacing: currentData.budgetPacing || {},
      },
    };
  }

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

  console.log("========== OVERVIEW ==========");
  console.log("currentData.topAd =", currentData.topAd);
  console.log("currentData =", currentData);
  console.log("==============================");

  const ranges = currentData.ranges || {};
  const rangeData = ranges[currentRange] || {};

  setText("reportDate", currentData.reportDate ?? "—");
  setText("lastUpdated", `Last updated ${new Date().toLocaleTimeString()}`);

  animateGauge(currentData.accountHealth);
  renderGaugeBasis(currentData.accountHealthBasis);

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

  // v16 ADD (Part 10, Issue 4): Good / Needs Improvement / Bad status
  // indicators for each KPI card. Pacing % (spend vs. allocated daily
  // budget — same figures Budget Pacing already uses below) is computed
  // once here and reused both for the Spend status and for the Budget
  // Pacing bar, so the two stay consistent with each other.
  const allocatedDailyBudget = Number(rangeData.budgetPacing?.allocated_daily_budget);
  const spendNum = Number(rangeData.spend);
  const pacingPct =
    !isNaN(allocatedDailyBudget) && allocatedDailyBudget > 0 && !isNaN(spendNum)
      ? (spendNum / allocatedDailyBudget) * 100
      : null;

  renderKpiStatus("statusSpend", getMetricStatus("spend", rangeData.spend, { pacingPct }));
  renderKpiStatus("statusMessages", getMetricStatus("messages", rangeData.messages));
  renderKpiStatus("statusCtr", getMetricStatus("ctr", rangeData.ctr));
  renderKpiStatus("statusCpc", getMetricStatus("cpc", rangeData.cpc));
  renderKpiStatus("statusCpm", getMetricStatus("cpm", rangeData.cpm));
  // Cost/Message is mathematically 0 whenever Messages is 0 (nothing to
  // divide spend by) — that's an absence of data, not a "Good" ₱0 cost,
  // so it's evaluated only when there's at least one message to base it on.
  renderKpiStatus(
    "statusCostMsg",
    Number(rangeData.messages) > 0
      ? getMetricStatus("costPerMessage", rangeData.costPerMessage)
      : { cls: "none", label: "No Data" }
  );

  // v8 ADD (Phase 1): sparklines under Spend / Messages / CTR cards
  // v16 FIX (Part 10, Issue 3): Today's trends payload legitimately has
  // a single data point, but dashboard.json's label for it can lag one
  // day behind the selected report date shown in the header (upstream
  // timezone rollover). The KPI values themselves are untouched — only
  // the displayed date label for that single point is aligned to the
  // header's report date so charts/sparklines don't show a date that
  // contradicts what "Today" is currently set to.
  let trendsForDisplay = rangeData.trends;
  if (
    currentRange === "today" &&
    trendsForDisplay &&
    Array.isArray(trendsForDisplay.labels) &&
    trendsForDisplay.labels.length === 1 &&
    currentData.reportDate &&
    trendsForDisplay.labels[0] !== currentData.reportDate
  ) {
    trendsForDisplay = { ...trendsForDisplay, labels: [currentData.reportDate] };
  }
  renderKpiSparklines(trendsForDisplay);

  // CHANGED (v7.1): was `renderBudget(rangeData.budget)`.
  // dashboard.json now provides ranges.<range>.budgetPacing instead
  // of ranges.<range>.budget — same call site, new field name only.
  // v16 FIX (Part 10, Issue 2): also pass rangeData.spend through so
  // renderBudget can compute an actual pacing % instead of leaving the
  // bar permanently at 0%.
  renderBudget(rangeData.budgetPacing, rangeData.spend);

  // Funnel
  renderFunnel(rangeData.funnel);

  // Top performers
  // MODIFY: Overview "top performer" cards now read from the new
  // top-level dashboard.json objects (topCampaign / topAd /
  // topCreative / topAudience) instead of per-range fields, so no
  // further script.js edits are needed once the backend populates
  // these — renderTopPerformers() below is schema-complete for all
  // documented fields on each object.
  renderTopPerformers();

  // Prediction — MODIFY: now sourced via renderPrediction() below,
  // reading the full currentData.predictionTomorrow object rather
  // than two one-off setText() calls, so any additional prediction
  // fields the backend adds later render automatically too.
  renderPrediction();

  // AI recommendations & alerts (account-level, not per range)
  // v15 FIX: backend sends recommendations as { title, detail, priority }
  // and alerts as { severity, message } -- renderReasonedList only reads
  // { text, reason, priority }, so every item was silently falling back
  // to "—" even though the array itself (and its length/priority badges)
  // was correct. Map to the expected shape here instead of touching the
  // shared renderReasonedList (alerts elsewhere may still be plain strings).
  const recItems = Array.isArray(currentData?.recommendations)
    ? currentData.recommendations.map((r) => (typeof r === "string" ? r : {
        text: r.text ?? r.title ?? "—",
        reason: r.reason ?? r.detail ?? null,
        priority: r.priority ?? null,
      }))
    : currentData?.recommendations;
  const alertItems = Array.isArray(currentData?.alerts)
    ? currentData.alerts.map((a) => (typeof a === "string" ? a : {
        text: a.text ?? a.message ?? "—",
        reason: a.reason ?? null,
        priority: a.priority ?? a.severity ?? null,
      }))
    : currentData?.alerts;
  renderReasonedList("recList", recItems, "rec");
  renderReasonedList("alertList", alertItems, "alert");

  // Prediction
  setText("predCtr", formatPercent(currentData.predictionTomorrow?.ctr));
  setText("predMessages", formatNumber(currentData.predictionTomorrow?.expectedMessages));

  // Charts
  renderTrendCharts(trendsForDisplay);
  // v16 FIX (Part 10, Issue 3): ranges.<range>.campaigns doesn't exist
  // anywhere in the current dashboard.json schema (checked all three
  // ranges), so the Campaign Ranking chart and All Campaigns table were
  // unconditionally empty on every range, not just Today — that's what
  // made Today look like it had "no data" even though its KPI numbers
  // were populated. The real per-campaign rows already exist at the
  // top level as currentData.campaignRanking (n8n's "Build Campaign
  // Ranking" output) and just weren't wired into either function. No
  // new data is invented here — only the existing top-level object is
  // read and its field names mapped to what these two functions expect.
  const campaignRows =
    Array.isArray(rangeData.campaigns) && rangeData.campaigns.length
      ? rangeData.campaigns
      : normalizeCampaignRanking(currentData.campaignRanking);
  renderRankingChart(campaignRows);

  // Campaigns table
  renderCampaignsTable(campaignRows);

  // v7 ADD: client-computed AI Health Score for the active range.
  // Purely additive — no-ops safely if the optional gauge markup
  // isn't present in this build of the HTML (see function below).
  renderAIHealthScore(rangeData);
}

function setText(id, value) {
  const el = getEl(id);
  if (el) el.textContent = value ?? "—";
}

// ---------------- TOP PERFORMERS (v7.2 — new top-level schema) ----------------
// Reads currentData.topCampaign / topAd / topCreative / topAudience,
// each written by n8n as its own top-level object (not per-range).
// Every documented field on each object is rendered here so the
// cards fill in automatically as the backend populates fields —
// no further script.js changes needed. All setText() calls are
// safe no-ops if a given id isn't in the current HTML build yet.
function renderTopPerformers() {
const topCampaign = (currentData && currentData.topCampaign) || {};
const topAd = (currentData && currentData.topAd) || {};
const topCreative = (currentData && currentData.topCreative) || {};
const topAudience = (currentData && currentData.topAudience) || {};

// Top Campaign
// v15 FIX: backend sends `campaign_name`, not `name` -- was always
// falling through to "—" regardless of real data being present.
setText("topCampaignName", topCampaign.campaign_name ?? "—");
setText("topCampaignRec", topCampaign.recommendation ?? "—");

// Top Ad
setText("topAdName", topAd.ad_name ?? "—");
setText("topAdCampaignName", topAd.campaign_name ?? "—");
setText("topAdCtr", formatPercent(topAd.ctr));
setText("topAdMessages", formatNumber(topAd.messages));
setText("topAdSpend", formatCurrency(topAd.spend));
setText("topAdCpc", formatCurrency(topAd.cpc));
setText("topAdCpm", formatCurrency(topAd.cpm));
setText("topAdCostPerMessage", formatCurrency(topAd.cost_per_message));

// Top Creative
setText("topCreativeName", topCreative.creative_name ?? "—");
setText("topCreativeCtr", formatPercent(topCreative.ctr));
setText("topCreativeMessages", formatNumber(topCreative.messages));
setText("topCreativeSpend", formatCurrency(topCreative.spend));
const creativeThumbEl = getEl("topCreativeThumbnail");
if (creativeThumbEl) {
if (topCreative.thumbnail) {
creativeThumbEl.src = topCreative.thumbnail;
creativeThumbEl.style.display = "";
} else {
creativeThumbEl.removeAttribute("src");
creativeThumbEl.style.display = "none";
}
}

// Top Audience
setText("topAudienceName", topAudience.audience_name ?? "—");
setText("topAudienceRange", topAudience.age_range ?? "—");
setText("topAudienceGender", topAudience.gender ?? "—");
setText("topAudienceLocation", topAudience.location ?? "—");
setText("topAudienceCtr", formatPercent(topAudience.ctr));
setText("topAudienceMessages", formatNumber(topAudience.messages));
}

// ---------------- PREDICTION (v7.2 — schema-complete) ----------------
// Reads the full currentData.predictionTomorrow object. ctr /
// expectedMessages are the fields already wired to existing HTML
// ids; any other fields the backend adds later can get their own
// setText() line here without touching render() again.
function renderPrediction() {
const prediction = (currentData && currentData.predictionTomorrow) || {};
setText("predCtr", formatPercent(prediction.ctr));
setText("predMessages", formatNumber(prediction.expectedMessages));
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
    // v17 FIX (Part 9D, Issue 2): leave the element empty instead of "—"
    // so the existing .delta:empty { display:none; } CSS rule hides the
    // placeholder entirely. renderDelta() itself is unchanged otherwise —
    // once the backend sends a real *ChangeYesterday value, this branch
    // is skipped and the ▲/▼ indicator below renders exactly as before.
    el.textContent = "";
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
// ---------------- KPI SPARKLINES (v8 ADD — Phase 1) ----------------
// Tiny inline-SVG trend lines under each KPI card, built from the
// same rangeData.trends arrays the big trend charts already use
// (spend / messages / ctr). No Chart.js instance per card — plain
// SVG keeps 6 of these cheap to redraw on every 60s poll. Purely
// additive: if a #sparkX container isn't in this build of the HTML,
// or a trend series has fewer than 2 points (e.g. "Today"), the
// function no-ops for that card instead of throwing.
function buildSparklinePath(values) {
  const nums = (values || []).map((v) => (typeof v === "number" ? v : 0));
  if (nums.length < 2) return "";
  const w = 100, h = 22, pad = 2;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const step = (w - pad * 2) / (nums.length - 1);
  const points = nums.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const trendUp = nums[nums.length - 1] >= nums[0];
  const color = trendUp ? CHART_COLORS.green : CHART_COLORS.primary;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${points.join(
    " "
  )}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderSparkline(id, values) {
  const el = getEl(id);
  if (!el) return;
  el.innerHTML = buildSparklinePath(values);
}

function renderKpiSparklines(trends) {
  if (!trends) return;
  renderSparkline("sparkSpend", trends.spend);
  renderSparkline("sparkMessages", trends.messages);
  renderSparkline("sparkCtr", trends.ctr);
  // cpc / cpm / cost-per-message have no daily series in
  // dashboard.json today (only aggregate range totals) — the
  // sparkline containers stay empty (and hidden via CSS :empty)
  // rather than fabricating a fake trend line.
}

// v16 FIX (Part 10, Issue 2): budgetPacing only carries active_campaigns
// + allocated_daily_budget — no "spent" figure of its own — but the
// range's own spend total (rangeData.spend, already rendered a few
// lines up in the Spend KPI card) is exactly the "spent" half of the
// ratio. Nothing new is invented: both numbers already exist in
// dashboard.json, just in two different places, so `spend` is now
// passed in from render()'s call site alongside budgetPacing.
function getPacingStatusClass(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return "pacing-none";
  if (pct <= 100) return "pacing-good";
  if (pct <= 120) return "pacing-warn";
  return "pacing-bad";
}

function renderBudget(budgetPacing, spend) {
  const fill = getEl("budgetFill");

  if (!budgetPacing || typeof budgetPacing !== "object") {
    if (fill) {
      fill.style.width = "0%";
      fill.classList.remove("pacing-good", "pacing-warn", "pacing-bad");
    }
    setText("budgetReadout", "—");
    return;
  }

  const activeCampaigns = Number(budgetPacing.active_campaigns) || 0;
  const allocatedDailyBudget = Number(budgetPacing.allocated_daily_budget) || 0;
  const spendNum = Number(spend);

  const pct =
    allocatedDailyBudget > 0 && !isNaN(spendNum) ? (spendNum / allocatedDailyBudget) * 100 : null;

  if (fill) {
    fill.classList.remove("pacing-good", "pacing-warn", "pacing-bad");
    if (pct === null) {
      fill.style.width = "0%";
    } else {
      // Visual fill is clamped to 100% of the track width (a >100%
      // pacing still reads as "full bar, red" rather than overflowing
      // the track) — the actual percentage number is still shown
      // uncapped in the readout text below.
      fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      fill.classList.add(getPacingStatusClass(pct));
    }
  }

  const pctLabel = pct === null ? "" : ` • ${pct.toFixed(1)}% of daily budget`;
  setText(
    "budgetReadout",
    `${formatNumber(activeCampaigns)} Active Campaign${activeCampaigns === 1 ? "" : "s"} • ${formatCurrency(allocatedDailyBudget)} Daily Budget${pctLabel}`
  );
}

// ---------------- KPI STATUS INDICATORS (v16 ADD — Part 10, Issue 4) ----------------
// Good / Needs Improvement / Bad / No Data for each KPI card, using the
// thresholds supplied in the Part 10 brief (no existing thresholds were
// found elsewhere in this file to reuse). Spend is the one exception —
// per the brief it's evaluated against Budget Pacing context (the same
// spend-vs-allocated-daily-budget % renderBudget computes) rather than
// a flat currency threshold.
function getMetricStatus(metric, value, ctx) {
  if (metric === "spend") {
    const pct = ctx && ctx.pacingPct;
    if (pct === null || pct === undefined || isNaN(pct)) return { cls: "none", label: "No Data" };
    if (pct <= 100) return { cls: "good", label: "Good" };
    if (pct <= 120) return { cls: "warn", label: "Needs Improvement" };
    return { cls: "bad", label: "Bad" };
  }

  const v = Number(value);
  if (value === undefined || value === null || value === "" || isNaN(v)) {
    return { cls: "none", label: "No Data" };
  }

  switch (metric) {
    case "ctr":
      if (v >= 1.0) return { cls: "good", label: "Good" };
      if (v >= 0.5) return { cls: "warn", label: "Needs Improvement" };
      return { cls: "bad", label: "Bad" };
    case "cpc":
      if (v <= 10) return { cls: "good", label: "Good" };
      if (v <= 20) return { cls: "warn", label: "Needs Improvement" };
      return { cls: "bad", label: "Bad" };
    case "cpm":
      if (v <= 300) return { cls: "good", label: "Good" };
      if (v <= 500) return { cls: "warn", label: "Needs Improvement" };
      return { cls: "bad", label: "Bad" };
    case "costPerMessage":
      if (v <= 50) return { cls: "good", label: "Good" };
      if (v <= 100) return { cls: "warn", label: "Needs Improvement" };
      return { cls: "bad", label: "Bad" };
    case "messages":
      return v > 0 ? { cls: "good", label: "Good" } : { cls: "bad", label: "Bad" };
    default:
      return { cls: "none", label: "No Data" };
  }
}

function renderKpiStatus(id, status) {
  const el = getEl(id);
  if (!el) return;
  el.textContent = status.label;
  el.className = `kpi-status kpi-status--${status.cls}`;
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
      // v8 ADD (Phase 2): drop-off %, the inverse of pctOfPrev — how
      // much of the previous stage was LOST before reaching this one.
      const dropOff =
        i > 0 && prevVal && !isNaN(curVal)
          ? Math.max(0, 100 - (curVal / prevVal) * 100).toFixed(1) + "% drop"
          : "";

      const stageHtml = `
        <div class="funnel-stage">
          <span class="funnel-stage-value">${formatNumber(stage.value)}</span>
          <span class="funnel-stage-label">${stage.label}</span>
          ${pctOfPrev ? `<span class="funnel-stage-pct">${pctOfPrev}</span>` : ""}
          ${dropOff ? `<span class="funnel-stage-drop">${dropOff}</span>` : ""}
        </div>`;

      const arrowHtml = i < stages.length - 1 ? `<span class="funnel-arrow">›</span>` : "";
      return stageHtml + arrowHtml;
    })
    .join("");

  el.innerHTML = html;

  // v8 ADD (Phase 2): overall conversion rate, first stage with a
  // value through to the last stage with a value (usually
  // Impressions -> Messages, since Conversions is often absent).
  const withValues = stages.filter((s) => !isNaN(Number(s.value)) && s.value != null);
  const overallEl = getEl("funnelOverall");
  if (overallEl) {
    if (withValues.length >= 2) {
      const first = Number(withValues[0].value);
      const last = Number(withValues[withValues.length - 1].value);
      const overallPct = first ? ((last / first) * 100).toFixed(2) + "%" : "—";
      overallEl.textContent = `${withValues[0].label} → ${withValues[withValues.length - 1].label}: ${overallPct}`;
    } else {
      overallEl.textContent = "";
    }
  }
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
  if (safeScore < 50) color = "#DC2626";
  else if (safeScore < 80) color = "#D97706";
  if (fill) fill.style.stroke = color;

  animateNumber("healthScore", safeScore);
}

// NEW (2026-08): Account Health is computed server-side from whichever
// window (7d / 30d / today) actually had activity -- this makes that
// transparent instead of the score just looking like a fixed number.
function renderGaugeBasis(basis) {
  const el = getEl("gaugeBasis");
  if (!el) return;
  const labels = {
    "7d": "Based on last 7 days",
    "30d": "Based on last 30 days",
    "today": "Based on today (no recent 7d/30d activity)",
  };
  el.textContent = labels[basis] || "";
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
  // v16 FIX (Part 10, Issue 1): added minimumFractionDigits so whole-peso
  // values (e.g. a ₱250 daily budget) still render as "₱250.00" instead
  // of "₱250", consistent with every other currency figure on the page.
  // The ₱ prefix itself was already applied everywhere via this shared
  // formatter — every Overview currency value already routes through it.
  return `₱${Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

// v16 ADD (Part 10, Issue 3): maps currentData.campaignRanking's field
// names (campaign_name / cost_per_message) onto the { name, status,
// spend, messages, ctr, cpc, costPerMessage } shape renderRankingChart
// and renderCampaignsTable already expect. campaignRanking has no
// `status` field, so status is left undefined (renders as "—") rather
// than inventing one.
function normalizeCampaignRanking(list) {
  if (!Array.isArray(list)) return [];
  return list.map((c) => ({
    name: c?.campaign_name ?? c?.name ?? "—",
    status: c?.status,
    spend: c?.spend,
    messages: c?.messages,
    ctr: c?.ctr,
    cpc: c?.cpc,
    costPerMessage: c?.cost_per_message ?? c?.costPerMessage,
  }));
}

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

// PART 9B: Export Report prints all tab-panels at once (see
// @media print in style.css), but charts on tabs the user never
// manually clicked into were created while their panel was
// display:none — same zero-size Chart.js issue initTabNav() already
// works around on tab switch. Re-run those exact same render calls
// here before printing so every chart is sized correctly first.
// Purely additive: no new charts, no dataset/calculation changes.
function prepareChartsForPrint() {
  if (historyAvailable) {
    renderHistoricalOverview();
    renderModelPerformance();
    renderObjectiveComparison();
    renderTimeline();
  }
  if (aiAvailable) renderAIAnalysis();
}

function initExport() {
  const btn = getEl("exportBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    prepareChartsForPrint();
    // Let the re-rendered charts finish drawing (canvas layout +
    // Chart.js animation frame) before the print dialog captures
    // the page.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.print());
    });
  });
}

// ---------------- MONTHLY REPORT CSV EXPORT (v8 ADD — Phase 3) ----------------
// Answers a direct ask: a downloadable "receipt" of last month's
// weekly numbers (the same data already shown in the Monthly Report
// table on Historical Intelligence), as a CSV file the user can open
// in Excel/Sheets or attach to a report. Purely additive: reads the
// same historyData.monthlyReport already rendered by
// renderMonthlyReport(), builds a CSV string client-side, no new
// dependency.
function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// v11 CHANGE: rebuilt to match the exact report format already used for
// submission (Facebook page name header, then one stacked section per
// metric — Impressions / Reach / Online Inquiries / Closed Sales — each
// broken into ordinal weeks (1st, 2nd, 3rd...) with a Total row. Replaces
// the old one-row-per-week table layout.
function ordinalWeekLabel(n) {
  const suffixes = { 1: "1st", 2: "2nd", 3: "3rd" };
  return suffixes[n] || `${n}th`;
}

function exportMonthlyReportCsv() {
  const reports = historyData?.monthlyReports;
  const report = (reports && currentMonthFilter && reports[currentMonthFilter])
    || historyData?.monthlyReport;
  if (!report || !report.weeks || !report.weeks.length) {
    alert("No monthly report data available yet to export.");
    return;
  }

  const weeks = report.weeks;
  const totals = report.totals || {};

  const rows = [];
  rows.push(["Facebook page name:", FB_PAGE_NAME]);
  rows.push([]);

  function addSection(title, key, totalValue) {
    rows.push([title]);
    weeks.forEach((w) => {
      rows.push([`${ordinalWeekLabel(w.weekNumber)}:`, w[key] ?? 0]);
    });
    rows.push(["Total:", totalValue ?? 0]);
    rows.push([]);
  }

  addSection("Total impression per week", "impressions", totals.impressions);
  addSection("Total reach per week", "reach", totals.reach);
  addSection("Total online inquire per week", "messages", totals.messages);
  addSection("Total closed sales from online inquires per week", "closedSales", totals.closedSales);

  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeMonth = (report.month || "monthly-report").replace(/\s+/g, "-").toLowerCase();
  a.href = url;
  a.download = `${safeMonth}-report.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function initMonthlyReportExport() {
  const btn = getEl("exportMonthlyReportBtn");
  if (!btn) return;
  btn.addEventListener("click", exportMonthlyReportCsv);
}

// ---------------- GREETING (v12 ADD, PART 1 redesign) ----------------
// Purely cosmetic — sets the "Good morning/afternoon/evening, Romeo!"
// header text based on local time of day. No fetch, no API call, no
// dependency on dashboard.json. Guarded the same way every other
// render*() helper in this file is guarded, so it's a silent no-op
// if the element isn't present in a given build of the HTML.
function renderGreeting() {
  const el = getEl("greetingText");
  if (!el) return;
  const hour = new Date().getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  el.textContent = `Good ${part}, Romeo! 👋`;
}

// ---------------- INIT (v4 Overview) ----------------

renderGreeting();
initRangeSwitch();
initTableSorting();
initExport();
initMonthlyReportExport();
initMonthDropdown();
initReceiptForm();
initMetaInvoicesLink();
initClosedSaleForm();
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
let currentMonthFilter = null;   // "YYYY-MM" — v6: selected month for the Monthly Report table. null = default (previous month)
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

// v15 FIX: aiData.winning_ads actually comes through as an array of
// plain strings (e.g. "🚗 02 - Mirage G4 | ₱15K+/Month (Best CTR:
// 5.68%)"), not objects with ad_name/reason/ctr/messages fields as
// originally assumed -- every item's `.ad_name` on a string is
// undefined, so this always rendered "—" even with real data present.
function renderWinningAds() {
  const ads = Array.isArray(aiData?.winning_ads) ? aiData.winning_ads : [];
  const items = ads.map((ad) => {
    if (typeof ad === "string") return ad;
    return {
      text: ad.ad_name ?? ad.name ?? "—",
      reason: ad.reason ?? [
        ad.ctr !== undefined ? `${formatPercent(ad.ctr)} CTR` : null,
        ad.messages !== undefined ? `${formatNumber(ad.messages)} messages` : null,
      ].filter(Boolean).join(" · "),
      priority: ad.priority ?? null,
    };
  });
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

// NEW (2026-08): aiData.targeting_intelligence = { best_locations: [],
// best_interests: [], market_demand_notes: [] } — each a plain string
// array. renderReasonedList already handles plain strings gracefully
// (no badge, just text), so no new list-rendering logic needed.
function renderTargetingIntelligence() {
  const t = aiData?.targeting_intelligence || {};
  renderReasonedList("targetingLocationsList", Array.isArray(t.best_locations) ? t.best_locations : [], "rec");
  renderReasonedList("targetingInterestsList", Array.isArray(t.best_interests) ? t.best_interests : [], "rec");
  renderReasonedList("marketDemandList", Array.isArray(t.market_demand_notes) ? t.market_demand_notes : [], "rec");
}

// NEW (2026-08): aiData.creative_direction = [{ boost_target, format
// ("image"|"video"), headline, cta, description }]. Reuses the same
// reasoned-list look as the boost plan — format shown as a colored
// badge (via the existing priority-badge mechanism), headline/cta/
// description folded into the reason line.
function renderCreativeDirection() {
  const list = Array.isArray(aiData?.creative_direction) ? aiData.creative_direction : [];
  const items = list.map((c) => ({
    text: c.boost_target ?? "—",
    reason: [
      c.headline ? `Headline: "${c.headline}"` : null,
      c.cta ? `CTA: ${c.cta}` : null,
      c.description || null,
    ].filter(Boolean).join(" · "),
    priority: c.format
      ? c.format.charAt(0).toUpperCase() + c.format.slice(1).toLowerCase()
      : null,
  }));
  renderReasonedList("creativeDirectionList", items, "rec");
}

// ADD — orchestrator for the whole Recommendations tab
// v7 MODIFY: now also renders metrics and best/worst campaigns so
// every field in reports/ai-analysis.json is displayed somewhere —
// nothing from that file is left un-rendered.
// v10 MODIFY: also renders targeting_intelligence and creative_direction.
function renderAIAnalysis() {
  if (!aiAvailable) return;
  renderExecutiveSummary();
  renderAIMetrics();
  renderBestWorstCampaigns();
  generateRecommendations();
  renderWinningAds();
  renderCreativeInsights();
  renderHistoricalAIInsights();
  renderBoostPlan();
  renderTargetingIntelligence();
  renderCreativeDirection();
}

// v9 ADD: "this_month_boost_plan" from reports/ai-analysis.json — the AI's
// prioritized, specific list of what to boost THIS month (which campaign/
// ad/creative, what action, why, expected impact). Reuses the same
// renderReasonedList() pattern as the other recommendation lists so it
// matches the existing look (priority badges, etc.).
function renderBoostPlan() {
  const plan = aiData?.this_month_boost_plan;
  setText("boostPlanMonth", plan?.month || "");

  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const items = actions.map((a) => ({
    text: [a.boost_target, a.action].filter(Boolean).join(" — ") || "—",
    reason: [a.reason, a.expected_impact ? `Expected: ${a.expected_impact}` : null]
      .filter(Boolean)
      .join(" · "),
    priority: a.priority
      ? a.priority.charAt(0).toUpperCase() + a.priority.slice(1).toLowerCase()
      : null,
  }));

  renderReasonedList("boostPlanList", items, "rec");
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
  renderWeeklyPerformance();
  renderMonthlyReport();
}

// v8 ADD: rolling 7-day Reach / Impressions / Messages, sourced from
// dashboard-history.json's weeklyPerformance field (built in n8n from the
// Daily Summary sheet). Used for the recurring weekly report.
function renderWeeklyPerformance() {
  const week = historyData?.weeklyPerformance;

  if (!week) {
    setText("weekReach", "—");
    setText("weekImpressions", "—");
    setText("weekMessages", "—");
    setText("weekRange", "—");
    return;
  }

  setText("weekReach", formatNumber(week.reach));
  setText("weekImpressions", formatNumber(week.impressions));
  setText("weekMessages", formatNumber(week.messages));

  const range = (week.startDate && week.endDate)
    ? `${week.startDate} → ${week.endDate}`
    : "—";
  setText("weekRange", range);
}

// v6 ADD: populate the month dropdown (Jan–Dec, across whatever years
// n8n has actually built a report for) from historyData.availableMonths,
// and keep it in sync with the currently selected month.
function renderMonthDropdown() {
  const select = document.getElementById("monthReportSelect");
  if (!select) return;

  const available = historyData?.availableMonths || [];

  if (!available.length) {
    select.innerHTML = `<option value="">No months available</option>`;
    select.disabled = true;
    return;
  }

  select.disabled = false;

  // Default to the most recent month (matches the old "previous
  // month" behavior) unless the user has already picked one.
  if (!currentMonthFilter || !available.some((m) => m.key === currentMonthFilter)) {
    currentMonthFilter = available[available.length - 1].key;
  }

  select.innerHTML = available
    .map((m) => `<option value="${m.key}"${m.key === currentMonthFilter ? " selected" : ""}>${m.label}</option>`)
    .join("");
}

function initMonthDropdown() {
  const select = document.getElementById("monthReportSelect");
  if (!select) return;
  select.addEventListener("change", () => {
    currentMonthFilter = select.value || null;
    renderMonthlyReport();
  });
}

// v6 ADD: "Log a Receipt" form — POSTs to the n8n "Manual Receipt
// Webhook" node (RECEIPT_WEBHOOK_URL), which appends the row into the
// "Billing Receipts" Google Sheet tab. Exists because Meta does not
// expose a "transactions" API edge for prepaid / QR-top-up funded ad
// accounts, so there is no way to pull real billing receipts
// automatically — this is the manual fallback.
function initReceiptForm() {
  const form = document.getElementById("receiptForm");
  if (!form) return;

  const statusEl = document.getElementById("receiptFormStatus");
  const submitBtn = document.getElementById("receiptSubmitBtn");

  if (!RECEIPT_WEBHOOK_URL) {
    if (statusEl) {
      statusEl.textContent = "Set RECEIPT_WEBHOOK_URL in script.js to enable this form.";
      statusEl.classList.add("is-error");
    }
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const payload = {
      date: document.getElementById("receiptDate")?.value,
      amount: document.getElementById("receiptAmount")?.value,
      currency: document.getElementById("receiptCurrency")?.value,
      payment_method: document.getElementById("receiptMethod")?.value,
      reference_id: document.getElementById("receiptRef")?.value,
      note: document.getElementById("receiptNote")?.value,
    };

    if (submitBtn) submitBtn.disabled = true;
    if (statusEl) {
      statusEl.textContent = "Logging…";
      statusEl.classList.remove("is-success", "is-error");
    }

    try {
      const res = await fetch(RECEIPT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      form.reset();
      if (statusEl) {
        statusEl.textContent = "Receipt logged.";
        statusEl.classList.add("is-success");
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Failed to log receipt: ${err.message}`;
        statusEl.classList.add("is-error");
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// v11 ADD: mirrors initReceiptForm() above — same POST pattern, different
// webhook/fields, for the "Log a Closed Sale" form.
function initClosedSaleForm() {
  const form = document.getElementById("closedSaleForm");
  if (!form) return;

  const statusEl = document.getElementById("closedSaleFormStatus");
  const submitBtn = document.getElementById("closedSaleSubmitBtn");

  if (!CLOSED_SALE_WEBHOOK_URL) {
    if (statusEl) {
      statusEl.textContent = "Set CLOSED_SALE_WEBHOOK_URL in script.js to enable this form.";
      statusEl.classList.add("is-error");
    }
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const payload = {
      date: document.getElementById("closedSaleDate")?.value,
      count: document.getElementById("closedSaleCount")?.value,
      note: document.getElementById("closedSaleNote")?.value,
    };

    if (submitBtn) submitBtn.disabled = true;
    if (statusEl) {
      statusEl.textContent = "Logging…";
      statusEl.classList.remove("is-success", "is-error");
    }

    try {
      const res = await fetch(CLOSED_SALE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      form.reset();
      document.getElementById("closedSaleCount").value = "1";
      if (statusEl) {
        statusEl.textContent = "Closed sale logged.";
        statusEl.classList.add("is-success");
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Failed to log closed sale: ${err.message}`;
        statusEl.classList.add("is-error");
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
// week (reach, impressions, messages, spend, ctr per week) — reads
// from historyData.monthlyReports[currentMonthFilter] so any month
// n8n has archived can be viewed, not just last month. Falls back to
// the single historyData.monthlyReport for older dashboard-history.json
// files that don't have the monthlyReports archive yet.
function renderMonthlyReport() {
  renderMonthDropdown();

  const reports = historyData?.monthlyReports;
  const report = (reports && currentMonthFilter && reports[currentMonthFilter])
    || historyData?.monthlyReport;

  const body = document.getElementById("monthlyReportTableBody");
  if (!body) return;

  body.innerHTML = "";

  if (!report || !report.weeks || !report.weeks.length) {
    setText("monthlyReportTitle", "MONTHLY REPORT");
    setText("monthlyReportTotalReach", "—");
    setText("monthlyReportTotalImpressions", "—");
    setText("monthlyReportTotalMessages", "—");
    setText("monthlyReportTotalSpend", "—");
    setText("monthlyReportTotalClosedSales", "—");
    body.innerHTML = `<tr><td colspan="8">No data yet for this month.</td></tr>`;
    return;
  }

  setText("monthlyReportTitle", `MONTHLY REPORT — ${report.month.toUpperCase()} (${report.totalWeeks} WEEKS)`);

  report.weeks.forEach(w => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>Week ${w.weekNumber}</td>
      <td>${w.startDate} → ${w.endDate}</td>
      <td>${formatNumber(w.reach)}</td>
      <td>${formatNumber(w.impressions)}</td>
      <td>${formatNumber(w.messages)}</td>
      <td>${formatCurrency(w.spend)}</td>
      <td>${formatPercent(w.ctr)}</td>
      <td>${formatNumber(w.closedSales)}</td>
    `;
    body.appendChild(tr);
  });

  setText("monthlyReportTotalReach", formatNumber(report.totals?.reach));
  setText("monthlyReportTotalImpressions", formatNumber(report.totals?.impressions));
  setText("monthlyReportTotalMessages", formatNumber(report.totals?.messages));
  setText("monthlyReportTotalSpend", formatCurrency(report.totals?.spend));
  setText("monthlyReportTotalClosedSales", formatNumber(report.totals?.closedSales));
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

// ============================================================
// =================== AI CHAT ASSISTANT MODULE ===============
// Isolated, additive feature. Does not touch, wrap, or override
// any function above this line. Reuses existing global state
// (currentData, currentRange, historyData, aiData) and the
// existing escapeHtml() helper — no new fetch pattern, no new
// polling loop. Talks to a brand-new, independent n8n webhook
// (see ai-chat-assistant-workflow.json) — never the two existing
// scheduled workflows.
//
// PASTE YOUR WEBHOOK'S PRODUCTION URL BELOW after importing and
// activating ai-chat-assistant-workflow.json in n8n.
// ============================================================

const AI_CHAT_WEBHOOK_URL = "https://propeller-quake-maker.ngrok-free.dev/webhook/ai-chat-assistant";

const AI_CHAT_STORAGE_KEY = "citimotorsAiChatHistory_v1";
const AI_CHAT_MAX_STORED_MESSAGES = 40;

let aiChatMessages = []; // [{ role: "user"|"assistant", content: string, error?: boolean }]
let aiChatOpen = false;
let aiChatSending = false;

const AI_CHAT_SUGGESTIONS = [
  "Summarize today's performance",
  "Which campaign has the best ROAS?",
  "Where am I wasting budget?",
  "Compare this week vs last week",
  "Which ads should I pause?",
  "What should I optimize?",
];

// ---------------- STORAGE ----------------

function loadAiChatHistory() {
  try {
    const raw = localStorage.getItem(AI_CHAT_STORAGE_KEY);
    aiChatMessages = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(aiChatMessages)) aiChatMessages = [];
  } catch (err) {
    aiChatMessages = [];
  }
}

function saveAiChatHistory() {
  try {
    // Nala's auto-greeting is marked transient — it's regenerated
    // fresh from live data on every load, so it's deliberately never
    // persisted (otherwise every reload would pile another stale
    // greeting into saved history).
    const persistable = aiChatMessages.filter((m) => !m.transient);
    const trimmed = persistable.slice(-AI_CHAT_MAX_STORED_MESSAGES);
    localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(trimmed));
  } catch (err) {
    // localStorage unavailable (private mode / quota) — chat still
    // works for the current session, it just won't persist.
    console.warn("AI chat: could not save history:", err.message);
  }
}

// ---------------- CONTEXT BUILDING ----------------
// Builds a compact snapshot of exactly what's currently on screen —
// the active range, that range's numbers, and whatever the AI
// Analysis / Historical pipelines have already loaded — so the
// assistant answers strictly from live dashboard state.

function buildAiChatContext() {
  const ranges = (currentData && currentData.ranges) || {};
  const rangeData = ranges[currentRange] || {};

  const rangeLabels = { today: "Today", "7d": "Last 7 Days", "30d": "Last 30 Days" };

  const context = {
    reportDate: (currentData && currentData.reportDate) || null,
    activeRange: currentRange,
    activeRangeLabel: rangeLabels[currentRange] || currentRange,
    activeRangeData: rangeData,
    allAvailableRanges: Object.keys(ranges),
    accountHealth: (currentData && currentData.accountHealth) || null,
    topCampaign: (currentData && currentData.topCampaign) || null,
    topAd: (currentData && currentData.topAd) || null,
    topCreative: (currentData && currentData.topCreative) || null,
    topAudience: (currentData && currentData.topAudience) || null,
    budgetPacing: rangeData.budgetPacing || (currentData && currentData.budgetPacing) || null,
  };

  // reports/ai-analysis.json — narrative recommendations, alerts,
  // best/worst campaigns, creative + historical insights.
  if (aiData && Object.keys(aiData).length > 0) {
    context.aiAnalysis = aiData;
  }

  // dashboard-history.json — keep this small: just counts + the most
  // recent handful of entries rather than the entire multi-KB file,
  // so the prompt stays lean. processedCampaigns / dailyPerformance
  // are populated by processHistoricalData() in the Historical module.
  if (typeof historyAvailable !== "undefined" && historyAvailable) {
    context.historySummary = {
      campaignCount: Array.isArray(processedCampaigns) ? processedCampaigns.length : undefined,
      recentDailyPerformance: Array.isArray(dailyPerformance) ? dailyPerformance.slice(-14) : undefined,
      topCampaignsByHistory: Array.isArray(processedCampaigns)
        ? processedCampaigns.slice(0, 10)
        : undefined,
    };
  }

  return context;
}

// ---------------- MARKDOWN (light) ----------------
// Minimal, dependency-free renderer: bold, bullet/numbered lists,
// paragraphs, inline code. Escapes HTML first so the model's output
// can never inject markup.

function renderAiChatMarkdown(raw) {
  const escaped = escapeHtml(raw || "");
  const lines = escaped.split(/\r?\n/);
  let html = "";
  let inList = null; // "ul" | "ol" | null

  function closeList() {
    if (inList) { html += `</${inList}>`; inList = null; }
  }

  lines.forEach((line) => {
    const trimmed = line.trim();
    const bulletMatch = trimmed.match(/^[-*]\s+(.*)/);
    const numberMatch = trimmed.match(/^\d+[.)]\s+(.*)/);

    if (bulletMatch) {
      if (inList !== "ul") { closeList(); html += "<ul>"; inList = "ul"; }
      html += `<li>${inlineAiChatMarkdown(bulletMatch[1])}</li>`;
    } else if (numberMatch) {
      if (inList !== "ol") { closeList(); html += "<ol>"; inList = "ol"; }
      html += `<li>${inlineAiChatMarkdown(numberMatch[1])}</li>`;
    } else if (trimmed === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${inlineAiChatMarkdown(trimmed)}</p>`;
    }
  });
  closeList();
  return html || `<p>${inlineAiChatMarkdown(escaped)}</p>`;
}

function inlineAiChatMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

// ---------------- RENDERING ----------------

function renderAiChatContextLabel() {
  const el = getEl("aiChatContextLabel");
  if (!el) return;
  const rangeLabels = { today: "Today", "7d": "Last 7 Days", "30d": "Last 30 Days" };
  const label = rangeLabels[currentRange] || currentRange;
  el.textContent = `Reading ${label}'s data`;
}

function renderAiChatMessages() {
  const container = getEl("aiChatMessages");
  if (!container) return;

  if (aiChatMessages.length === 0) {
    container.innerHTML = `
      <div class="ai-chat-empty">
        <strong>Hi, I'm Nala 👋</strong>
        Ask me about your Meta Ads — spend, ROAS, leads, campaigns, audiences — for whatever range is currently selected.
      </div>`;
    renderAiChatSuggestions(true);
    return;
  }

  renderAiChatSuggestions(false);

  container.innerHTML = aiChatMessages
    .map((msg, idx) => {
      const isUser = msg.role === "user";
      const bubbleClass = msg.error ? "ai-chat-bubble ai-chat-error-bubble" : "ai-chat-bubble";
      const body = isUser ? `<p>${escapeHtml(msg.content)}</p>` : renderAiChatMarkdown(msg.content);
      const copyBtn = !isUser && !msg.error
        ? `<button class="ai-chat-copy-btn" data-copy-idx="${idx}" type="button">COPY</button>`
        : "";
      return `
        <div class="ai-chat-msg ${isUser ? "user" : "assistant"}">
          <div class="ai-chat-msg-avatar">${isUser ? "YOU" : "N"}</div>
          <div>
            <div class="${bubbleClass}">${body}</div>
            ${copyBtn}
          </div>
        </div>`;
    })
    .join("");

  container.querySelectorAll("[data-copy-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.copyIdx);
      const msg = aiChatMessages[idx];
      if (!msg) return;
      navigator.clipboard?.writeText(msg.content).then(() => {
        const original = btn.textContent;
        btn.textContent = "COPIED";
        setTimeout(() => { btn.textContent = original; }, 1200);
      }).catch(() => {});
    });
  });

  container.scrollTop = container.scrollHeight;
}

function renderAiChatSuggestions(show) {
  const el = getEl("aiChatSuggestions");
  if (!el) return;
  if (!show) { el.innerHTML = ""; return; }
  el.innerHTML = AI_CHAT_SUGGESTIONS
    .map((q) => `<button type="button" class="ai-chat-suggestion-chip" data-suggestion="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
    .join("");
  el.querySelectorAll("[data-suggestion]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const input = getEl("aiChatInput");
      if (input) { input.value = chip.dataset.suggestion; input.focus(); }
    });
  });
}

function showAiChatTyping() {
  const container = getEl("aiChatMessages");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "ai-chat-msg assistant";
  el.id = "aiChatTypingRow";
  el.innerHTML = `
    <div class="ai-chat-msg-avatar">N</div>
    <div class="ai-chat-bubble">
      <div class="ai-chat-typing"><span></span><span></span><span></span></div>
    </div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function hideAiChatTyping() {
  const el = document.getElementById("aiChatTypingRow");
  if (el) el.remove();
}

// ---------------- SEND ----------------

async function sendAiChatMessage(question) {
  const trimmed = (question || "").trim();
  if (!trimmed || aiChatSending) return;

  aiChatMessages.push({ role: "user", content: trimmed });
  saveAiChatHistory();
  renderAiChatMessages();

  aiChatSending = true;
  updateAiChatSendState();
  showAiChatTyping();

  const payload = {
    question: trimmed,
    history: aiChatMessages
      .filter((m) => !m.error)
      .slice(-9, -1) // conversation before this new question
      .map((m) => ({ role: m.role, content: m.content })),
    context: buildAiChatContext(),
  };

  try {
    const res = await fetch(AI_CHAT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Free ngrok domains show an HTML "you are about to visit..."
        // interstitial to anything that looks like a browser request,
        // which breaks fetch()'s JSON parsing. This header tells
        // ngrok to skip it. Harmless to send to any other host.
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const reply = (data && data.reply) ? data.reply : "Sorry, I didn't get a usable response — please try again.";
    aiChatMessages.push({ role: "assistant", content: reply });
  } catch (err) {
    console.warn("AI chat request failed:", err.message);
    aiChatMessages.push({
      role: "assistant",
      content: "I couldn't reach the AI Assistant service just now. Please check your connection (or the n8n webhook) and try again.",
      error: true,
    });
  } finally {
    hideAiChatTyping();
    aiChatSending = false;
    updateAiChatSendState();
    saveAiChatHistory();
    renderAiChatMessages();
  }
}

function updateAiChatSendState() {
  const btn = getEl("aiChatSendBtn");
  if (btn) btn.disabled = aiChatSending;
}

// ---------------- OPEN / CLOSE / CLEAR ----------------

function openAiChat() {
  aiChatOpen = true;
  const panel = getEl("aiChatPanel");
  if (panel) { panel.classList.add("ai-chat-open"); panel.setAttribute("aria-hidden", "false"); }
  const openIcon = getEl("aiChatIconOpen");
  const closeIcon = getEl("aiChatIconClose");
  if (openIcon) openIcon.style.display = "none";
  if (closeIcon) closeIcon.style.display = "";
  renderAiChatContextLabel();
  renderAiChatMessages();
  const input = getEl("aiChatInput");
  if (input) input.focus();
}

function closeAiChat() {
  aiChatOpen = false;
  const panel = getEl("aiChatPanel");
  if (panel) { panel.classList.remove("ai-chat-open"); panel.setAttribute("aria-hidden", "true"); }
  const openIcon = getEl("aiChatIconOpen");
  const closeIcon = getEl("aiChatIconClose");
  if (openIcon) openIcon.style.display = "";
  if (closeIcon) closeIcon.style.display = "none";
}

function toggleAiChat() {
  if (aiChatOpen) closeAiChat(); else openAiChat();
}

function clearAiChat() {
  aiChatMessages = [];
  saveAiChatHistory();
  renderAiChatMessages();
}

// ---------------- INIT ----------------

function initAiChat() {
  loadAiChatHistory();

  const toggleBtn = getEl("aiChatToggle");
  const closeBtn = getEl("aiChatCloseBtn");
  const newBtn = getEl("aiChatNewBtn");
  const clearBtn = getEl("aiChatClearBtn");
  const form = getEl("aiChatForm");
  const input = getEl("aiChatInput");

  if (toggleBtn) toggleBtn.addEventListener("click", toggleAiChat);
  if (closeBtn) closeBtn.addEventListener("click", closeAiChat);
  if (newBtn) newBtn.addEventListener("click", clearAiChat);
  if (clearBtn) clearBtn.addEventListener("click", clearAiChat);

  if (input) {
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 96) + "px";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form?.requestSubmit();
      }
    });
  }

  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input) return;
      const value = input.value;
      input.value = "";
      input.style.height = "auto";
      sendAiChatMessage(value);
    });
  }
}

// Runs alongside every other init call already at the bottom of this
// file — independent of Overview/Historical/AI-analysis loading, so
// a failure here (e.g. missing webhook URL) never affects the rest
// of the dashboard, and vice versa.
initAiChat();

// ============================================================
// ================ AI CHAT — VOICE COMMAND MODULE =============
// Additive on top of the AI Chat Assistant module above. Two
// independent pieces, each fully optional and self-disabling if
// the browser doesn't support it:
//   1) Voice INPUT  — mic button transcribes speech into the
//      chat textarea using the Web Speech API's SpeechRecognition
//      (auto-sends when the browser reports a final result).
//   2) Voice OUTPUT — an optional toggle (off by default) that
//      reads new assistant replies aloud with speechSynthesis.
// Nothing here touches n8n, the webhook payload shape, or any
// function from the modules above — it only calls
// sendAiChatMessage() (already defined) and appends to
// aiChatMessages the same way typing does.
// ============================================================

let aiChatRecognition = null;
let aiChatListening = false;
let aiChatSpeakEnabled = false;

const AiChatSpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
const aiChatSpeechSupported = !!AiChatSpeechRecognitionCtor;
const aiChatTtsSupported = "speechSynthesis" in window;

function initAiChatVoice() {
  const micBtn = getEl("aiChatMicBtn");
  const speakToggle = getEl("aiChatSpeakToggle");
  const voiceStatus = getEl("aiChatVoiceStatus");

  // ---- Voice input (mic → text) ----
  if (!aiChatSpeechSupported) {
    if (micBtn) micBtn.classList.add("ai-chat-mic-unsupported");
  } else if (micBtn) {
    aiChatRecognition = new AiChatSpeechRecognitionCtor();
    aiChatRecognition.continuous = false;
    aiChatRecognition.interimResults = true;
    aiChatRecognition.maxAlternatives = 1;
    // Defaults to the page language if set, else browser default —
    // works for both English and Filipino speech out of the box on
    // Chrome; user can still just type if recognition mishears.
    aiChatRecognition.lang = document.documentElement.lang || "en-US";

    aiChatRecognition.onstart = () => {
      aiChatListening = true;
      if (aiChatMode === "manual" || aiChatMode === "idle") {
        // Manual press-to-talk (mic button in the input row).
        aiChatMode = "manual";
        micBtn.classList.add("ai-chat-mic-listening");
        micBtn.setAttribute("aria-pressed", "true");
        if (voiceStatus) {
          voiceStatus.classList.remove("ai-chat-voice-status--wake");
          voiceStatus.innerHTML = `<span class="ai-chat-voice-dot"></span> Listening… speak your question`;
          voiceStatus.style.display = "flex";
        }
      }
      // passive/capturing (wake-word mode) has its own UI, handled by
      // startAiChatPassiveListening() / enterAiChatCapturingMode().
    };

    aiChatRecognition.onresult = (event) => {
      let transcript = "";
      let isFinal = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
        if (event.results[i].isFinal) isFinal = true;
      }

      if (aiChatMode === "manual") {
        const input = getEl("aiChatInput");
        if (input) input.value = transcript;
        if (isFinal && transcript.trim()) {
          const value = transcript.trim();
          if (input) input.value = "";
          sendAiChatMessage(value);
        }
        return;
      }

      if ((aiChatMode === "passive" || aiChatMode === "capturing") && isFinal) {
        aiChatHandleWakeResult(transcript);
      }
    };

    aiChatRecognition.onerror = (event) => {
      console.warn("AI chat voice input error:", event.error);
      const wasManual = aiChatMode === "manual";
      stopAiChatListening();
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        const input = getEl("aiChatInput");
        if (input) input.placeholder = "Mic access denied — type your question instead";
        aiChatWakeEnabled = false;
        try { localStorage.setItem(AI_CHAT_WAKE_STORAGE_KEY, "0"); } catch (err) {}
        updateAiChatWakeToggleUI();
      } else if (!wasManual && aiChatWakeEnabled) {
        // Transient error (e.g. "no-speech", brief network hiccup) —
        // restart passive listening shortly instead of giving up.
        setTimeout(() => { if (aiChatWakeEnabled) startAiChatPassiveListening(); }, 600);
      }
    };

    aiChatRecognition.onend = () => {
      const wasManual = aiChatMode === "manual";
      aiChatListening = false;
      micBtn.classList.remove("ai-chat-mic-listening");
      micBtn.setAttribute("aria-pressed", "false");
      if (wasManual && voiceStatus) voiceStatus.style.display = "none";

      if (wasManual) {
        aiChatMode = aiChatWakeEnabled ? "idle" : "idle";
        // Manual recording just finished — hand the mic back to
        // passive wake-word listening if that mode is turned on.
        if (aiChatWakeEnabled) setTimeout(() => startAiChatPassiveListening(), 250);
      } else if (aiChatWakeEnabled && (aiChatMode === "passive" || aiChatMode === "capturing")) {
        // Chrome ends continuous recognition periodically on its own
        // (silence timeout, network blip) — restart it seamlessly so
        // wake-word listening feels "always on".
        const resumeCapturing = aiChatMode === "capturing";
        setTimeout(() => {
          if (!aiChatWakeEnabled) return;
          startAiChatPassiveListening();
          if (resumeCapturing) enterAiChatCapturingMode();
        }, 250);
      }
    };

    micBtn.addEventListener("click", () => {
      if (aiChatMode === "manual" && aiChatListening) {
        aiChatRecognition.stop();
        return;
      }
      // Manual press-to-talk always takes priority over passive
      // wake-word listening — stop passive first, then start fresh.
      clearAiChatCaptureTimer();
      try { aiChatRecognition.stop(); } catch (err) {}
      aiChatMode = "manual";
      aiChatRecognition.continuous = false;
      setTimeout(() => {
        try { aiChatRecognition.start(); } catch (err) {}
      }, 120);
    });
  }

  // ---- Voice output (reply → speech, female voice preferred) ----
  if (!aiChatTtsSupported && speakToggle) {
    speakToggle.style.display = "none";
  } else if (speakToggle) {
    try {
      aiChatSpeakEnabled = localStorage.getItem("citimotorsAiChatSpeak_v1") === "1";
    } catch (err) {
      aiChatSpeakEnabled = false;
    }
    updateAiChatSpeakToggleUI();

    // Voice lists load asynchronously in Chrome/Edge (empty on the
    // very first call) — refresh our pick whenever the browser
    // reports the list is ready, and also try once immediately for
    // Firefox/Safari, which often have it available right away.
    refreshAiChatVoicePick();
    if ("onvoiceschanged" in window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = refreshAiChatVoicePick;
    }

    speakToggle.addEventListener("click", () => {
      aiChatSpeakEnabled = !aiChatSpeakEnabled;
      try { localStorage.setItem("citimotorsAiChatSpeak_v1", aiChatSpeakEnabled ? "1" : "0"); } catch (err) {}
      if (!aiChatSpeakEnabled) window.speechSynthesis.cancel();
      updateAiChatSpeakToggleUI();
    });
  }
}

function stopAiChatListening() {
  aiChatListening = false;
  const micBtn = getEl("aiChatMicBtn");
  const voiceStatus = getEl("aiChatVoiceStatus");
  if (micBtn) { micBtn.classList.remove("ai-chat-mic-listening"); micBtn.setAttribute("aria-pressed", "false"); }
  if (voiceStatus) voiceStatus.style.display = "none";
}

function updateAiChatSpeakToggleUI() {
  const toggle = getEl("aiChatSpeakToggle");
  const onIcon = getEl("aiChatSpeakOnIcon");
  const offIcon = getEl("aiChatSpeakOffIcon");
  if (!toggle) return;
  toggle.setAttribute("aria-pressed", String(aiChatSpeakEnabled));
  toggle.title = aiChatSpeakEnabled ? "Read replies aloud (Nala's voice): on" : "Read replies aloud (Nala's voice): off";
  if (onIcon) onIcon.style.display = aiChatSpeakEnabled ? "" : "none";
  if (offIcon) offIcon.style.display = aiChatSpeakEnabled ? "none" : "";
}

// ---- Female voice selection ----
// speechSynthesis doesn't expose a gender field, so this matches
// against the names browsers commonly ship for their female system
// voices, in priority order. Falls back gracefully: any voice
// matching the page language, then simply the first available voice,
// so speech still works even if no clearly-female voice is installed.
let aiChatPreferredVoice = null;

const AI_CHAT_FEMALE_VOICE_HINTS = [
  "female",
  "google uk english female",
  "google us english",
  "microsoft zira",
  "zira",
  "samantha",
  "victoria",
  "karen",
  "moira",
  "tessa",
  "fiona",
  "susan",
  "linda",
  "ava",
  "serena",
  "allison",
  "kathy",
  "veena",
  "heera",
  "salli",
  "joanna",
  "kendra",
  "kimberly",
  "ivy",
  "google filipino",
];

function refreshAiChatVoicePick() {
  if (!aiChatTtsSupported) return;
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return;

  const pageLang = (document.documentElement.lang || "en").toLowerCase();

  // 1) Exact/substring match against known female voice names.
  let match = voices.find((v) => AI_CHAT_FEMALE_VOICE_HINTS.some((hint) => v.name.toLowerCase().includes(hint)));

  // 2) Same-language voice with "female" anywhere in its name/voiceURI.
  if (!match) {
    match = voices.find(
      (v) => v.lang.toLowerCase().startsWith(pageLang.slice(0, 2)) && /female/i.test(v.name + v.voiceURI)
    );
  }

  // 3) Any voice matching the page language at all.
  if (!match) {
    match = voices.find((v) => v.lang.toLowerCase().startsWith(pageLang.slice(0, 2)));
  }

  // 4) Last resort: whatever the browser offers first.
  if (!match) match = voices[0];

  aiChatPreferredVoice = match || null;
}

// Strips light Markdown down to plain speakable text before handing
// it to speechSynthesis, so it doesn't read out asterisks/backticks.
function speakAiChatReply(text) {
  if (!aiChatTtsSupported || !aiChatSpeakEnabled || !text) return;
  const plain = text
    .replace(/[*_`#]/g, "")
    .replace(/^\s*[-\d.)]+\s+/gm, "")
    .trim();
  if (!plain) return;
  window.speechSynthesis.cancel(); // never overlap with a previous reply
  if (!aiChatPreferredVoice) refreshAiChatVoicePick(); // one more attempt in case voices just finished loading
  const utterance = new SpeechSynthesisUtterance(plain);
  utterance.lang = document.documentElement.lang || "en-US";
  if (aiChatPreferredVoice) utterance.voice = aiChatPreferredVoice;
  utterance.pitch = 1.05; // slightly brighter, more natural for a female voice
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

// ---- Hook into sendAiChatMessage's result without modifying it ----
// sendAiChatMessage() already pushes { role: "assistant", ... } onto
// aiChatMessages and calls renderAiChatMessages(). We wrap the
// existing function reference here (composition, not editing the
// function body above) so a new assistant reply also gets spoken
// when voice output is on. If sendAiChatMessage isn't defined for
// any reason, this is a silent no-op and typing/chat still works.
if (typeof sendAiChatMessage === "function") {
  const _originalSendAiChatMessage = sendAiChatMessage;
  sendAiChatMessage = async function (question) {
    const countBefore = aiChatMessages.length;
    await _originalSendAiChatMessage(question);
    const newAssistantMsgs = aiChatMessages.slice(countBefore).filter((m) => m.role === "assistant" && !m.error);
    newAssistantMsgs.forEach((m) => speakAiChatReply(m.content));
  };
}

initAiChatVoice();
initAiChatWakeWord();

// ============================================================
// ================= AI CHAT — WAKE WORD MODULE ================
// "Jarvis mode": when enabled, keeps a background SpeechRecognition
// session running (continuous: true) and listens for a wake phrase.
// Once heard, it opens the chat panel and either (a) sends whatever
// the user said right after the wake phrase in the same breath, or
// (b) if they just said the wake phrase alone, switches to a short
// "capturing" window and sends the next thing they say.
//
// This reuses the SAME aiChatRecognition instance created in
// initAiChatVoice() (browsers only allow one active recognition
// session at a time) — it just changes .continuous on the fly and
// tracks a small state machine (aiChatMode) so the manual
// press-to-talk mic button and passive wake-word listening never
// fight over the mic. Nothing above this block is modified.
// ============================================================

const AI_CHAT_WAKE_WORDS = [
  "hey nala",
  "hi nala",
  "hey nala assistant",
  "ok nala",
  "nala",
];
const AI_CHAT_WAKE_STORAGE_KEY = "citimotorsAiChatWake_v1";
const AI_CHAT_CAPTURE_TIMEOUT_MS = 7000;

let aiChatWakeEnabled = false;
let aiChatMode = "idle"; // idle | manual | passive | capturing
let aiChatCaptureTimer = null;

function normalizeAiChatSpeech(text) {
  return String(text || "").toLowerCase().trim().replace(/[.,!?]+$/g, "");
}

function findAiChatWakeMatch(normalizedText) {
  for (const phrase of AI_CHAT_WAKE_WORDS) {
    const idx = normalizedText.indexOf(phrase);
    if (idx !== -1) {
      return { phrase, remainder: normalizedText.slice(idx + phrase.length).trim() };
    }
  }
  return null;
}

function initAiChatWakeWord() {
  const wakeToggle = getEl("aiChatWakeToggle");
  if (!wakeToggle) return;

  if (!aiChatSpeechSupported) {
    wakeToggle.style.display = "none";
    return;
  }

  try {
    aiChatWakeEnabled = localStorage.getItem(AI_CHAT_WAKE_STORAGE_KEY) === "1";
  } catch (err) {
    aiChatWakeEnabled = false;
  }
  updateAiChatWakeToggleUI();
  if (aiChatWakeEnabled) startAiChatPassiveListening();

  wakeToggle.addEventListener("click", () => {
    aiChatWakeEnabled = !aiChatWakeEnabled;
    try { localStorage.setItem(AI_CHAT_WAKE_STORAGE_KEY, aiChatWakeEnabled ? "1" : "0"); } catch (err) {}
    updateAiChatWakeToggleUI();
    if (aiChatWakeEnabled) {
      startAiChatPassiveListening();
    } else {
      stopAiChatPassiveListening();
    }
  });
}

function updateAiChatWakeToggleUI() {
  const toggle = getEl("aiChatWakeToggle");
  const onIcon = getEl("aiChatWakeOnIcon");
  const offIcon = getEl("aiChatWakeOffIcon");
  const toggleBtn = getEl("aiChatToggle");
  const ring = getEl("aiChatWakeRing");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(aiChatWakeEnabled));
    toggle.title = aiChatWakeEnabled
      ? 'Wake word ("Hey Nala"): on'
      : 'Wake word ("Hey Nala"): off';
  }
  if (onIcon) onIcon.style.display = aiChatWakeEnabled ? "" : "none";
  if (offIcon) offIcon.style.display = aiChatWakeEnabled ? "none" : "";
  if (ring) ring.style.display = aiChatWakeEnabled ? "block" : "none";
  if (toggleBtn) toggleBtn.classList.toggle("ai-chat-wake-capturing", aiChatMode === "capturing");
}

function startAiChatPassiveListening() {
  if (!aiChatRecognition || aiChatMode === "manual") return; // let a manual recording finish first
  try {
    aiChatMode = "passive";
    aiChatRecognition.continuous = true;
    aiChatRecognition.interimResults = true;
    aiChatRecognition.start();
  } catch (err) {
    // Already running — fine, onend will loop us back here if needed.
  }
}

function stopAiChatPassiveListening() {
  clearAiChatCaptureTimer();
  if (aiChatMode === "passive" || aiChatMode === "capturing") {
    aiChatMode = "idle";
    try { aiChatRecognition && aiChatRecognition.stop(); } catch (err) {}
  }
  updateAiChatWakeToggleUI();
}

function clearAiChatCaptureTimer() {
  if (aiChatCaptureTimer) { clearTimeout(aiChatCaptureTimer); aiChatCaptureTimer = null; }
}

function enterAiChatCapturingMode() {
  aiChatMode = "capturing";
  updateAiChatWakeToggleUI();
  const voiceStatus = getEl("aiChatVoiceStatus");
  if (voiceStatus) {
    voiceStatus.classList.remove("ai-chat-voice-status--wake");
    voiceStatus.innerHTML = `<span class="ai-chat-voice-dot"></span> Yes? Listening for your question…`;
    voiceStatus.style.display = "flex";
  }
  if (!openAiChatPanelIfClosed()) { /* already open */ }
  clearAiChatCaptureTimer();
  aiChatCaptureTimer = setTimeout(() => {
    // No follow-up heard in time — quietly go back to passive standby.
    if (aiChatMode === "capturing") backToAiChatPassiveMode();
  }, AI_CHAT_CAPTURE_TIMEOUT_MS);
}

function backToAiChatPassiveMode() {
  clearAiChatCaptureTimer();
  const voiceStatus = getEl("aiChatVoiceStatus");
  if (voiceStatus) voiceStatus.style.display = "none";
  aiChatMode = aiChatWakeEnabled ? "passive" : "idle";
  updateAiChatWakeToggleUI();
}

function openAiChatPanelIfClosed() {
  if (!aiChatOpen) { openAiChat(); return true; }
  return false;
}

// Handles a finalized speech result while in passive/capturing mode.
// Called from the shared onresult handler in initAiChatVoice() below
// via the aiChatHandleWakeResult hook.
function aiChatHandleWakeResult(finalTranscript) {
  const normalized = normalizeAiChatSpeech(finalTranscript);
  if (!normalized) return;

  if (aiChatMode === "capturing") {
    clearAiChatCaptureTimer();
    backToAiChatPassiveMode();
    sendAiChatMessage(finalTranscript.trim());
    return;
  }

  // aiChatMode === "passive": only act if a wake word was actually heard.
  const match = findAiChatWakeMatch(normalized);
  if (!match) return;

  if (match.remainder) {
    openAiChatPanelIfClosed();
    sendAiChatMessage(match.remainder);
    // stay in passive mode — no need to wait for a follow-up
  } else {
    enterAiChatCapturingMode();
  }
}

// ============================================================
// ==================== NALA AUTO-GREET MODULE ==================
// The moment live dashboard data has actually loaded (currentData
// populated by loadDashboard(), same global used by Overview),
// Nala opens the chat panel on her own and posts a short status
// greeting built entirely from that live data — no hardcoded
// numbers, nothing from the AI webhook (so it appears instantly
// and never depends on n8n/ngrok being reachable).
//
// The greeting is shown for this page load only — it is NOT saved
// into localStorage, so refreshing the dashboard always gets a
// fresh, current greeting instead of piling up old ones in chat
// history every time the page loads.
// ============================================================

let aiChatGreeted = false;

function composeNalaGreeting() {
  const rangeLabels = { today: "Today", "7d": "the last 7 days", "30d": "the last 30 days" };
  const rangeLabel = rangeLabels[currentRange] || currentRange;
  const ranges = (currentData && currentData.ranges) || {};
  const r = ranges[currentRange] || {};

  const lines = [];
  lines.push(`Hi, I'm **Nala** 👋 Here's where things stand for **${rangeLabel}**:`);

  const stats = [];
  if (r.spend !== undefined) stats.push(`Spend **${formatCurrency(r.spend)}**`);
  if (r.messages !== undefined) stats.push(`**${formatNumber(r.messages)}** messages`);
  if (r.ctr !== undefined) stats.push(`CTR **${formatPercent(r.ctr)}**`);
  const costPerMsg = r.costPerMessage ?? r.cost_per_message;
  if (costPerMsg !== undefined) stats.push(`cost/message **${formatCurrency(costPerMsg)}**`);
  if (stats.length) lines.push(stats.join(" · "));

  if (currentData && currentData.accountHealth !== undefined && currentData.accountHealth !== null) {
    lines.push(`Account health: **${currentData.accountHealth}/100**`);
  }

  const topCampaign = currentData && currentData.topCampaign;
  const topCampaignName = topCampaign && (topCampaign.name || topCampaign.campaign_name || topCampaign.title);
  if (topCampaignName) lines.push(`Top campaign right now: **${topCampaignName}**`);

  if (aiData && Array.isArray(aiData.recommendations) && aiData.recommendations.length > 0) {
    const first = aiData.recommendations[0];
    const text = typeof first === "string" ? first : (first.title || first.detail);
    if (text) lines.push(`One thing worth a look: ${text}`);
  }

  if (r.spend === undefined && !topCampaignName) {
    lines.push(`No live numbers are coming through for ${rangeLabel} just yet — ask me once your campaigns have data, or try a different range.`);
  }

  lines.push(`Ask me anything, or tap the mic 🎙️.`);

  return lines.join("\n\n");
}

function tryNalaAutoGreet() {
  if (aiChatGreeted) return;
  // Wait until Overview's real fetch has actually resolved at least
  // once (currentData is set inside loadDashboard() after a
  // successful fetch) — not just "the page is up".
  if (!currentData || !currentData.ranges) return;

  aiChatGreeted = true;

  const greeting = { role: "assistant", content: composeNalaGreeting(), transient: true };
  aiChatMessages.push(greeting);
  openAiChat();
  renderAiChatMessages();
  speakAiChatReply(greeting.content);
}

const aiChatGreetPoll = setInterval(() => {
  tryNalaAutoGreet();
  if (aiChatGreeted) clearInterval(aiChatGreetPoll);
}, 400);
// Safety net: stop polling after 20s even if data never loads, so a
// permanently-broken dashboard.json can't leave a stray interval
// running forever.
setTimeout(() => clearInterval(aiChatGreetPoll), 20000);
