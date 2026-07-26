"""
MarketRadar backend
"""

import io
import csv
import time
import zipfile
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
NSE_FO_BHAVCOPY = (
    "https://nsearchives.nseindia.com/content/fo/"
    "BhavCopy_NSE_FO_0_0_0_{yyyymmdd}_F_0000.csv.zip"
)
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
SESSION_TTL_SECONDS = 240

_history = []
MAX_HISTORY_POINTS = 200

_bhav_cache = {"date": None, "rows": None}


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


def get_latest_trading_date():
    d = dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=30)  # IST
    if d.hour < 19:
        d -= dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d


def fetch_fo_bhavcopy(target_date):
    yyyymmdd = target_date.strftime("%Y%m%d")
    if _bhav_cache["date"] == yyyymmdd and _bhav_cache["rows"] is not None:
        return _bhav_cache["rows"]

    url = NSE_FO_BHAVCOPY.format(yyyymmdd=yyyymmdd)
    s = get_session()
    r = s.get(url, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"Bhavcopy fetch failed ({r.status_code}) for {yyyymmdd}")

    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        csv_name = z.namelist()[0]
        with z.open(csv_name) as f:
            text = f.read().decode("utf-8-sig")

    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    _bhav_cache["date"] = yyyymmdd
    _bhav_cache["rows"] = rows
    return rows


@app.route("/api/option-chain")
def option_chain():
    symbol = request.args.get("symbol", "NIFTY").upper()

    target_date = get_latest_trading_date()
    tried_dates = []
    rows = None
    last_err = None

    d = target_date
    for _ in range(5):
        tried_dates.append(d.strftime("%d-%b-%Y"))
        try:
            rows = fetch_fo_bhavcopy(d)
            break
        except Exception as e:
            last_err = e
            d -= dt.timedelta(days=1)
            while d.weekday() >= 5:
                d -= dt.timedelta(days=1)

    if rows is None:
        return jsonify({
            "error": f"Could not fetch bhavcopy: {last_err}",
            "triedDates": tried_dates,
        }), 502

    sym_rows = [row for row in rows if row.get("TckrSymb") == symbol]
    if not sym_rows:
        return jsonify({"error": f"No option data found for {symbol}", "date": d.strftime("%d-%b-%Y")}), 404

    expiries = sorted(set(row["XpryDt"] for row in sym_rows if row.get("XpryDt")))
    nearest_expiry = expiries[0] if expiries else None

    by_strike = {}
    underlying = None
    for row in sym_rows:
        if row.get("XpryDt") != nearest_expiry:
            continue
        try:
            strike = float(row["StrkPric"])
        except (ValueError, TypeError):
            continue
        opt_type = (row.get("OptnTp") or "").strip()
        entry = by_strike.setdefault(strike, {
            "strike": strike, "callOi": 0, "callChgOi": 0, "callLtp": 0,
            "putOi": 0, "putChgOi": 0, "putLtp": 0,
        })
        oi = int(float(row.get("OpnIntrst") or 0))
        chg_oi = int(float(row.get("ChngInOpnIntrst") or 0))
        ltp = float(row.get("ClsPric") or 0)
        if row.get("UndrlygPric"):
            try:
                underlying = float(row["UndrlygPric"])
            except ValueError:
                pass
        if opt_type == "CE":
            entry["callOi"], entry["callChgOi"], entry["callLtp"] = oi, chg_oi, ltp
        elif opt_type == "PE":
            entry["putOi"], entry["putChgOi"], entry["putLtp"] = oi, chg_oi, ltp

    rows_out = sorted(by_strike.values(), key=lambda x: x["strike"])
    total_call_oi = sum(r["callOi"] for r in rows_out)
    total_put_oi = sum(r["putOi"] for r in rows_out)
    pcr = round(total_put_oi / total_call_oi, 2) if total_call_oi else None

    _history.append({"t": dt.datetime.utcnow().isoformat() + "Z", "spot": underlying, "pcr": pcr})
    if len(_history) > MAX_HISTORY_POINTS:
        del _history[0]

    return jsonify({
        "symbol": symbol,
        "spot": underlying,
        "expiry": nearest_expiry,
        "dataDate": d.strftime("%d-%b-%Y"),
        "isLive": False,
        "totalCallOi": total_call_oi,
        "totalPutOi": total_put_oi,
        "pcr": pcr,
        "rows": rows_out,
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
            return jsonify({"error": "NSE returned " + str(r.status_code) + " for " + url}), 502
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
