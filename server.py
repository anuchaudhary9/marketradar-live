"""
MarketRadar backend
"""

import io
import csv
import time
import zipfile
import datetime as dt
import os

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

SCRAPERAPI_KEY = os.environ.get("SCRAPERAPI_KEY")

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

        if SCRAPERAPI_KEY:
            # Route all traffic through ScraperAPI proxy, keeping a sticky
            # session so cookies persist across requests.
            proxy_url = (
                f"http://scraperapi.session_number=1:{SCRAPERAPI_KEY}"
                f"@proxy-server.scraperapi.com:8001"
            )
            s.proxies = {"http": proxy_url, "https": proxy_url}
            s.verify = False
            requests.packages.urllib3.disable_warnings()

        s.get(NSE_HOME, timeout=30)
        s.get("https://www.nseindia.com/option-chain", timeout=30)
        _session = s
        _session_time = time.time()
    return _session
