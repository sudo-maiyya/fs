"""
fyers_ingestion.py
Patiently waits for the token in Redis, fetches live ticks, and publishes them. Zero blocking.
"""
import os, time, json
import pandas as pd
import redis
from datetime import datetime
from dotenv import load_dotenv
from fyers_apiv3 import fyersModel
from fyers_apiv3.FyersWebsocket import data_ws
import threading
import pytz


load_dotenv()
CLIENT_ID = os.getenv("FYERS_CLIENT_ID")

if not CLIENT_ID:
    print("❌ FYERS_CLIENT_ID missing from .env. Exiting.")
    exit(1)

# Connect to Redis container
redis_client = redis.Redis(host='redis', port=6379, db=0, decode_responses=True)

_cached_epoch = None
_epoch_date = None

def get_nearest_nifty_epoch():
    global _cached_epoch, _epoch_date
    today = datetime.now().date()
    if _cached_epoch and _epoch_date == today: return _cached_epoch
    try:
        print("⏳ Downloading Master CSV...")
        df = pd.read_csv("https://public.fyers.in/sym_details/NSE_FO.csv", header=None, usecols=[8, 9])
        opts = df[df[9].astype(str).str.contains(r'^NSE:NIFTY\d', regex=True) & df[9].astype(str).str.endswith(('CE', 'PE'))]
        _cached_epoch = int(opts[8].min())
        _epoch_date = today
        print(f"✅ Expiry Epoch Secured: {_cached_epoch}")
        return _cached_epoch
        """ verified_expiry = 1777370400 
        print(f"✅ [HOTFIX] Using Verified Expiry Epoch: {verified_expiry}") """
        #return verified_expiry
    except Exception as e:
        print(f"⚠️ CSV Error: {e}"); return ""

def get_option_symbols(fyers_instance, strikes=2):
    r = fyers_instance.optionchain({"symbol":"NSE:NIFTY50-INDEX", "strikecount":strikes, "timestamp": get_nearest_nifty_epoch()})
    if r.get("s") == "ok":
        syms = [c["symbol"] for c in r["data"]["optionsChain"]]
        if "NSE:NIFTY50-INDEX" not in syms: syms.append("NSE:NIFTY50-INDEX")
        return syms
    print(f"⚠️ Option Chain fetch failed: {r}")
    return ["NSE:NIFTY50-INDEX"]

def run_ingestion():
    IST = pytz.timezone('Asia/Kolkata')
    fyers_socket = None # Track instance for clean teardowns
    
    while True:
        # ==========================================================
        # 🛡️ THE PRE-MARKET GATE
        # ==========================================================
        now_ist = datetime.now(IST)
        gate_time = now_ist.replace(hour=8, minute=55, second=0, microsecond=0)
        
        if now_ist.weekday() < 5 and now_ist < gate_time:
            print("🌙 [Ingestion] Broker maintenance window. Resting until 08:55 AM...")
            time.sleep(60)
            continue
        # ==========================================================
        
        # 1. Patiently wait for the token
        access_token = redis_client.get("fyers_access_token")
        if not access_token:
            print("⏳ [Ingestion] Waiting for Fyers Access Token in Redis...")
            time.sleep(5)
            continue
            
        print("✅ [Ingestion] Token detected in Redis! Initializing connection...")
        
        # 🧹 THE FIX: Safely kill orphaned background threads before creating a new socket
        if fyers_socket is not None:
            try:
                fyers_socket.keep_running = False
            except Exception:
                pass
            fyers_socket = None
            
        fyers = fyersModel.FyersModel(client_id=CLIENT_ID, token=access_token, log_path="")
        option_symbols = get_option_symbols(fyers)
        
        connection_lock = threading.Event()
        
        def on_message(message):
            # If Fyers sends a single dictionary tick
            if isinstance(message, dict) and "symbol" in message:
                redis_client.publish("live_fyers_ticks", json.dumps(message))
                
            # If Fyers sends a list of ticks (batch update)
            elif isinstance(message, list):
                for tick in message:
                    if isinstance(tick, dict) and "symbol" in tick:
                        redis_client.publish("live_fyers_ticks", json.dumps(tick))

        def on_open():
            fyers_socket.subscribe(symbols=option_symbols, data_type="SymbolUpdate")
            print(f"✅ Websocket Subscribed to {len(option_symbols)} symbols. Streaming to Redis...")
            
        def on_error(message):
            print(f"❌ Websocket Error: {message}")
            # 🛑 THE FIX: We DO NOT call connection_lock.set() here anymore!
            # By leaving the lock engaged, we allow the Fyers SDK to cleanly execute 
            # its own "Attempting reconnect X of 5" logic without us interrupting it
            # and accidentally spinning up multiple websockets.
            
        def on_close(message):
            print(f"⚠️ Websocket Closed: {message}")
            # We ONLY break the loop when the SDK has completely abandoned the connection
            connection_lock.set() 

        ws_token = f"{CLIENT_ID}:{access_token}"
        fyers_socket = data_ws.FyersDataSocket(
            access_token=ws_token, litemode=False, reconnect=False,
            on_connect=on_open, on_message=on_message, on_error=on_error, on_close=on_close
        )

        # 4. Connect (Spawns background thread)
        fyers_socket.connect() 
        
        # 5. Freeze the main thread here forever until a hard close.
        connection_lock.wait()
        
        print("🔄 Connection completely abandoned. Re-evaluating state in 5 seconds...")
        time.sleep(5)

if __name__ == "__main__":
    run_ingestion()