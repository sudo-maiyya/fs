"""
mtf_brain.py
Subscribes to Redis, runs dynamic MTF footprint logic, and emits signals.
Upgrades: IST Time, Strategy Names, Symbol Formatting, Async Order Execution to Main Project.
Fixes: Bias vs Trigger gating, CVD Stitching, Volume Velocity Tape, Grade-Based Risk, Intra-flip stabilization.
"""
import os, time, threading, collections, math, sqlite3, json, queue, atexit, re, io
import pandas as pd
import numpy as np
import redis
import requests as _req
from datetime import datetime, time as dtime, timezone, timedelta
from dotenv import load_dotenv
import logging
from logging.handlers import RotatingFileHandler
from fyers_apiv3 import fyersModel
import urllib.parse
import hashlib
import builtins
import pytz
import json

# Import the Bootstrap system
from bootstrap_history import bootstrap_all_symbols

load_dotenv()
log_file = os.getenv("LOG_PATH", "backend_engine.log")

# 🔥 THE FIX: Docker Volume Quirk Workaround
# If Docker accidentally created the log file path as a directory, write inside it.
if os.path.isdir(log_file):
    log_file = os.path.join(log_file, "system.log")

handler = logging.FileHandler(log_file)
handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
app_log = logging.getLogger('root')
app_log.setLevel(logging.INFO); app_log.addHandler(handler)

def safe_print(*args, **kwargs):
    app_log.info(" ".join(map(str, args)))
    builtins.print(*args, **kwargs)
print = safe_print

redis_client = redis.Redis(host='redis', port=6379, db=0, decode_responses=True)
fyers = fyersModel.FyersModel(client_id=os.getenv("FYERS_CLIENT_ID"), token=os.getenv("FYERS_ACCESS_TOKEN", ""), log_path="")

# ── Global Configurations & Timezones ──────────────────────────────
IST = timezone(timedelta(hours=5, minutes=30))

CFG = dict(
    bar_5s_sec=5, bar_5m_sec=300, bar_15m_sec=900, bar_1h_sec=3600,
    ofi_fast_window=5, ofi_slow_window=20, ofi_aggr_thresh=0.55, ofi_passive_thresh=0.25,
    tape_window_sec=3.0, tape_normal_tps=3.0, tape_fast_mult=2.5, tape_urgent_mult=4.0,
    tape_min_for_signal=2.0, bar_aggr_ratio_thresh=0.68, bar_min_vol_preclose=200,
    bar_intra_flip_min=150, preclose_window_sec=1.5, cvd_flip_min=200, spread_window=50,
    spread_tight_z=-1.2, spread_wide_z=1.5, spread_alert_z=2.0, absorb_vol_mult=2.0,
    absorb_range_pct=0.4, absorb_bars=3, sweep_snap_pct=0.6,
    
    # 🔥 FAST WARM-UP FIX: Lowered lookbacks to arm the system faster on Expiry days
    m5_div_lookback=5, m5_ofi_shift_window=4, m5_compression_bars=3,
    m15_trend_ma=4, m15_cvd_momentum_bars=3, m15_zone_strength_pct=0.80,m15_ofi_shift_window=4,
    
    m1h_accum_range_pct=0.35, m1h_accum_vol_mult=1.5, m1h_accum_bars=5,
    m1h_dist_cvd_div_pct=0.5, m1h_expand_delta_min=500, m1h_manip_snap_pct=0.55,
    
    score_sweep=20, score_tape_urgent=20, score_spread_alert=20, score_ofi_shift=15,
    score_cvd_div_tick=15, score_intra_flip=15, score_aggr_ratio=15, score_tape_fast=10,
    score_absorption=10, score_large_lot=10, score_fbo_penalty=-25,
    score_1h_bias_agree=25, score_15m_trend_agree=20, score_5m_setup_armed=15,
    score_5m_cvd_div=10, score_15m_ofi_shift=10,
    
    # ── ADDED: OI ENGINE SCORING & CONFIGS ──
    score_oi_buildup=20, score_oi_unwind=15, score_oi_pcr_extreme=15,
    oi_poll_sec=300, oi_buildup_thresh=0.08, oi_unwind_thresh=-0.05,
    oi_pcr_bull=0.7, oi_pcr_bear=1.4,
    
    grade_ap_thresh=85, grade_a_thresh=65, grade_b_thresh=45,
    # 🔥 BLIND TAPE FIX: skip_grade_b=False lets tape scalps trigger when macro data is missing
    min_rr=1.5, cooldown_sec=300, skip_grade_b=True, no_trade_before=dtime(9, 15), # Updated Cooldown & Time
    no_trade_after=dtime(15, 0), sl_buffer_ticks=2, sl_min_pts=0.25,
    
    push_state_every_n_ticks=5,      
    push_state_min_interval=0.08,    
)
TICK = 0.05
DB = os.getenv("DB_PATH", "/app/data/nifty_mtf.db")

# ── Async Queues (DB, Webhooks & Orders) ──────────────────────────
os.makedirs(os.path.dirname(DB), exist_ok=True)
db_queue = queue.Queue(maxsize=50000)
webhook_queue = queue.Queue()
order_queue = queue.Queue() # New queue for placing cross-project orders

# Connect to the main paper trading project
SERVER_SIDE_EXECUTION="True"
MAIN_PROJECT_URL = os.getenv("MAIN_PROJECT_URL", "http://host.docker.internal:8000/api/orders/auto-place")
INTER_SERVICE_SECRET = os.getenv("INTER_SERVICE_SECRET", "b0275c3a4349646ef258afe24bb0209f")
HARDCODED_USER_ID = os.getenv("HARDCODED_USER_ID", "USR-V58CU4T5")

def db_worker():
    conn = sqlite3.connect(DB, check_same_thread=False, timeout=15.0)
    # 🛡️ THE FIX: Enable WAL mode for high-frequency concurrent, non-blocking inserts
    conn.execute("PRAGMA journal_mode=WAL;") 
    conn.execute("PRAGMA synchronous=NORMAL;")
    while True:
        try:
            query, params = db_queue.get()
            conn.execute(query, params); conn.commit()
            db_queue.task_done()
        except Exception as e:
            if "no column" not in str(e): print(f"⚠️ DB Error: {e}")

def webhook_worker():
    with _req.Session() as s:
        while True:
            try:
                ep, data = webhook_queue.get()
                # 🔥 THE FIX: Increased timeout from 0.5 to 2.5 to survive heavy math GIL spikes
                s.post(f"http://127.0.0.1:5678/{ep}", json=data, timeout=2.5)
                webhook_queue.task_done()
            except Exception as e: 
                # 🛡️ THE FIX: Ignore harmless read timeouts so it doesn't spam your logs
                if "Read timed out" not in str(e):
                    print(f"❌ [Webhook Error] Failed to push {ep}: {e}")

def smart_sleep_until_market_open():
    """Calculates exact seconds until 8:30 AM IST next trading day and puts the thread to sleep."""
    IST = pytz.timezone('Asia/Kolkata')
    
    while True:
        now = datetime.now(IST)
        
        # Define the active window (8:30 AM to 3:31 PM)
        target_time = now.replace(hour=8, minute=30, second=0, microsecond=0)
        market_close_time = now.replace(hour=15, minute=31, second=0, microsecond=0)

        # 1. If we are in active market hours on a weekday, NO SLEEP. Let the engine run!
        if now.weekday() < 5 and target_time <= now <= market_close_time:
            return

        # 2. If it's past 3:31 PM today, set the target to 8:30 AM tomorrow
        if now > market_close_time:
            target_time += timedelta(days=1)
        
        # 3. If the target day lands on Saturday (5) or Sunday (6), roll it forward to Monday
        while target_time.weekday() >= 5:
            target_time += timedelta(days=1)
            
        # 4. Calculate exact seconds until the target time
        sleep_seconds = (target_time - now).total_seconds()
        
        if sleep_seconds > 0:
            print(f"🌙 [HIBERNATION] Market Closed. Engine thread sleeping for {int(sleep_seconds)} seconds until {target_time.strftime('%A %d %b, %I:%M %p')}.")
            time.sleep(sleep_seconds)

def order_execution_worker():
    """Hits the main project API to place a trade, authenticating with a secret key."""
    with _req.Session() as s:
        while True:
            try:
                order_data = order_queue.get()
                signal_id = order_data.get("signal_id", f"SIG_{int(time.time())}")
                
                # --- 🔥 THE FIX: Strict 25-Second Time-Based Expiry & Queue Purge ---
                try:
                    # Extract the birth timestamp from the unique signal ID (e.g., SIG_1711200000_STRAT)
                    try:
                        signal_birth_time = order_data.get("created_ts")
                        if not signal_birth_time:
                            signal_birth_time = int(signal_id.split("_")[1])
                    except Exception:
                        print("⚠️ Invalid signal timestamp, skipping...")
                        order_queue.task_done()
                        continue
                    if time.time() - signal_birth_time > 25:
                        print(f"⏳ [ORDER BOT] Ignored STALE signal {signal_id}. Older than 25s.")
                        order_queue.task_done()
                        continue
                except (IndexError, ValueError):
                    pass # Fallback if signal_id is malformed
                
                # --- SAAS UPGRADE: Original logic preserved, but gated so it doesn't double-fire ---
                if os.getenv("SERVER_SIDE_EXECUTION", "False") == "True":
                    print(f"🚀 [ORDER BOT] Attempting to place order for {order_data['formatted_symbol']} -> Main Project...")
                    
                    payload = {
                        "user_id": str(HARDCODED_USER_ID), 
                        "secret_key": INTER_SERVICE_SECRET, 
                        "symbol": order_data["symbol"], 
                        "formatted_symbol": order_data["formatted_symbol"],
                        "direction": order_data["dir"],      
                        "entry_price": float(order_data["entry"]),
                        "sl": float(order_data["sl"]),
                        "target": float(order_data["target"]),
                        "lots": int(order_data["lots"]),
                        "strategy": order_data["strategy"],
                        "signal_id": signal_id
                    }
                    
                    res = s.post(MAIN_PROJECT_URL, json=payload, timeout=2.0)
                    
                    if res.status_code == 200:
                        print(f"✅ [ORDER BOT] SUCCESS! Main project accepted {order_data['dir']} trade for {order_data['formatted_symbol']}.")
                    else:
                        print(f"❌ [ORDER BOT] Main Project rejected order. Code: {res.status_code}, Reason: {res.text}")
                else:
                    # SaaS Mode: The React Frontend catches and executes this signal instead
                    print(f"📡 [SAAS BROADCAST] Signal {signal_id} queued. Awaiting Client-Side Browser execution.")
                    
                order_queue.task_done()
            except Exception as e:
                print(f"❌ [ORDER BOT] Connection failed to Main Project: {e}")

def _push(ep, data): webhook_queue.put((ep, data))

def init_db():
    conn = sqlite3.connect(DB)
    # WAL Mode must also be enabled on initialization
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("""CREATE TABLE IF NOT EXISTS ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, symbol TEXT, ltp REAL, bid REAL, ask REAL, last_qty INTEGER, side TEXT, spread_z REAL, spread_phase TEXT, tps REAL)""")
    # --- FIXED: Added signal_id to the schema to match the insertion logic ---
    conn.execute("""CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, signal_id TEXT, symbol TEXT, direction TEXT, grade TEXT, score INTEGER, entry REAL, sl REAL, target REAL, rr REAL, entry_type TEXT, wyckoff_phase TEXT, bias_1h TEXT, trend_15m TEXT, setup_5m TEXT, score_breakdown TEXT, sl_reason TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS bars_5m (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, symbol TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL, delta REAL, ofi REAL, aggr_ratio REAL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS bars_15m (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, symbol TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL, delta REAL, cvd_close REAL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS bars_1h (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, symbol TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL, delta REAL, cvd_close REAL, wyckoff_phase TEXT)""")
    # ── ADDED: OI Signals Table ──
    conn.execute("""CREATE TABLE IF NOT EXISTS oi_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, signal_type TEXT, direction TEXT, reason TEXT, pcr REAL, max_pain REAL, ce_buildup_strike REAL, pe_buildup_strike REAL, ce_oi_change REAL, pe_oi_change REAL, spot REAL)""")
    
    # 🛡️ THE HOT-FIX: If the database exists but lacks signal_id, add it now.
    try: conn.execute("ALTER TABLE signals ADD COLUMN signal_id TEXT")
    except: pass
    
    conn.commit(); conn.close()
init_db()

# ── Flask Server ──────────────────────────────────────────────────
from flask import Flask, jsonify, request, redirect, Response
from flask_cors import CORS
import logging
app = Flask(__name__); CORS(app)

# 🔥 THE FIX: Silence the Flask/Werkzeug HTTP request spam
werkzeug_log = logging.getLogger('werkzeug')
werkzeug_log.setLevel(logging.ERROR)

@app.route("/login")
def fyers_login():
    app_id = os.getenv("FYERS_CLIENT_ID", "")
    redirect_uri = f"{os.getenv('SERVER_URL', 'http://localhost:5678')}/callback"
    encoded_uri = urllib.parse.quote(redirect_uri, safe="")
    auth_url = f"https://api-t1.fyers.in/api/v3/generate-authcode?client_id={app_id}&redirect_uri={encoded_uri}&response_type=code&state=sample_state"
    return redirect(auth_url)

@app.route("/callback")
def fyers_callback():
    code = request.args.get("auth_code") or request.args.get("code")
    if not code: return jsonify({"status": "FAILED", "reason": "No auth code received."}), 400
    
    app_id = os.getenv("FYERS_CLIENT_ID", "").strip()
    secret_key = os.getenv("FYERS_SECRET_KEY", "").strip()
    app_id_hash = hashlib.sha256(f"{app_id}:{secret_key}".encode('utf-8')).hexdigest()
    
    url = "https://api-t1.fyers.in/api/v3/validate-authcode"
    headers = {"accept": "application/json", "Content-Type": "application/json"}
    data = {"grant_type": "authorization_code", "appIdHash": app_id_hash, "code": code.strip()}
    
    try:
        response = _req.post(url, headers=headers, json=data)
        response_data = response.json()
        if response.status_code == 200 and response_data.get("s") == "ok":
            redis_client.setex("fyers_access_token", 86400, response_data.get("access_token"))
            return "<div style='padding:40px;'><h1 style='color:green;'>✅ Fyers Login Successful!</h1></div>"
        else: return jsonify(response_data)
    except Exception as e: return jsonify({"error": str(e)})

@app.route("/token_status")
def token_status():
    token = redis_client.get("fyers_access_token")
    if not token: return jsonify({"status": "MISSING"}), 404
    try:
        fyers_test = fyersModel.FyersModel(client_id=os.getenv("FYERS_CLIENT_ID"), token=token, log_path="")
        profile = fyers_test.get_profile()
        if profile.get("s") == "ok": return jsonify({"status": "ACTIVE"}), 200
        else: return jsonify({"status": "EXPIRED"}), 401
    except Exception as e: return jsonify({"status": "ERROR"}), 500

# 🛡️ THE FIX: Bumped maxlen to 5000 so the UI doesn't clip your signals anymore!
_srv = dict(state={}, signals=collections.deque(maxlen=5000), bars_5m={}, bars_15m={}, bars_1h={}, mtf={}, zones={}, cvd_5m={}, cvd_15m={}, cvd_1h={}, chain=[])
_nifty_spot = 22480.0

for route, key in [("/state","state"),("/bars_5m","bars_5m"),("/bars_15m","bars_15m"), ("/bars_1h","bars_1h"),("/mtf","mtf"),("/zones","zones"), ("/cvd_5m","cvd_5m"),("/cvd_15m","cvd_15m"),("/cvd_1h","cvd_1h"), ("/chain","chain")]:
    app.add_url_rule(route, route[1:], lambda k=key: jsonify(_srv[k]))

@app.route("/signals")
def r_sigs():
    # Safely get the requested date or default to today in IST
    date_filter = request.args.get("date")
    today_str = datetime.now(IST).strftime("%d-%b-%Y")
    target_date = date_filter or today_str
    
    filtered_signals = []
    
    # Use a safe explicit loop instead of a list comprehension to avoid scope/NameError bugs
    for s in list(_srv["signals"]):
        # .get() ensures it doesn't crash if a signal somehow lacks a 'time' key
        sig_time = s.get("time", "") 
        if target_date in sig_time:
            filtered_signals.append(s)
            
    return jsonify(filtered_signals)

    
@app.route("/spot")
def r_spot(): return jsonify({"spot": _nifty_spot})

@app.route("/export_signals")
def export_signals():
    try:
        # 🛡️ THE FIX: 'with' ensures the connection is instantly closed after reading, preventing file descriptor leaks
        with sqlite3.connect(DB) as conn:
            query = "SELECT * FROM signals WHERE date(ts, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes') ORDER BY ts DESC"
            df = pd.read_sql_query(query, conn)
        
        if not df.empty and 'ts' in df.columns:
            df.insert(0, 'ist_time', pd.to_datetime(df['ts'], utc=True).dt.tz_convert('Asia/Kolkata').dt.strftime('%Y-%m-%d %I:%M:%S %p'))
            
        output = io.StringIO()
        df.to_csv(output, index=False)
        return Response(output.getvalue(), mimetype="text/csv", headers={"Content-disposition": "attachment; filename=MTF_Quant_Signals_Today.csv"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ==========================================================
# 🚀 THE MEGA PAYLOAD ENDPOINT (Zero-Lag UI Sync)
# ==========================================================
@app.route("/mega_payload")
def mega_payload():
    # Mirror the same daily filter logic from the original /signals route
    date_filter = request.args.get("date")
    today_str = datetime.now(IST).strftime("%d-%b-%Y")
    target_date = date_filter or today_str
    
    filtered_signals = []
    for s in _srv["signals"]:
        sig_time = s.get("time", "") 
        if target_date in sig_time:
            filtered_signals.append(s)

    # Bundle all 9 separate API responses into a single JSON dictionary
    return jsonify({
        "state": _srv["state"],
        "signals": filtered_signals,
        "zones": _srv["zones"],
        "spot": {"spot": _nifty_spot},
        "mtf": _srv["mtf"],
        "cvd_5m": _srv["cvd_5m"],
        "cvd_15m": _srv["cvd_15m"],
        "cvd_1h": _srv["cvd_1h"],
        "chain": _srv["chain"]
    })


@app.route("/push_state",   methods=["POST"]) 
def p_state():  _srv["state"][request.json["symbol"]] = request.json; return "ok"
@app.route("/push_signal", methods=["POST"]) 
def p_sig():    _srv["signals"].appendleft(request.json); return "ok"
@app.route("/push_5m", methods=["POST"]) 
def p_5m(): sym=request.json["symbol"]; _srv["bars_5m"].setdefault(sym,[]).append(request.json); _srv["bars_5m"][sym]=_srv["bars_5m"][sym][-100:]; return "ok"
@app.route("/push_15m", methods=["POST"]) 
def p_15m(): sym=request.json["symbol"]; _srv["bars_15m"].setdefault(sym,[]).append(request.json); _srv["bars_15m"][sym]=_srv["bars_15m"][sym][-50:]; return "ok"
@app.route("/push_1h", methods=["POST"]) 
def p_1h(): sym=request.json["symbol"]; _srv["bars_1h"].setdefault(sym,[]).append(request.json); _srv["bars_1h"][sym]=_srv["bars_1h"][sym][-20:]; return "ok"
@app.route("/push_mtf", methods=["POST"]) 
def p_mtf(): _srv["mtf"][request.json["symbol"]] = request.json; return "ok"
@app.route("/push_zones", methods=["POST"]) 
def p_zones(): _srv["zones"][request.json["symbol"]] = request.json.get("zones",[]); return "ok"
@app.route("/push_cvd_5m", methods=["POST"]) 
def p_cvd5(): sym=request.json["symbol"]; _srv["cvd_5m"].setdefault(sym,[]).extend(request.json.get("values",[])); _srv["cvd_5m"][sym]=_srv["cvd_5m"][sym][-200:]; return "ok"
@app.route("/push_cvd_15m",methods=["POST"]) 
def p_cvd15(): sym=request.json["symbol"]; _srv["cvd_15m"].setdefault(sym,[]).extend(request.json.get("values",[])); _srv["cvd_15m"][sym]=_srv["cvd_15m"][sym][-100:]; return "ok"
@app.route("/push_cvd_1h", methods=["POST"]) 
def p_cvd1h(): sym=request.json["symbol"]; _srv["cvd_1h"].setdefault(sym,[]).extend(request.json.get("values",[])); _srv["cvd_1h"][sym]=_srv["cvd_1h"][sym][-50:]; return "ok"

_cached_epoch = None; _epoch_date = None
def get_nearest_nifty_epoch():
    global _cached_epoch, _epoch_date
    today = datetime.now(IST).date()
    if _cached_epoch and _epoch_date == today: return _cached_epoch
    try:
        df = pd.read_csv("https://public.fyers.in/sym_details/NSE_FO.csv", header=None, usecols=[8, 9])
        opts = df[df[9].astype(str).str.contains(r'^NSE:NIFTY\d', regex=True) & df[9].astype(str).str.endswith(('CE', 'PE'))]
        _cached_epoch = int(opts[8].min()); _epoch_date = today
        return _cached_epoch
    except: return ""

def chain_worker():
    while True:
        smart_sleep_until_market_open()
        if fyers:
            try:
                res = fyers.optionchain({"symbol": "NSE:NIFTY50-INDEX", "strikecount": 10, "timestamp": get_nearest_nifty_epoch()})
                if res.get("s") == "ok": _srv["chain"] = res["data"]["optionsChain"]
            except Exception as e: print(f"⚠️ Chain Worker Error: {e}")
        time.sleep(180)



# ── Utilities ─────────────────────────────────────────────────────
def format_symbol(sym):
    """Parses raw symbol (NSE:NIFTY2640722850PE) into standard format (NIFTY 07 APR 22850 PE)."""
    clean_sym = sym.replace("NSE:", "")
    match = re.match(r"([A-Z]+)(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)", clean_sym)
    if match:
        base, yy, m, dd, strike, opt = match.groups()
        months = {'1':'Jan','2':'Feb','3':'Mar','4':'Apr','5':'May','6':'Jun','7':'Jul','8':'Aug','9':'Sep','O':'Oct','N':'Nov','D':'Dec'}
        return f"{base} {dd} {months.get(m, m)} {strike} {opt}"
    return clean_sym

# ── Classes & Memory ──────────────────────────────────────────────
class BarBuilder:
    def __init__(self, size_sec, name):
        self.size = size_sec; self.name = name; self.ts = None
        self.o = self.h = self.l = self.c = None
        self.h = -math.inf; self.l = math.inf
        self.vol = 0.0; self.delta = 0.0; self.cvd0 = 0.0
        self.aggr_buy = 0.0; self.aggr_sell = 0.0
        self.ofi_sum = 0.0; self.ofi_cnt = 0
        self.bars = []; self.cvd_running = 0.0
        self.just_closed = False; self.callbacks = []

    def update(self, ltp, tv, side, ts_float):
        self.just_closed = False
        if self.ts is None: self._open_bar(ltp, ts_float)
        elapsed = ts_float - self.ts
        self.h = max(self.h, ltp); self.l = min(self.l, ltp)
        self.vol += tv
        if side == "BUY": self.delta += tv; self.aggr_buy += tv
        else: self.delta -= tv; self.aggr_sell += tv
        self.ofi_sum += (tv if side == "BUY" else -tv); self.ofi_cnt += 1
        if elapsed >= self.size: self._close_bar(ltp, ts_float)

    def _open_bar(self, ltp, ts):
        self.ts = ts; self.o = self.h = self.l = ltp
        self.vol = self.delta = self.aggr_buy = self.aggr_sell = self.ofi_sum = self.ofi_cnt = 0.0
        self.cvd0 = self.cvd_running

    def _close_bar(self, ltp, ts):
        self.cvd_running += self.delta
        aggr_total = self.aggr_buy + self.aggr_sell + 1e-9
        bar = dict(ts=ts, ts_str=datetime.fromtimestamp(ts, IST).strftime("%H:%M"), o=self.o, h=self.h if math.isfinite(self.h) else ltp, l=self.l if math.isfinite(self.l) else ltp, c=ltp, vol=round(self.vol, 0), delta=round(self.delta, 0), cvd=round(self.cvd_running, 0), aggr_ratio=round((max(self.aggr_buy, self.aggr_sell)) / aggr_total, 3), ofi=round(self.ofi_sum / (self.vol + 1e-9), 3), range=max(self.h - self.l, 0.01), body=abs(ltp - self.o), bull=ltp >= self.o)
        self.bars.append(bar)
        if len(self.bars) > 200: self.bars.pop(0)
        self.just_closed = True
        for cb in self.callbacks:
            try: cb(bar)
            except Exception as e: pass
        self._open_bar(ltp, ts)

    def last1(self): return self.bars[-1] if self.bars else None

class SymState:
    def __init__(self):
        self.buy_vol_fast = collections.deque(maxlen=CFG["ofi_fast_window"])
        self.sell_vol_fast = collections.deque(maxlen=CFG["ofi_fast_window"])
        self.buy_vol_slow = collections.deque(maxlen=CFG["ofi_slow_window"])
        self.sell_vol_slow = collections.deque(maxlen=CFG["ofi_slow_window"])
        self.tape_speed_hist = collections.deque(maxlen=300) 
        self.ofi_history = collections.deque(maxlen=100)     
        self.ofi_fast = self.ofi_slow = 0.0
        self.ofi_shift = ""; self.part = "NEUTRAL"; self.last_side = "BUY"
        self.tick_timestamps = collections.deque(maxlen=200)
        self.tape_speed = 0.0; self.tape_phase = "NORMAL"
        self.cvd = 0.0; self.cvd_hist = collections.deque(maxlen=30)
        self.ltp_hist = collections.deque(maxlen=30); self.qty_hist = collections.deque(maxlen=20)
        self.large_lot_streak = 0; self.failed_bo_dir = ""; self.failed_bo_ts = 0
        self.spread_hist = collections.deque(maxlen=CFG["spread_window"])
        self.spread_z = 0.0; self.spread_phase = "NORMAL"
        self.spread_armed = False; self.spread_dir = ""; self.spread_widen_price = 0.0; self.spread_peak = 0.0
        self.bar_5s = BarBuilder(CFG["bar_5s_sec"], "5s"); self.bar_5m = BarBuilder(CFG["bar_5m_sec"], "5m")
        self.bar_15m = BarBuilder(CFG["bar_15m_sec"], "15m"); self.bar_1h = BarBuilder(CFG["bar_1h_sec"], "1H")
        self.b5s_ts = self.b5s_o = None; self.b5s_h = -math.inf; self.b5s_l = math.inf
        self.b5s_vol = self.b5s_cvd0 = self.b5s_aggr_vol = self.b5s_ratio = self.b5s_delta = self.b5s_elapsed = self.b5s_delta_peak = 0.0
        self.b5s_aggr_dir = ""; self.b5s_closed = self.preclose_fired = False; self.intra_flip_sig = ""
        self.wyckoff_phase = "INSUFFICIENT_DATA"; self.wyckoff_dir = "NEUTRAL"
        self.trend_15m = "NEUTRAL"; self.ofi_shift_15m = ""; self.cvd_momentum_15m = False; self.zone_respect_15m = ""
        self.setup_5m = ""; self.dir_5m = ""; self.delta_flip_5m = False; self.cvd_div_5m = ""; self.absorbed_5m = False; self.zones_15m = []
        
        self.oi_bias = "NEUTRAL"; self.oi_pcr = 1.0; self.oi_max_pain = 0.0; self.oi_signal = ""
        
        self.sweep_sig = ""; self.sweep_price = None; self.dir_lock = ""; self.dir_lock_ts = 0
        self.dir_lock_strat = "" # Tagged Strategy Lock
        self.alert_ts = {}; self.tick_count = 0; self.phase = "WATCHING"; self.last_grade = ""; self.last_score = 0
        self.last_push_ts = 0.0
        self.cvd_reset_done = False # Added for Stitching Bug Fix

_state = {}
def _st(sym):
    if sym not in _state: _state[sym] = SymState()
    return _state[sym]

def _cd_ok(st, key, secs=None):
    now = time.time()
    if now - st.alert_ts.get(key, 0) >= (secs or CFG["cooldown_sec"]):
        st.alert_ts[key] = now; return True
    return False

# ── Dynamic Mathematical Analyzers ────────────────────────────────
def get_atr(bars, period=14):
    if len(bars) < 2: return 1.0
    trs = [max(bars[i]["h"]-bars[i]["l"], abs(bars[i]["h"]-bars[i-1]["c"]), abs(bars[i]["l"]-bars[i-1]["c"])) for i in range(1, len(bars))]
    return np.mean(trs[-min(period, len(trs)):]) if trs else 1.0

def detect_wyckoff(bars_1h):
    if len(bars_1h) < 5: return "INSUFFICIENT_DATA", "NEUTRAL"
    recent = bars_1h[-10:]; last = bars_1h[-1]
    prices = [b["c"] for b in recent]; volumes = [b["vol"] for b in recent]; cvds = [b["cvd"] for b in recent]
    avg_range = np.mean([b["range"] for b in bars_1h[-20:]] or [1]) + 1e-9; avg_vol = np.mean(volumes) + 1e-9
    if len(bars_1h) >= CFG["m1h_accum_bars"] + 3:
        seg = bars_1h[-CFG["m1h_accum_bars"]:]
        if (np.mean([b["range"] for b in seg]) < avg_range * CFG["m1h_accum_range_pct"] and (sum(b["vol"] for b in seg) / CFG["m1h_accum_bars"]) > avg_vol * CFG["m1h_accum_vol_mult"] and (max([b["c"] for b in seg]) - min([b["c"] for b in seg])) < avg_range * 2.0 and (len([b["cvd"] for b in seg]) >= 2 and seg[-1]["cvd"] > seg[0]["cvd"])): return "ACCUMULATION", "BULL"
    if len(bars_1h) >= 3:
        b_prev, b_spike, b_snap = bars_1h[-3], bars_1h[-2], bars_1h[-1]
        support = min(b["l"] for b in bars_1h[-10:-2]) if len(bars_1h) >= 10 else b_prev["l"]
        resist = max(b["h"] for b in bars_1h[-10:-2]) if len(bars_1h) >= 10 else b_prev["h"]
        atr_1h = get_atr(bars_1h, 14) 
        if (b_spike["l"] < support and b_snap["c"] > support and b_snap["delta"] > 0 and b_spike["vol"] > avg_vol):
            if (b_snap["c"] - b_spike["l"]) >= 0.5 * atr_1h: return "MANIPULATION", "BULL"
        if (b_spike["h"] > resist and b_snap["c"] < resist and b_snap["delta"] < 0 and b_spike["vol"] > avg_vol):
            if (b_spike["h"] - b_snap["c"]) >= 0.5 * atr_1h: return "MANIPULATION", "BEAR"
    if len(bars_1h) >= 3:
        last3_d = [b["delta"] for b in bars_1h[-3:]]
        if all(d > CFG["m1h_expand_delta_min"] for d in last3_d) and np.mean([b["vol"] for b in bars_1h[-3:]]) > avg_vol * 1.2: return "EXPANSION", "BULL"
        if all(d < -CFG["m1h_expand_delta_min"] for d in last3_d) and np.mean([b["vol"] for b in bars_1h[-3:]]) > avg_vol * 1.2: return "EXPANSION", "BEAR"
    if len(bars_1h) >= 8:
        if last["c"] >= max(prices) * 0.995 and cvds[-1] < (max(cvds[:-2]) + 1e-9) * CFG["m1h_dist_cvd_div_pct"] and volumes[-1] > np.mean(volumes[:-1]) * 1.2: return "DISTRIBUTION", "BEAR"
        if last["c"] <= min(prices) * 1.005 and cvds[-1] > (min(cvds[:-2]) - 1e-9) * CFG["m1h_dist_cvd_div_pct"] and volumes[-1] > np.mean(volumes[:-1]) * 1.2: return "DISTRIBUTION", "BULL"
    if len(bars_1h) >= 5:
        bull_bars = sum(1 for b in bars_1h[-5:] if b["bull"]); cvd_trend = cvds[-1] - cvds[0] if len(cvds) >= 2 else 0
        if bull_bars >= 4 and cvd_trend > 0: return "RANGING", "BULL"
        if bull_bars <= 1 and cvd_trend < 0: return "RANGING", "BEAR"
    return "RANGING", "NEUTRAL"

def analyze_15m(bars_15m):
    if len(bars_15m) < CFG["m15_trend_ma"]: return "NEUTRAL", "", False, ""
    closes = [b["c"] for b in bars_15m]; cvds = [b["cvd"] for b in bars_15m]; ofis = [b["ofi"] for b in bars_15m]
    ma_now = np.mean(closes[-CFG["m15_trend_ma"]:]); ma_old = np.mean(closes[-CFG["m15_trend_ma"]*2:-CFG["m15_trend_ma"]]) if len(closes) >= CFG["m15_trend_ma"]*2 else ma_now
    trend = "BULL" if closes[-1] > ma_now and ma_now > ma_old else "BEAR" if closes[-1] < ma_now and ma_now < ma_old else "NEUTRAL"
    ofi_shift = ""
    if len(ofis) >= CFG["m15_ofi_shift_window"]:
        ofi_old = np.mean(ofis[-CFG["m15_ofi_shift_window"]*2:-CFG["m15_ofi_shift_window"]]) if len(ofis) >= CFG["m15_ofi_shift_window"]*2 else 0
        if ofi_old < 0.1 and np.mean(ofis[-CFG["m15_ofi_shift_window"]:]) > 0.3: ofi_shift = "BULL_SHIFT"
        elif ofi_old > -0.1 and np.mean(ofis[-CFG["m15_ofi_shift_window"]:]) < -0.3: ofi_shift = "BEAR_SHIFT"
    cvd_momentum = False
    if len(cvds) >= CFG["m15_cvd_momentum_bars"] + 1:
        cvd_change = cvds[-1] - cvds[-CFG["m15_cvd_momentum_bars"]-1]
        if (trend == "BULL" and cvd_change > 0) or (trend == "BEAR" and cvd_change < 0): cvd_momentum = True
    zone_respect = ""
    if len(bars_15m) >= 5:
        lo5 = min(b["l"] for b in bars_15m[-5:-1]); hi5 = max(b["h"] for b in bars_15m[-5:-1])
        if abs(bars_15m[-1]["l"] - lo5) < 0.3 and bars_15m[-1]["bull"]: zone_respect = "HOLDING"
        elif abs(bars_15m[-1]["h"] - hi5) < 0.3 and not bars_15m[-1]["bull"]: zone_respect = "HOLDING"
        elif bars_15m[-1]["c"] > hi5: zone_respect = "BREAKING"
        elif bars_15m[-1]["c"] < lo5: zone_respect = "BREAKING"
    return trend, ofi_shift, cvd_momentum, zone_respect

def analyze_5m(bars_5m):
    if len(bars_5m) < 5: return "", "", False, "", False
    setup = ""; direction = ""; delta_flip = False; cvd_div = ""; absorption = False
    if abs(bars_5m[-1]["delta"]) >= CFG["cvd_flip_min"] and abs(bars_5m[-2]["delta"]) >= CFG["cvd_flip_min"]:
        if bars_5m[-2]["delta"] < 0 and bars_5m[-1]["delta"] > 0: delta_flip = True; direction = "LONG"
        elif bars_5m[-2]["delta"] > 0 and bars_5m[-1]["delta"] < 0: delta_flip = True; direction = "SHORT"
    if len(bars_5m) >= CFG["absorb_bars"] + 3:
        seg = bars_5m[-CFG["absorb_bars"]:]; base = bars_5m[-CFG["absorb_bars"]-3:-CFG["absorb_bars"]]
        if (sum(b["vol"] for b in seg) > (np.mean([b["vol"] for b in base]) + 1e-9) * CFG["absorb_bars"] * CFG["absorb_vol_mult"] and np.mean([b["range"] for b in seg]) < (np.mean([b["range"] for b in base]) + 1e-9) * CFG["absorb_range_pct"]):
            absorption = True; setup = "ABSORPTION"; direction = "LONG" if bars_5m[-1]["delta"] > 0 else "SHORT"
    if len(bars_5m) >= CFG["m5_div_lookback"]:
        seg_p = [b["c"] for b in bars_5m[-CFG["m5_div_lookback"]:]]; seg_d = [b["delta"] for b in bars_5m[-CFG["m5_div_lookback"]:]]
        if seg_p[-1] >= max(seg_p) * 0.998 and seg_d[-1] < max(seg_d) * 0.5: cvd_div = "BEAR_DIV"; setup = setup or "CVD_DIV"; direction = "SHORT"
        elif seg_p[-1] <= min(seg_p) * 1.002 and seg_d[-1] > min(seg_d) * 0.5: cvd_div = "BULL_DIV"; setup = setup or "CVD_DIV"; direction = "LONG"
    if len(bars_5m) >= CFG["m5_compression_bars"] + 5:
        if all(b["range"] < (np.mean([b["range"] for b in bars_5m[-CFG["m5_compression_bars"]-5:-CFG["m5_compression_bars"]]]) + 1e-9) * 0.35 for b in bars_5m[-CFG["m5_compression_bars"]:]) and delta_flip: setup = "COMP+FLIP"
    return setup, direction, delta_flip, cvd_div, absorption

def build_liquidity_zones(bars_15m, ltp):
    if len(bars_15m) < 5: return []
    zones = []; vol_by_level = {}
    for bar in bars_15m[-50:]:
        n_bins = max(int((bar["h"] - bar["l"]) / 0.5) + 1, 1)
        cur = bar["l"]
        while cur <= bar["h"] + 0.01:
            key = round(round(cur / 0.5) * 0.5, 2)
            vol_by_level[key] = vol_by_level.get(key, 0) + (bar["vol"] / n_bins); cur += 0.5
    if not vol_by_level: return []
    threshold = np.percentile(list(vol_by_level.values()), CFG["m15_zone_strength_pct"] * 100)
    for level, vol in sorted(vol_by_level.items()):
        if vol >= threshold:
            ts = sum(1 for b in bars_15m if abs(b["l"] - level) < 0.5); tr = sum(1 for b in bars_15m if abs(b["h"] - level) < 0.5)
            zones.append(dict(price=level, low=round(level - 0.25, 2), high=round(level + 0.25, 2), vol=round(vol / 1000, 1), type="support" if ts >= tr else "resistance", swept=ltp > level + 0.6 or ltp < level - 0.6, tests=max(ts, tr)))
    return sorted(zones, key=lambda z: z["price"], reverse=True)

# ── Dynamic Tick Logic ────────────────────────────────────────────
def _compute_tick(st, ltp, tv, side, last_qty, bid_qty, ask_qty, ts_real):
    # Stitching fix: Reset CVD exactly at market open to sever ties with synthetic history
    now_ist = datetime.now(IST)
    if now_ist.hour == 9 and now_ist.minute >= 15 and not getattr(st, 'cvd_reset_done', False):
        st.cvd = 0.0
        st.cvd_reset_done = True
        
    bv = tv if side=="BUY" else 0; sv = tv if side=="SELL" else 0
    st.buy_vol_fast.append(bv);  st.sell_vol_fast.append(sv)
    st.buy_vol_slow.append(bv);  st.sell_vol_slow.append(sv)
    st.ofi_fast=(sum(st.buy_vol_fast)-sum(st.sell_vol_fast))/(sum(st.buy_vol_fast)+sum(st.sell_vol_fast)+1e-9)
    st.ofi_slow=(sum(st.buy_vol_slow)-sum(st.sell_vol_slow))/(sum(st.buy_vol_slow)+sum(st.sell_vol_slow)+1e-9)
    
    st.ofi_history.append(abs(st.ofi_fast))
    if len(st.ofi_history) > 20:
        raw_thresh = np.percentile(st.ofi_history, 85)
        dyn_ofi_thresh = max(0.30, min(0.85, raw_thresh))
    else:
        dyn_ofi_thresh = CFG["ofi_aggr_thresh"]
    
    st.ofi_shift=""
    if st.ofi_slow<CFG["ofi_passive_thresh"] and st.ofi_fast>=dyn_ofi_thresh: st.ofi_shift="BULL_SHIFT"
    elif st.ofi_slow>-CFG["ofi_passive_thresh"] and st.ofi_fast<=-dyn_ofi_thresh: st.ofi_shift="BEAR_SHIFT"
    
    if st.ofi_fast>=dyn_ofi_thresh and side=="BUY": st.part="AGGR BUY"
    elif st.ofi_fast<=-dyn_ofi_thresh and side=="SELL": st.part="AGGR SELL"
    else: st.part="NEUTRAL"
    
    # Calculate Volume Velocity (Lots per second) instead of packet count
    st.tick_timestamps.append((ts_real, tv))
    recent_vol = sum(v for t, v in st.tick_timestamps if ts_real-t<=CFG["tape_window_sec"])
    st.tape_speed = recent_vol / CFG["tape_window_sec"]
    
    st.tape_speed_hist.append(st.tape_speed)
    if len(st.tape_speed_hist) > 30:
        mean_ts = np.mean(st.tape_speed_hist)
        std_ts = np.std(st.tape_speed_hist) + 1e-9
        base_mean = max(mean_ts, CFG["tape_normal_tps"]) 
        
        if st.tape_speed >= base_mean + 2.0 * std_ts and st.tape_speed >= CFG["tape_normal_tps"] * CFG["tape_urgent_mult"]: 
            st.tape_phase = "URGENT"
        elif st.tape_speed >= base_mean + 1.0 * std_ts and st.tape_speed >= CFG["tape_normal_tps"] * CFG["tape_fast_mult"]: 
            st.tape_phase = "FAST"
        else: 
            st.tape_phase = "NORMAL"
    else:
        if st.tape_speed>=CFG["tape_normal_tps"]*CFG["tape_urgent_mult"]: st.tape_phase="URGENT"
        elif st.tape_speed>=CFG["tape_normal_tps"]*CFG["tape_fast_mult"]: st.tape_phase="FAST"
        else: st.tape_phase="NORMAL"

    st.cvd+=tv*(1 if side=="BUY" else -1)
    st.ltp_hist.append(ltp); st.cvd_hist.append(st.cvd); st.qty_hist.append(last_qty)
    avg_q=sum(st.qty_hist)/max(len(st.qty_hist),1)
    if last_qty>=avg_q*5.0 and len(st.qty_hist)>=5:
        st.large_lot_streak = max(st.large_lot_streak+1,1) if side=="BUY" else min(st.large_lot_streak-1,-1)
    else:
        st.large_lot_streak = max(0,st.large_lot_streak-1) if st.large_lot_streak>0 else min(0,st.large_lot_streak+1)

def _analyze_spread(st, ltp, bid, ask, bid_qty, ask_qty):
    sp=ask-bid; st.spread_hist.append(sp)
    if len(st.spread_hist)<10 or sp < 1.0: return # Minimum 1.0 point spread required to process Z-score
    st.spread_z=(sp-np.mean(st.spread_hist))/(np.std(st.spread_hist)+1e-9)
    tq=bid_qty+ask_qty+1e-9; bid_dom=bid_qty/tq; ask_dom=ask_qty/tq
    prev=st.spread_phase; z=st.spread_z
    if z<=CFG["spread_tight_z"]:st.spread_phase="TIGHT"
    elif z>=CFG["spread_alert_z"] and prev in("TIGHT","WIDENING"):
        st.spread_phase="WIDE_ALERT"; st.spread_peak=max(st.spread_peak,sp)
        st.spread_dir="LONG" if bid_dom>0.60 else "SHORT" if ask_dom>0.60 else("LONG" if st.cvd>0 else "SHORT")
        st.spread_widen_price=ltp; st.spread_armed=True
    elif z>=CFG["spread_wide_z"] and prev in("TIGHT","TIGHTENING"): st.spread_phase="WIDENING"; st.spread_peak=sp
    elif z<=0: st.spread_phase="TIGHTENING" if prev=="NORMAL" else prev if prev not in("WIDE_ALERT","POST_MOVE") else st.spread_phase
    else:
        if prev=="WIDE_ALERT": st.spread_phase="POST_MOVE"
        elif prev not in("POST_MOVE",) and z<0.3: st.spread_phase="NORMAL"

def _update_5s_bar(st, ltp, tv, side, ts):
    st.b5s_closed=False; st.intra_flip_sig=""
    if st.b5s_ts is None: st.b5s_ts=ts; st.b5s_o=ltp; st.b5s_cvd0=st.cvd; st.b5s_delta_peak=0.0; st.preclose_fired=False
    elapsed=ts-st.b5s_ts
    st.b5s_h=max(st.b5s_h if math.isfinite(st.b5s_h) else ltp,ltp); st.b5s_l=min(st.b5s_l if math.isfinite(st.b5s_l) else ltp,ltp)
    st.b5s_vol+=tv
    if side in("BUY","SELL"):st.b5s_aggr_vol+=tv;st.b5s_aggr_dir=side
    st.b5s_delta=st.cvd-st.b5s_cvd0
    if abs(st.b5s_delta)>abs(st.b5s_delta_peak):st.b5s_delta_peak=st.b5s_delta
    pd_ = st.bar_5m.delta
    
    # Required 15m trend alignment or 5m setup presence to validate the intra-flip
    is_bull_flip = pd_ < -CFG["bar_intra_flip_min"] and st.b5s_delta > CFG["bar_intra_flip_min"]
    is_bear_flip = pd_ > CFG["bar_intra_flip_min"] and st.b5s_delta < -CFG["bar_intra_flip_min"]
    if is_bull_flip and (st.trend_15m == "BULL" or st.setup_5m): st.intra_flip_sig="INTRA_▲FLIP"
    elif is_bear_flip and (st.trend_15m == "BEAR" or st.setup_5m): st.intra_flip_sig="INTRA_▼FLIP"
    
    st.b5s_ratio=st.b5s_aggr_vol/st.b5s_vol if st.b5s_vol>0 else 0.0
    st.b5s_elapsed=elapsed
    if elapsed>=CFG["bar_5s_sec"]:
        st.b5s_ts=ts; st.b5s_o=ltp; st.b5s_h=ltp; st.b5s_l=ltp; st.b5s_vol=tv; st.b5s_cvd0=st.cvd; st.b5s_aggr_vol=tv if side in("BUY","SELL") else 0; st.b5s_aggr_dir=side; st.b5s_ratio=0.0; st.b5s_delta=0.0; st.b5s_delta_peak=0.0; st.preclose_fired=False; st.b5s_closed=True
        if st.zones_15m and len(st.bar_5m.bars) >= 2:
            pb, cb = st.bar_5m.bars[-2], st.bar_5m.bars[-1]; st.sweep_sig=""; st.sweep_price=None
            for z in st.zones_15m:
                if z.get("swept"): continue
                if pb["l"]<z["low"] and cb["c"]>z["low"] and cb["delta"]>0 and (cb["c"]-pb["l"])/max(pb["h"]-pb["l"],0.01)>=CFG["sweep_snap_pct"]: st.sweep_sig="BULL_SWEEP"; st.sweep_price=z["low"]; break
                elif pb["h"]>z["high"] and cb["c"]<z["high"] and cb["delta"]<0 and (pb["h"]-cb["c"])/max(pb["h"]-pb["l"],0.01)>=CFG["sweep_snap_pct"]: st.sweep_sig="BEAR_SWEEP"; st.sweep_price=z["high"]; break

# ── Signals & Risk ─────────────────────────────
def _mtf_score(st, direction):
    isL = direction == "LONG"; W = CFG; sc = 0; bd = {}
    if (isL and st.ofi_shift=="BULL_SHIFT") or (not isL and st.ofi_shift=="BEAR_SHIFT"): sc+=W["score_ofi_shift"]; bd["ofi_shift"]=W["score_ofi_shift"]
    if st.tape_phase=="URGENT": sc+=W["score_tape_urgent"]; bd["tape"]=W["score_tape_urgent"]
    elif st.tape_phase=="FAST": sc+=W["score_tape_fast"]; bd["tape"]=W["score_tape_fast"]
    if st.b5s_ratio>=W["bar_aggr_ratio_thresh"] and st.b5s_vol>=W["bar_min_vol_preclose"] and ((isL and st.b5s_aggr_dir=="BUY") or (not isL and st.b5s_aggr_dir=="SELL")): sc+=W["score_aggr_ratio"]; bd["aggr_ratio"]=W["score_aggr_ratio"]
    if st.spread_phase=="WIDE_ALERT" and st.spread_dir==direction: sc+=W["score_spread_alert"]; bd["spread_alert"]=W["score_spread_alert"]
    if (isL and st.sweep_sig=="BULL_SWEEP") or (not isL and st.sweep_sig=="BEAR_SWEEP"): sc+=W["score_sweep"]; bd["sweep"]=W["score_sweep"]
    if (isL and st.intra_flip_sig=="INTRA_▲FLIP") or (not isL and st.intra_flip_sig=="INTRA_▼FLIP"): sc+=W["score_intra_flip"]; bd["intra_flip"]=W["score_intra_flip"]
    if (isL and st.large_lot_streak>=2) or (not isL and st.large_lot_streak<=-2): sc+=W["score_large_lot"]; bd["large_lot"]=W["score_large_lot"]
    fa=time.time()-st.failed_bo_ts
    if st.failed_bo_dir==direction and fa<30: sc+=15; bd["fbo_bonus"]=15
    if ((isL and st.failed_bo_dir=="SHORT")or(not isL and st.failed_bo_dir=="LONG")) and fa<30: sc+=W["score_fbo_penalty"]; bd["fbo_pen"]=W["score_fbo_penalty"]
    if (isL and st.ofi_fast>0) or (not isL and st.ofi_fast<0): sc+=5; bd["ofi_align"]=5
    if (isL and st.cvd>0) or (not isL and st.cvd<0): sc+=5; bd["cvd_align"]=5
    if ((isL and st.wyckoff_dir in ("BULL",)) or (not isL and st.wyckoff_dir in ("BEAR",))): sc+=W["score_1h_bias_agree"]; bd[f"1H_{st.wyckoff_phase}"]=W["score_1h_bias_agree"]
    if isL and st.wyckoff_phase=="MANIPULATION" and st.wyckoff_dir=="BULL": sc+=10; bd["manip_spring"]=10
    if not isL and st.wyckoff_phase=="MANIPULATION" and st.wyckoff_dir=="BEAR": sc+=10; bd["manip_upthrust"]=10
    if (isL and st.wyckoff_phase=="DISTRIBUTION" and st.wyckoff_dir=="BEAR") or (not isL and st.wyckoff_phase=="DISTRIBUTION" and st.wyckoff_dir=="BULL"): sc-=20; bd["dist_penalty"]=-20
    if (isL and st.trend_15m=="BULL") or (not isL and st.trend_15m=="BEAR"): sc+=W["score_15m_trend_agree"]; bd["15m_trend"]=W["score_15m_trend_agree"]
    if st.cvd_momentum_15m: sc+=5; bd["15m_cvd_momentum"]=5
    if (isL and st.ofi_shift_15m=="BULL_SHIFT") or (not isL and st.ofi_shift_15m=="BEAR_SHIFT"): sc+=W["score_15m_ofi_shift"]; bd["15m_ofi_shift"]=W["score_15m_ofi_shift"]
    if st.setup_5m and ((isL and st.dir_5m=="LONG") or (not isL and st.dir_5m=="SHORT")): sc+=W["score_5m_setup_armed"]; bd[f"5m_{st.setup_5m}"]=W["score_5m_setup_armed"]
    if (isL and st.cvd_div_5m=="BULL_DIV") or (not isL and st.cvd_div_5m=="BEAR_DIV"): sc+=W["score_5m_cvd_div"]; bd["5m_cvd_div"]=W["score_5m_cvd_div"]
    return max(0, min(100, sc)), bd

def _resolve_direction(st):
    """Returns (Direction, Tagged Strategy Name) - STRICTLY TRIGGER BASED"""
    if st.dir_lock and (time.time()-st.dir_lock_ts)<10: return st.dir_lock, st.dir_lock_strat
    
    d, strat = "", ""
    # ONLY micro-events pull the trigger. Macro biases are strictly for gating.
    if st.sweep_sig=="BULL_SWEEP": d, strat = "LONG", "Liquidity Sweep"
    elif st.sweep_sig=="BEAR_SWEEP": d, strat = "SHORT", "Liquidity Sweep"
    elif st.intra_flip_sig=="INTRA_▲FLIP": d, strat = "LONG", "Intra-Bar Flip"
    elif st.intra_flip_sig=="INTRA_▼FLIP": d, strat = "SHORT", "Intra-Bar Flip"
    elif st.spread_phase=="WIDE_ALERT" and st.spread_dir: d, strat = st.spread_dir, "Spread Alert"
    elif st.setup_5m and st.dir_5m: d, strat = st.dir_5m, st.setup_5m
    elif st.ofi_fast>=CFG["ofi_aggr_thresh"] and st.tape_phase in ("FAST", "URGENT"): d, strat = "LONG", "Tape Aggression"
    elif st.ofi_fast<=-CFG["ofi_aggr_thresh"] and st.tape_phase in ("FAST", "URGENT"): d, strat = "SHORT", "Tape Aggression"
    else: return "", ""
    
    st.dir_lock=d; st.dir_lock_strat=strat; st.dir_lock_ts=time.time(); return d, strat

def _compute_sl(st, ltp, direction, grade, strat=""):
    """Volatility & Spread-Aware Risk System (Unified Clamps, Proportional Blending)"""
    isL = direction == "LONG"
    buf = CFG["sl_buffer_ticks"] * TICK
    
    strat_upper = strat.upper()
    if strat in ("Liquidity Sweep", "ABSORPTION") or "WYCKOFF" in strat_upper or "SPRING" in strat_upper:
        strat_mult = 1.5  
    elif strat in ("Intra-Bar Flip", "COMP+FLIP", "Tape Aggression") or "OFI" in strat_upper:
        strat_mult = 0.8  
    elif strat in ("CVD_DIV", "Spread Alert"):
        strat_mult = 1.0  
    else:
        strat_mult = 1.0  
        
    # 1. Dynamic Fallbacks & Core Metrics (Lookback increased to 7 for stability)
    median_spread = np.median(st.spread_hist) if len(st.spread_hist) > 0 else 1.0
    adaptive_fallback = max(median_spread * 3.0, 2.0)
    atr_5m = get_atr(st.bar_5m.bars, 7) if st.bar_5m.bars and len(st.bar_5m.bars) >= 2 else adaptive_fallback
    
    # 2. Proportional Blended Risk Boundaries (Spread dynamically dampened)
    # Spread influence scales down if ATR drops, preventing spread from dominating calm markets
    spread_dampener = min(1.5, atr_5m / adaptive_fallback)
    
    min_sl_dist = max(CFG["sl_min_pts"], (atr_5m * 0.15) + (median_spread * spread_dampener))
    max_sl_dist = (atr_5m * 1.5) + (median_spread * 2.0)
    
    # Use 7 bars for structural context to match ATR smoothing
    recent_bars = st.bar_5m.bars[-7:] if st.bar_5m.bars else []

    # 3. Calculate Raw Unclamped Distance
    if grade == "A+":
        atr_buffer = (atr_5m * 0.25) * strat_mult
        if isL:
            struct_sl = min(b["l"] for b in recent_bars) - buf - atr_buffer if recent_bars else ltp - max_sl_dist
            raw_dist = ltp - struct_sl
        else:
            struct_sl = max(b["h"] for b in recent_bars) + buf + atr_buffer if recent_bars else ltp + max_sl_dist
            raw_dist = struct_sl - ltp
    elif grade == "A":
        raw_dist = atr_5m * strat_mult
    else: # Grade B
        raw_dist = (atr_5m * 0.6) * strat_mult
        
    # 4. Apply Universal Safety Clamps to ALL Grades
    final_dist = max(min_sl_dist, min(raw_dist, max_sl_dist))
    
    sl = ltp - final_dist if isL else ltp + final_dist
    
    return max(0.05, round(sl, 2)), f"Grade_{grade}_Risk"

def _compute_target(st, ltp, direction, sl, grade, strat=""):
    """Regime-Aware Target System (Softened Regime Mult, ATR-Normalized Zone Scoring)"""
    isL = direction == "LONG"
    
    strat_upper = strat.upper()
    if strat in ("Liquidity Sweep", "ABSORPTION") or "WYCKOFF" in strat_upper or "SPRING" in strat_upper:
        strat_tgt_mult = 1.2  
    elif strat in ("Intra-Bar Flip", "COMP+FLIP", "Tape Aggression") or "OFI" in strat_upper:
        strat_tgt_mult = 0.9  
    elif strat in ("CVD_DIV", "Spread Alert"):
        strat_tgt_mult = 1.0  
    else:
        strat_tgt_mult = 1.0

    # 🔥 FIX: Strategy-Specific Dampening for Exhaustion setups
    if strat == "CVD_DIV":
        strat_tgt_mult = 0.6  # Mean-reversion must take quick profits

    # 1. Dynamic Fallbacks & Core Metrics (Lookback increased to 7 for stability)
    median_spread = np.median(st.spread_hist) if len(st.spread_hist) > 0 else 1.0
    adaptive_fallback = max(median_spread * 3.0, 2.0)
    atr_5m = get_atr(st.bar_5m.bars, 7) if st.bar_5m.bars and len(st.bar_5m.bars) >= 2 else adaptive_fallback
    
    # 2. Regime Awareness Multiplier
    base_regime = 0.8 if getattr(st, 'trend_15m', 'NEUTRAL') == "NEUTRAL" else 1.0
    regime_mult = base_regime * strat_tgt_mult
    
    tgt = ltp
    if grade == "A+":
        # Dynamic Zone Noise Filter
        noise_filter = (atr_5m * 0.15) + (median_spread * 1.2)
        
        above = [z for z in st.zones_15m if z["low"] > ltp + noise_filter and not z.get("swept")]
        below = [z for z in st.zones_15m if z["high"] < ltp - noise_filter and not z.get("swept")]
        
        # Distance-Penalized Scoring (Normalized against ATR for volatility-aware scaling)
        score_logic = lambda z: z["vol"] / (((abs(z["price"] - ltp) / atr_5m) ** 2) + 1e-6)
        
        tz = max(above, key=score_logic) if isL and above else None
        if not isL and below:
            tz = max(below, key=score_logic)
            
        # Apply regime multiplier to caps and fallbacks
        # Added spread-based blend to target ceiling to prevent pure ATR hyper-expansion
        max_tgt_dist = ((atr_5m * 2.0) + (median_spread * 4.0)) * regime_mult
        fallback_dist = ((atr_5m * 1.5) + (median_spread * 2.0)) * regime_mult
        
        if tz:
            zone_price = tz["low"] if isL else tz["high"]
            if abs(zone_price - ltp) > max_tgt_dist:
                tgt = ltp + max_tgt_dist if isL else ltp - max_tgt_dist
            else:
                tgt = zone_price
        else:
            tgt = ltp + fallback_dist if isL else ltp - fallback_dist

    elif grade == "A":
        tgt = ltp + (atr_5m * 1.5 * regime_mult) if isL else ltp - (atr_5m * 1.5 * regime_mult)
    else: # Grade B
        sld = max(abs(ltp - sl), CFG["sl_min_pts"])
        tgt = ltp + (sld * 1.2 * regime_mult) if isL else ltp - (sld * 1.2 * regime_mult)
        
    # 🔥 FIX: Sanity Clamps to prevent unrealistic option growth expectations
    raw_dist = abs(tgt - ltp)
    sld = max(abs(ltp - sl), CFG["sl_min_pts"])
    
    # 1. R:R Clamp (Max 1:2.5 for CVD_DIV, 1:4.0 for trend/sweeps)
    max_rr = 2.5 if strat == "CVD_DIV" else 4.0
    clamped_dist = min(raw_dist, sld * max_rr)
    
    # 2. Percentage Premium Clamp (Cap at +30% intraday move)
    clamped_dist = min(clamped_dist, ltp * 0.30)
    
    tgt = ltp + clamped_dist if isL else ltp - clamped_dist

    return max(0.05, round(tgt, 2))

# Place this right above the _emit_signal function
_global_strat_locks = {}

def _emit_signal(sym, ltp, st, entry_type="bar_close"):
    if datetime.now(IST).time()<CFG["no_trade_before"] or datetime.now(IST).time()>CFG["no_trade_after"]: return
    if st.tape_speed<CFG["tape_min_for_signal"]: return
    
    d, strat = _resolve_direction(st)
    if not d: return
    
    # 🔥 THE FIX: Global Correlation Lock (Universal Master Time Lock)
    global_lock_key = "GLOBAL_LOCK"
    if time.time() - _global_strat_locks.get(global_lock_key, 0) < 120:
        return # Block: ANY setup already fired on ANY strike within the last 2 minutes!
    
    isL = (d == "LONG")
    # HARD GATING: Must have MTF Bias OR a confirmed 5m Setup
    bias_aligned = (isL and (st.wyckoff_dir == "BULL" or st.trend_15m == "BULL")) or \
                   (not isL and (st.wyckoff_dir == "BEAR" or st.trend_15m == "BEAR"))
                   
    # --- 🔥 BLIND TAPE FIX: extreme tape override ---
    is_extreme_tape = (st.tape_phase in ("FAST", "URGENT") and abs(st.ofi_fast) >= CFG["ofi_aggr_thresh"])
    
    if not (st.setup_5m or bias_aligned or is_extreme_tape): 
        return # Block signal: Lacks MTF confirmation
    
    sc,bd=_mtf_score(st,d)
    if sc>=CFG["grade_ap_thresh"]: grade="A+"
    elif sc>=CFG["grade_a_thresh"]: grade="A"
    elif sc>=CFG["grade_b_thresh"]: grade="B"
    else: return
    if CFG.get("skip_grade_b") and grade=="B": return
    
    # Throttle exactly this setup/direction/symbol
    if not _cd_ok(st,f"{sym}_{d}_{strat}_{entry_type}"): return
    
    sl,sl_r=_compute_sl(st,ltp,d,grade,strat); sld=max(abs(ltp-sl),CFG["sl_min_pts"])
    tgt=_compute_target(st,ltp,d,sl,grade,strat); rr=round(abs(tgt-ltp)/sld,1)
    if rr<CFG["min_rr"]: return
    
    # Update the global lock since we are officially firing the trade
    _global_strat_locks[global_lock_key] = time.time()
    
    # Generate Formatted Date/Time and Market Standards Symbol
    ts_s = datetime.now(IST).strftime("%d-%b-%Y %I:%M:%S %p")
    clean_sym = format_symbol(sym)
    lots = 2 if grade=="A+" else 1
    
    bd_str=" | ".join(f"{k}:{v}" for k,v in bd.items() if v)
    mtf_str=(f"1H:[{st.wyckoff_phase}/{st.wyckoff_dir}] 15m:[{st.trend_15m}/{st.ofi_shift_15m or '—'}] 5m:[{st.setup_5m or '—'}/{st.dir_5m or '—'}] tick:[{entry_type}]")
    print(f"\n╔{'═'*62}╗\n  {'▲ LONG' if d=='LONG' else '▼ SHORT'}  [{grade}]  SCORE:{sc}/100  [{ts_s}]  {lots}L\n  {clean_sym} ({strat})\n  ─────────────────────────────────────────────────────────────\n  Entry  : {ltp:.2f}\n  SL     : {sl:.2f}   ({sld:.2f} pts — {sl_r})\n  Target : {tgt:.2f}   ({abs(tgt-ltp):.2f} pts — R:R 1:{rr})\n  ─────────────────────────────────────────────────────────────\n  CONFLUENCE: {mtf_str}\n  BREAKDOWN: {bd_str}\n  TAPE: {st.tape_speed:.1f} TPS [{st.tape_phase}]  SP: {st.spread_phase} z={st.spread_z:+.2f}\n╚{'═'*62}╝\n")
    
    # --- FIXED: Generate the unique Signal ID at birth ---
    unique_signal_id = f"SIG_{int(time.time())}_{strat.replace(' ', '_').upper()}"
    
    # Injected new tags into signal dictionary
    rec=dict(time=ts_s, symbol=sym.split(":")[-1], formatted_symbol=clean_sym, strategy=strat, signal_id=unique_signal_id, grade=grade, score=sc, dir=d, ltp=ltp, entry=round(ltp,2), sl=sl, target=tgt, rr=rr, lots=lots, entry_type=entry_type, wyckoff=st.wyckoff_phase, bias_1h=st.wyckoff_dir, trend_15m=st.trend_15m, setup_5m=st.setup_5m or "—", score_breakdown=bd_str, sl_reason=sl_r, mtf=mtf_str, ofi_shift_15m=st.ofi_shift_15m, cvd_div_5m=st.cvd_div_5m)
    rec["created_ts"] = time.time()
    st.last_grade=grade; st.last_score=sc; _push("push_signal",rec)
    order_queue.put(rec) # 🔥 Send order to async execution worker
    
    # --- FIXED: Properly mapping all 18 column values to ensure the DB saves correctly ---
    try: 
        db_queue.put(("INSERT INTO signals (signal_id,symbol,direction,grade,score,entry,sl,target,rr,entry_type,wyckoff_phase,bias_1h,trend_15m,setup_5m,score_breakdown,sl_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (unique_signal_id,sym,d,grade,sc,ltp,sl,tgt,rr,entry_type,st.wyckoff_phase,st.wyckoff_dir,st.trend_15m,st.setup_5m,bd_str,sl_r)))
    except Exception as e: 
        print(f"⚠️ Failed to queue signal to DB: {e}")

def _check_preclose(sym,ltp,st):
    if st.preclose_fired or st.b5s_ts is None or CFG["bar_5s_sec"]-st.b5s_elapsed>CFG["preclose_window_sec"] or st.b5s_vol<CFG["bar_min_vol_preclose"]: return
    d, strat = _resolve_direction(st)
    if d and _mtf_score(st,d)[0]>=CFG["grade_a_thresh"]:
        st.preclose_fired=True; _emit_signal(sym,ltp,st,entry_type="preclose")

# ── Engine Core ───────────────────────────────────────────────────
def _process_tick_logic(message):
    global _nifty_spot
    sym = message.get("symbol", "UNKNOWN")
    
    ltp = message.get("ltp",0) or 0
    if ltp <= 0: return
    
    if sym == "NSE:NIFTY50-INDEX":
        _nifty_spot = ltp
        return

    st = _st(sym)
    st.tick_count += 1
    ts_real = time.time()

    bid = 0; ask = 0; bid_qty = 0; ask_qty = 0
    if "bids" in message and isinstance(message["bids"], list) and len(message["bids"]) > 0:
        bid = message["bids"][0].get("price", 0)
        bid_qty = message["bids"][0].get("volume", 0)
    elif "bid_price" in message:
        bid = message.get("bid_price", 0)
        bid_qty = message.get("bid_size", 0)

    if "asks" in message and isinstance(message["asks"], list) and len(message["asks"]) > 0:
        ask = message["asks"][0].get("price", 0)
        ask_qty = message["asks"][0].get("volume", 0)
    elif "ask_price" in message:
        ask = message.get("ask_price", 0)
        ask_qty = message.get("ask_size", 0)

    last_qty = message.get("last_traded_qty", 0) or 0
    side = "BUY" if ltp >= ask and ask > 0 else "SELL" if ltp <= bid and bid > 0 else st.last_side
    st.last_side = side
    tv = last_qty if last_qty > 0 else 65

    _compute_tick(st, ltp, tv, side, last_qty, bid_qty, ask_qty, ts_real)
    _analyze_spread(st, ltp, bid, ask, bid_qty, ask_qty)

    db_queue.put(("INSERT INTO ticks (symbol,ltp,bid,bid_qty,ask,ask_qty,last_qty,side,spread_z,spread_phase,tps) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (sym,ltp,bid,bid_qty,ask,ask_qty,last_qty,side,round(st.spread_z,3),st.spread_phase,round(st.tape_speed,2))))

    st.bar_5m.update(ltp, tv, side, ts_real)
    st.bar_15m.update(ltp, tv, side, ts_real)
    st.bar_1h.update(ltp, tv, side, ts_real)
    _update_5s_bar(st, ltp, tv, side, ts_real)

    if st.bar_5m.just_closed and st.bar_5m.last1():
        bar5m=st.bar_5m.last1()
        st.setup_5m,st.dir_5m,st.delta_flip_5m,st.cvd_div_5m,st.absorbed_5m = analyze_5m(st.bar_5m.bars)
        _push("push_5m",{**bar5m,"symbol":sym.split(":")[-1]}); _push("push_cvd_5m",{"symbol":sym.split(":")[-1],"values":[{"t":bar5m["ts_str"],"cvd":bar5m["cvd"]}]})
        try: db_queue.put(("INSERT INTO bars_5m (symbol,open,high,low,close,volume,delta,ofi,aggr_ratio) VALUES (?,?,?,?,?,?,?,?,?)", (sym,bar5m["o"],bar5m["h"],bar5m["l"],bar5m["c"],bar5m["vol"],bar5m["delta"],bar5m["ofi"],bar5m["aggr_ratio"])))
        except: pass

    if st.bar_15m.just_closed and st.bar_15m.last1():
        bar15m=st.bar_15m.last1()
        # 🔥 THE EXPIRY DAY FIX: Preserve the Spot Bias until Option chart matures
        new_trend, new_ofi_15, new_cvd_15, new_zone = analyze_15m(st.bar_15m.bars)
        if len(st.bar_15m.bars) >= CFG["m15_trend_ma"]:
            st.trend_15m,st.ofi_shift_15m,st.cvd_momentum_15m,st.zone_respect_15m = new_trend, new_ofi_15, new_cvd_15, new_zone
        st.zones_15m=build_liquidity_zones(st.bar_15m.bars,ltp)
        _push("push_15m",{**bar15m,"symbol":sym.split(":")[-1]}); _push("push_cvd_15m",{"symbol":sym.split(":")[-1],"values":[{"t":bar15m["ts_str"],"cvd":bar15m["cvd"]}]}); _push("push_zones",{"symbol":sym.split(":")[-1],"zones":st.zones_15m})
        try: db_queue.put(("INSERT INTO bars_15m (symbol,open,high,low,close,volume,delta,cvd_close) VALUES (?,?,?,?,?,?,?,?)", (sym,bar15m["o"],bar15m["h"],bar15m["l"],bar15m["c"],bar15m["vol"],bar15m["delta"],bar15m["cvd"])))
        except: pass

    if st.bar_1h.just_closed and st.bar_1h.last1():
        bar1h=st.bar_1h.last1()
        # 🔥 THE EXPIRY DAY FIX: Preserve the Spot Bias until Option chart matures
        new_phase, new_dir = detect_wyckoff(st.bar_1h.bars)
        if new_phase != "INSUFFICIENT_DATA":
            st.wyckoff_phase, st.wyckoff_dir = new_phase, new_dir
        _push("push_1h",{**bar1h,"symbol":sym.split(":")[-1],"wyckoff":st.wyckoff_phase}); _push("push_cvd_1h",{"symbol":sym.split(":")[-1],"values":[{"t":bar1h["ts_str"],"cvd":bar1h["cvd"]}]})
        try: db_queue.put(("INSERT INTO bars_1h (symbol,open,high,low,close,volume,delta,cvd_close,wyckoff_phase) VALUES (?,?,?,?,?,?,?,?,?)", (sym,bar1h["o"],bar1h["h"],bar1h["l"],bar1h["c"],bar1h["vol"],bar1h["delta"],bar1h["cvd"],st.wyckoff_phase)))
        except: pass

    _check_preclose(sym,ltp,st)
    if st.intra_flip_sig and not st.preclose_fired: _emit_signal(sym,ltp,st,entry_type="intra_flip"); st.preclose_fired=True
    if st.b5s_closed and not st.preclose_fired: _emit_signal(sym,ltp,st,entry_type="bar_close")

    _should_push = (
        st.tick_count % CFG["push_state_every_n_ticks"] == 0 or
        st.b5s_closed or st.bar_5m.just_closed or st.bar_15m.just_closed or st.bar_1h.just_closed or
        st.intra_flip_sig or st.sweep_sig
    ) and (ts_real - st.last_push_ts >= CFG["push_state_min_interval"])

    if _should_push:
        st.last_push_ts = ts_real
        _push("push_state",dict(symbol=sym.split(":")[-1], ltp=round(ltp,2), ofi_fast=round(st.ofi_fast,3), ofi_slow=round(st.ofi_slow,3), ofi_shift=st.ofi_shift, cvd=round(st.cvd,0), tape_phase=st.tape_phase, tape_speed=round(st.tape_speed,2), part=st.part, spread_phase=st.spread_phase, spread_z=round(st.spread_z,3), spread_armed=st.spread_armed, spread_dir=st.spread_dir, aggr_ratio=round(st.b5s_ratio,2), bar_delta=round(st.b5s_delta,0), bar_elapsed=round(st.b5s_elapsed,1), preclose_ok=(not st.preclose_fired and CFG["bar_5s_sec"]-st.b5s_elapsed<=CFG["preclose_window_sec"]), intra_flip=st.intra_flip_sig, sweep=st.sweep_sig, large_lot=st.large_lot_streak, wyckoff_phase=st.wyckoff_phase, wyckoff_dir=st.wyckoff_dir, trend_15m=st.trend_15m, ofi_shift_15m=st.ofi_shift_15m, cvd_momentum_15m=st.cvd_momentum_15m, setup_5m=st.setup_5m, dir_5m=st.dir_5m, cvd_div_5m=st.cvd_div_5m, absorbed_5m=st.absorbed_5m, delta_flip_5m=st.delta_flip_5m, zone_respect=st.zone_respect_15m, score=st.last_score, grade=st.last_grade, phase=st.phase))
        _push("push_mtf",dict(symbol=sym.split(":")[-1], wyckoff_phase=st.wyckoff_phase, wyckoff_dir=st.wyckoff_dir, trend_15m=st.trend_15m, ofi_shift_15m=st.ofi_shift_15m, cvd_momentum_15m=st.cvd_momentum_15m, zone_respect=st.zone_respect_15m, setup_5m=st.setup_5m, dir_5m=st.dir_5m, delta_flip_5m=st.delta_flip_5m, cvd_div_5m=st.cvd_div_5m, score=st.last_score))

    if st.tick_count%500==0:
        try: db_queue.put(("DELETE FROM ticks WHERE symbol=? AND ts<datetime('now','-2 hours')", (sym,)))
        except: pass

def tick_worker():
    while True:
        try:
            pubsub = redis_client.pubsub()
            pubsub.subscribe("live_fyers_ticks")
            print("✅ Math Engine Subscribed to Redis Tick Stream.")
            for raw_message in pubsub.listen():
                if raw_message["type"] == "message":
                    _process_tick_logic(json.loads(raw_message["data"]))
        except Exception as e:
            print(f"⚠️ Redis Stream Error. Reconnecting in 3s...: {e}")
            time.sleep(3)
""" def tick_worker():
    pubsub = redis_client.pubsub()
    pubsub.subscribe("live_fyers_ticks")
    print("✅ Math Engine Subscribed to Redis Tick Stream.")
    for raw_message in pubsub.listen():
        if raw_message["type"] == "message":
            try: _process_tick_logic(json.loads(raw_message["data"]))
            except Exception as e: print(f"⚠️ Worker Error: {e}") """
            
def boot_sequence():
    print("⏳ Waiting for Fyers access token in Redis...")
    token = None
    while not token:
        token = redis_client.get("fyers_access_token")
        if not token: 
            time.sleep(2)

    print("✅ Token found. Updating Fyers Model...")
    global fyers
    fyers = fyersModel.FyersModel(client_id=os.getenv("FYERS_CLIENT_ID"), token=token, log_path="")

    # ==========================================================
    # 🛡️ THE ECHO FIX: Strip the rogue logger Fyers just injected
    # ==========================================================
    root_logger = logging.getLogger()
    if len(root_logger.handlers) > 1:
        # Keep your original master logger (index 0), destroy the Fyers one
        root_logger.handlers = [root_logger.handlers[0]]
    # ==========================================================

    symbols_to_watch = [s.strip() for s in os.getenv("WATCHED_SYMBOLS", "NSE:NIFTY50-INDEX").split(",") if s.strip()]

    if symbols_to_watch:
        success = False
        while not success:
            loaded = bootstrap_all_symbols(fyers, symbols_to_watch, _st)
            if loaded > 0:
                success = True
            else:
                print("⚠️ [Bootstrap] Verification failed. Engine blinded. Retrying in 5s...")
                time.sleep(5)

    print("🚀 Starting Live Tick Worker...")
    threading.Thread(target=tick_worker, daemon=True).start()

def save_state():
    state_data = {
        sym: {
            "cvd": st.cvd, "wyckoff_phase": st.wyckoff_phase, "wyckoff_dir": st.wyckoff_dir, 
            "trend_15m": st.trend_15m, "last_score": st.last_score,
            "b1h": st.bar_1h.bars[-20:], "b15m": st.bar_15m.bars[-50:], "b5m": st.bar_5m.bars[-100:],
            "cvd1h": st.bar_1h.cvd_running, "cvd15m": st.bar_15m.cvd_running, "cvd5m": st.bar_5m.cvd_running
        } for sym, st in list(_state.items())
    }
    
    try: 
        # 🛡️ THE FIX: Calculate exact seconds until Midnight IST
        IST = pytz.timezone('Asia/Kolkata')
        now_ist = datetime.now(IST)
        
        # Determine the next midnight
        midnight_ist = (now_ist + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Calculate remaining time to live
        ttl_seconds = int((midnight_ist - now_ist).total_seconds())

        # 🟢 Use setex() to inject the data AND the Midnight self-destruct timer
        redis_client.setex("mtf_engine_state", ttl_seconds, json.dumps(state_data))
        
    except Exception as e: 
        print(f"⚠️ Save Error: {e}")

def load_state():
    try:
        raw_data = redis_client.get("mtf_engine_state")
        if raw_data:
            state_data = json.loads(raw_data)
            for sym, data in state_data.items():
                st = _st(sym); st.cvd = data.get("cvd", 0.0); st.wyckoff_phase = data.get("wyckoff_phase", "INSUFFICIENT_DATA"); st.wyckoff_dir = data.get("wyckoff_dir", "NEUTRAL"); st.trend_15m = data.get("trend_15m", "NEUTRAL"); st.last_score = data.get("last_score", 0)
                st.bar_1h.bars = data.get("b1h", []); st.bar_1h.cvd_running = data.get("cvd1h", 0.0)
                st.bar_15m.bars = data.get("b15m", []); st.bar_15m.cvd_running = data.get("cvd15m", 0.0)
                st.bar_5m.bars = data.get("b5m", []); st.bar_5m.cvd_running = data.get("cvd5m", 0.0)
            print("♻️ Memory Recovered from Redis.")
    except Exception as e: print(f"⚠️ Load Error: {e}")

def daily_garbage_collection():
    while True:
        now = datetime.now(IST)
        if now.hour == 0 and now.minute == 5:
            print("🧹 Midnight Garbage Collection & Deep System Clean...")
            _state.clear(); _srv["mtf"].clear(); _srv["zones"].clear(); _srv["bars_5m"].clear(); _srv["bars_15m"].clear(); _srv["bars_1h"].clear(); _srv["cvd_5m"].clear()
            redis_client.delete("mtf_engine_state")
            
            # 🛡️ THE FIX: Vacuum the database to reclaim gigabytes of dead disk space and free OS RAM
            try:
                conn = sqlite3.connect(DB)
                conn.execute("VACUUM;")
                conn.close()
                print("✨ SQLite Database Defragmented & Compressed.")
            except Exception as e:
                print(f"⚠️ VACUUM Error: {e}")
                
            time.sleep(60)
            
        if now.minute % 5 == 0 and now.second == 0: save_state(); time.sleep(1)
        time.sleep(30)

# ── Execution Guard ───────────────────────────────────────────────
if __name__ == "__main__":
    print("🚀 [SYSTEM] Booting MTF Engine Core...")
    
    # Load previous memory state
    load_state()
    atexit.register(save_state)
    
    # Start all background workers
    threading.Thread(target=db_worker, daemon=True).start()
    threading.Thread(target=webhook_worker, daemon=True).start()
    threading.Thread(target=order_execution_worker, daemon=True).start()
    threading.Thread(target=chain_worker, daemon=True).start()
    threading.Thread(target=daily_garbage_collection, daemon=True).start()
    
    # Start Flask API
    threading.Thread(target=lambda: app.run(host="0.0.0.0", port=5678, debug=False, use_reloader=False), daemon=True).start()
    
    # Start the boot sequence (waits for token, bootstraps data, then starts tick listener)
    threading.Thread(target=boot_sequence, daemon=True).start()
    def ping_main_backend():
        print(f"🔄 [SYSTEM] Pinging Main Trading Backend at {MAIN_PROJECT_URL}...")
        try:
            dummy_payload = {
                "symbol": "PING_TEST",
                "direction": "TEST",
                "user_id": HARDCODED_USER_ID,
                "secret": INTER_SERVICE_SECRET,
                "message": "Footprint Engine is Online!"
            }
            res = _req.post(MAIN_PROJECT_URL, json=dummy_payload, timeout=5)
            
            print(f"✅ [SYSTEM] Ping connected! Main Backend replied with HTTP {res.status_code}")
        except Exception as e:
            print(f"❌ [SYSTEM] Ping Failed. Cannot reach Main Backend: {e}")
            print("⚠️ FIX: Change MAIN_PROJECT_URL IP to 172.17.0.1 to bypass the firewall.")

    # Run the ping in the background on startup
    threading.Thread(target=ping_main_backend, daemon=True).start()
    # Keep main thread alive
    while True: time.sleep(1)