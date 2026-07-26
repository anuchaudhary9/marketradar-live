"""
MarketRadar backend
"""

import io
import csv
import time
import datetime as dt

import requests
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder="static")
CORS(app)


@app.route("/")
def home():
    return send_from_directory(app.static_folder, "index.html")


NSE_HOME = "https://www.nseindia.com"
NSE_OPTION_CHAIN = "https://www.nseindia.com/api/option-chain-indices"
NSE_PARTICIPANT_OI = "https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_{ddmmyyyy}.csv"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/option-chain",
}

_session = None
_session_time = 0
SESSION_TTL_SECONDS = 60 * 4

# In-memory history for the Spot & PCR chart. Resets on server restart
# (free-tier Render sleeps after 15 min idle) -- builds up while the app is
# actively being used since there's no database in this setup.
_history = []
MAX_HISTORY_POINTS = 200


def get_session():
    global _session, _session_time
    if _session is None or (time.time() - _session_time) > SESSION_TTL_SECONDS:
        s = requests.Session()
        s.headers.update(HEADERS)
        s.get(NSE_HOME, timeout=20)
        s.get("https://www.nseindia.com/option-chain", timeout=20)
        _session = s
        _session_time = time.time()
    return _session


@app.route("/api/option-chain")
def option_chain():
    symbol = request.args.get("symbol", "NIFTY").upper()
    try:
        s = get_session()
        r = s.get(NSE_OPTION_CHAIN, params={"symbol": symbol}, timeout=20)
        if r.status_code != 200:
            return jsonify({"error": f"NSE returned {r.status_code}"}), 502
        raw = r.json()
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    records = raw.get("records", {})
    spot = records.get("underlyingValue")
    expiry = (records.get("expiryDates") or [None])[0]
    rows = []
    for item in records.get("data", []):
        if item.get("expiryDate") != expiry:
            continue
        ce = item.get("CE", {})
        pe = item.get("PE", {})
        rows.append({
            "strike": item.get("strikePrice"),
            "callOi": ce.get("openInterest", 0),
            "callChgOi": ce.get("changeinOpenInterest", 0),
            "callIv": ce.get("impliedVolatility", 0),
            "callLtp": ce.get("lastPrice", 0),
            "putOi": pe.get("openInterest", 0),
            "putChgOi": pe.get("changeinOpenInterest", 0),
            "putIv": pe.get("impliedVolatility", 0),
            "putLtp": pe.get("lastPrice", 0),
        })
    rows.sort(key=lambda x: x["strike"])

    total_call_oi = sum(r["callOi"] for r in rows)
    total_put_oi = sum(r["putOi"] for r in rows)
    pcr = round(total_put_oi / total_call_oi, 2) if total_call_oi else None

    _history.append({
        "t": dt.datetime.utcnow().isoformat() + "Z",
        "spot": spot,
        "pcr": pcr,
    })
    if len(_history) > MAX_HISTORY_POINTS:
        del _history[0]

    return jsonify({
        "symbol": symbol,
        "spot": spot,
        "expiry": expiry,
        "totalCallOi": total_call_oi,
        "totalPutOi": total_put_oi,
        "pcr": pcr,
        "rows": rows,
        "fetchedAt": dt.datetime.utcnow().isoformat() + "Z",
    })


@app.route("/api/history")
def history():
    return jsonify({"points": _history})


@app.route("/api/participant-oi")
def participant_oi():
    date_str = request.args.get("date")
    if date_str:
        d = dt.datetime.strptime(date_str, "%d-%m-%Y")
    else:
        d = dt.datetime.utcnow()
        while d.weekday() >= 5:
            d -= dt.timedelta(days=1)

    url = NSE_PARTICIPANT_OI.format(ddmmyyyy=d.strftime("%d%m%Y"))
    try:
        s = get_session()
        r = s.get(url, timeout=20)
        if r.status_code != 200:
            return jsonify({"error": f"NSE returned {r.status_code} for {url}"}), 502
        text = r.content.decode("utf-8-sig")
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    reader = csv.reader(io.StringIO(text))
    parsed = []
    for row in reader:
        if not row or not row[0].strip() or row[0].strip().lower().startswith("client type"):
            continue
        parsed.append(row)

    result = []
    for row in parsed:
        try:
            result.append({
                "client": row[0].strip(),
                "futIndexLong": int(float(row[1])),
                "futIndexShort": int(float(row[2])),
                "futStockLong": int(float(row[3])),
                "futStockShort": int(float(row[4])),
                "optIndexCallLong": int(float(row[5])),
                "optIndexCallShort": int(float(row[6])),
                "optIndexPutLong": int(float(row[7])),
                "optIndexPutShort": int(float(row[8])),
            })
        except (ValueError, IndexError):
            continue

    return jsonify({"date": d.strftime("%d-%b-%Y"), "rows": result})


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "time": dt.datetime.utcnow().isoformat() + "Z"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
