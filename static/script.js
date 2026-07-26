const fmt = (n) => (n === null || n === undefined || Number.isNaN(n)) ? "--" : Number(n).toLocaleString("en-IN");
const fmtSigned = (n) => (n === null || n === undefined) ? "--" : (n >= 0 ? "+" : "") + fmt(n);

let lastOptionChain = null;
let lastParticipant = null;

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

function findClientRow(rows, keyword) {
  if (!rows) return null;
  return rows.find(r => (r.client || "").toLowerCase().includes(keyword)) || null;
}

async function loadOptionChain() {
  try {
    const res = await fetch("/api/option-chain?symbol=NIFTY");
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    lastOptionChain = data;

    const spot = data.spot;
    const rows = data.rows || [];
    const totalCallOi = data.totalCallOi || 0;
    const totalPutOi = data.totalPutOi || 0;
    const pcr = data.pcr ?? (totalCallOi ? +(totalPutOi / totalCallOi).toFixed(2) : null);

    let maxCallRow = rows.reduce((a, b) => (b.callOi > (a?.callOi || 0) ? b : a), null);
    let maxPutRow = rows.reduce((a, b) => (b.putOi > (a?.putOi || 0) ? b : a), null);

    document.getElementById("hSpot").textContent = fmt(spot);
    document.getElementById("hChange").textContent = "--";
    document.getElementById("hPcr").textContent = pcr ?? "--";

    document.getElementById("mSpot").textContent = fmt(spot);
    document.getElementById("mPcr").textContent = pcr ?? "--";
    document.getElementById("mPcrTag").textContent = pcr ? (pcr > 1 ? "put-heavy" : "call-heavy") : "--";
    document.getElementById("mResistance").textContent = maxCallRow ? fmt(maxCallRow.strike) : "--";
    document.getElementById("mSupport").textContent = maxPutRow ? fmt(maxPutRow.strike) : "--";

    document.getElementById("ocTotalCall").textContent = fmt(totalCallOi);
    document.getElementById("ocTotalPut").textContent = fmt(totalPutOi);
    document.getElementById("ocPcr").textContent = pcr ?? "--";
    document.getElementById("ocMaxCall").textContent = maxCallRow ? fmt(maxCallRow.strike) : "--";
    document.getElementById("ocMaxPut").textContent = maxPutRow ? fmt(maxPutRow.strike) : "--";

    const tbody = document.getElementById("ocBody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="loading">No rows returned</td></tr>`;
    } else {
      const nearIdx = rows.reduce((best, r, i) =>
        Math.abs(r.strike - spot) < Math.abs(rows[best].strike - spot) ? i : best, 0);
      const start = Math.max(0, nearIdx - 15);
      const end = Math.min(rows.length, nearIdx + 15);
      const visible = rows.slice(start, end);

      tbody.innerHTML = visible.map(r => `
        <tr>
          <td class="${r.callChgOi >= 0 ? 'chg-pos' : 'chg-neg'}">${fmt(r.callChgOi)}</td>
          <td class="call-cell">${fmt(r.callOi)}</td>
          <td>${r.callLtp?.toFixed ? r.callLtp.toFixed(2) : r.callLtp}</td>
          <td class="strike-col">${r.strike}</td>
          <td>${r.putLtp?.toFixed ? r.putLtp.toFixed(2) : r.putLtp}</td>
          <td class="put-cell">${fmt(r.putOi)}</td>
          <td class="${r.putChgOi >= 0 ? 'chg-pos' : 'chg-neg'}">${fmt(r.putChgOi)}</td>
        </tr>
      `).join("");
    }

    updateGauge(pcr);
    updateSignals(pcr, maxCallRow, maxPutRow, spot);
    updateAnomalies(rows);
  } catch (err) {
    console.error("loadOptionChain failed:", err);
    document.getElementById("ocBody").innerHTML =
      `<tr><td colspan="7" class="loading">Error: ${err.message}</td></tr>`;
  }
}

function updateGauge(pcr) {
  const arc = document.getElementById("gaugeArc");
  const valueEl = document.getElementById("gaugeValue");
  const labelEl = document.getElementById("gaugeLabel");
  const subEl = document.getElementById("gaugeSub");

  if (pcr === null || pcr === undefined) {
    valueEl.textContent = "--";
    labelEl.textContent = "--";
    subEl.textContent = "--";
    return;
  }

  // Map PCR roughly 0.5 (bearish) - 1.5 (bullish) onto 0-1 gauge fraction
  const clamped = Math.max(0.5, Math.min(1.5, pcr));
  const frac = (clamped - 0.5) / 1.0;
  const circumference = 283;
  arc.setAttribute("stroke-dashoffset", String(circumference * (1 - frac)));

  valueEl.textContent = pcr;
  if (pcr > 1.1) {
    labelEl.textContent = "Bullish";
    subEl.textContent = "Put writers dominant";
  } else if (pcr < 0.9) {
    labelEl.textContent = "Bearish";
    subEl.textContent = "Call writers dominant";
  } else {
    labelEl.textContent = "Neutral";
    subEl.textContent = "Balanced positioning";
  }
}

function updateSignals(pcr, maxCallRow, maxPutRow, spot) {
  const list = document.getElementById("signalList");
  const signals = [];

  if (pcr !== null && pcr !== undefined) {
    signals.push({
      label: "PCR",
      value: pcr,
      note: pcr > 1 ? "Put-heavy (bullish bias)" : "Call-heavy (bearish bias)",
    });
  }
  if (maxCallRow) {
    signals.push({ label: "Resistance", value: maxCallRow.strike, note: "Max call OI strike" });
  }
  if (maxPutRow) {
    signals.push({ label: "Support", value: maxPutRow.strike, note: "Max put OI strike" });
  }
  if (spot && maxCallRow && maxPutRow) {
    const inRange = spot > maxPutRow.strike && spot < maxCallRow.strike;
    signals.push({
      label: "Range",
      value: inRange ? "Inside" : "Outside",
      note: `Spot vs ${maxPutRow.strike}-${maxCallRow.strike} band`,
    });
  }

  list.innerHTML = signals.length
    ? signals.map(s => `
        <div class="signal-row">
          <span class="signal-label">${s.label}</span>
          <span class="signal-value">${s.value}</span>
          <span class="signal-note">${s.note}</span>
        </div>
      `).join("")
    : `<div class="loading">No signals available</div>`;
}

function updateAnomalies(rows) {
  const list = document.getElementById("anomalyList");
  if (!rows || !rows.length) {
    list.innerHTML = `<div class="loading">No data</div>`;
    return;
  }

  const threshold = 50000;
  const anomalies = rows
    .filter(r => Math.abs(r.callChgOi) > threshold || Math.abs(r.putChgOi) > threshold)
    .sort((a, b) => (Math.abs(b.callChgOi) + Math.abs(b.putChgOi)) - (Math.abs(a.callChgOi) + Math.abs(a.putChgOi)))
    .slice(0, 8);

  list.innerHTML = anomalies.length
    ? anomalies.map(r => `
        <div class="anomaly-row">
          <span class="anomaly-strike">${r.strike}</span>
          <span class="${r.callChgOi >= 0 ? 'chg-pos' : 'chg-neg'}">Call ${fmtSigned(r.callChgOi)}</span>
          <span class="${r.putChgOi >= 0 ? 'chg-pos' : 'chg-neg'}">Put ${fmtSigned(r.putChgOi)}</span>
        </div>
      `).join("")
    : `<div class="loading">No significant OI changes</div>`;
}

async function loadParticipantOi() {
  try {
    const res = await fetch("/api/participant-oi");
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    lastParticipant = data;
    const rows = data.rows || [];

    const fii = findClientRow(rows, "fii");
    const dii = findClientRow(rows, "dii");

    if (fii) {
      const fiiNet = (fii.futIndexLong - fii.futIndexShort) + (fii.optIndexCallLong - fii.optIndexCallShort);
      document.getElementById("mFiiNet").textContent = fmtSigned(fiiNet);
      document.getElementById("mFiiLS").textContent =
        `L ${fmt(fii.futIndexLong)} / S ${fmt(fii.futIndexShort)}`;
    }
    if (dii) {
      const diiNet = (dii.futIndexLong - dii.futIndexShort) + (dii.optIndexCallLong - dii.optIndexCallShort);
      document.getElementById("mDiiNet").textContent = fmtSigned(diiNet);
    }

    const futBody = document.getElementById("futBody");
    futBody.innerHTML = rows.length
      ? rows.map(r => {
          const net = r.futIndexLong - r.futIndexShort;
          return `
            <tr>
              <td class="left">${r.client}</td>
              <td>${fmt(r.futIndexLong)}</td>
              <td>${fmt(r.futIndexShort)}</td>
              <td class="${net >= 0 ? 'chg-pos' : 'chg-neg'}">${fmtSigned(net)}</td>
              <td>${net >= 0 ? "Long bias" : "Short bias"}</td>
            </tr>
          `;
        }).join("")
      : `<tr><td colspan="5" class="loading">No data</td></tr>`;

    const optBody = document.getElementById("optBody");
    optBody.innerHTML = rows.length
      ? rows.map(r => {
          const net = (r.optIndexCallLong - r.optIndexCallShort) - (r.optIndexPutLong - r.optIndexPutShort);
          return `
            <tr>
              <td class="left">${r.client}</td>
              <td>${fmt(r.optIndexCallLong)}</td>
              <td>${fmt(r.optIndexCallShort)}</td>
              <td>${fmt(r.optIndexPutLong)}</td>
              <td>${fmt(r.optIndexPutShort)}</td>
              <td class="${net >= 0 ? 'chg-pos' : 'chg-neg'}">${fmtSigned(net)}</td>
            </tr>
          `;
        }).join("")
      : `<tr><td colspan="6" class="loading">No data</td></tr>`;

    renderNetPositionChart(rows);
  } catch (err) {
    console.error("loadParticipantOi failed:", err);
    document.getElementById("futBody").innerHTML =
      `<tr><td colspan="5" class="loading">Error: ${err.message}</td></tr>`;
    document.getElementById("optBody").innerHTML =
      `<tr><td colspan="6" class="loading">Error: ${err.message}</td></tr>`;
  }
}

function renderNetPositionChart(rows) {
  const container = document.getElementById("netPositionChart");
  if (!rows || !rows.length) {
    container.innerHTML = `<div class="loading">No data</div>`;
    return;
  }
  const bars = rows.map(r => {
    const net = r.futIndexLong - r.futIndexShort;
    return { client: r.client, net };
  });
  const maxAbs = Math.max(...bars.map(b => Math.abs(b.net)), 1);

  container.innerHTML = bars.map(b => {
    const pct = Math.round((Math.abs(b.net) / maxAbs) * 100);
    return `
      <div class="bar-row">
        <span class="bar-label">${b.client}</span>
        <div class="bar-track">
          <div class="bar-fill ${b.net >= 0 ? 'bar-pos' : 'bar-neg'}" style="width:${pct}%"></div>
        </div>
        <span class="bar-value">${fmtSigned(b.net)}</span>
      </div>
    `;
  }).join("");
}

function updateLastRefresh() {
  const el = document.getElementById("lastRefresh");
  if (el) el.textContent = new Date().toLocaleTimeString("en-IN");
}

async function refreshAll() {
  await Promise.all([loadOptionChain(), loadParticipantOi()]);
  updateLastRefresh();
}

refreshAll();
setInterval(refreshAll, 60000);
