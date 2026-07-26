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
          <td class="${r.putChgOi >= 0  ? 'chg-pos' : 'chg-neg'}">${fmt(r.putChgOi)}</td>
        </tr>
      `).join("");
    }

    updateG
