"""
bootstrap_history.py
Pre-fills BarBuilder buffers from Fyers historical candle API so MTF
analysis (Wyckoff, 15m trend, zones, 5m setup) is live from tick #1.

Imported directly by mtf_brain.py during its Boot Sequence.
"""

import time, math
import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone

# ── Fyers resolution codes ─────────────────────────────────────────
# These match the Fyers v3 history API "resolution" parameter
_RES = {
    "5m":  "5",
    "15m": "15",
    "1h":  "30", # THE FIX: Tricking the engine into loading 30m bars to accelerate Wyckoff on decaying Options
}

# How many bars to fetch per timeframe on startup
_PREFETCH = {
    "5m":  50,   # 50 × 5min  = ~4.2 hours — enough for setup detection
    "15m": 30,   # 30 × 15min = ~7.5 hours — 3+ full trend_ma cycles
    "1h":  30,   # 30 × 30min = 15 hours    — Solid accelerated Wyckoff context
}

def _fetch_candles(fyers, symbol: str, resolution: str, n_bars: int) -> list[dict]:
    """
    Fetch last n_bars closed candles from Fyers history API.
    """
    # --- FIXED: Massive 15-day lookback buffer to safely cross all weekends/holidays ---
    IST = timezone(timedelta(hours=5, minutes=30))
    date_end   = datetime.now(IST)
    date_start = date_end - timedelta(days=15)

    is_derivative = symbol.endswith(("CE", "PE", "FUT"))

    payload = {
        "symbol":      symbol,
        "resolution":  resolution,
        "date_format": "0",  
        "range_from":  str(int(date_start.timestamp())),
        "range_to":    str(int(date_end.timestamp())),
        "cont_flag":   "1" if is_derivative else "0", 
    }

    try:
        res = fyers.history(data=payload)
    except Exception as e:
        print(f"⚠️ [Bootstrap] Fyers history call failed for {symbol}/{resolution}: {e}")
        return []

    if res.get("s") != "ok":
        print(f"⚠️ [Bootstrap] Fyers returned error for {symbol}/{resolution}: {res.get('message','?')} | Payload: {payload}")
        return []

    candles = res.get("candles", [])
    now_ts = time.time()
    parsed = []
    for c in candles:
        if len(c) < 6:
            continue
        ts, o, h, l, close_p, vol = c[0], c[1], c[2], c[3], c[4], c[5]
        
        # Skip the currently open/live bar (it's incomplete)
        if ts > now_ts - int(resolution) * 60:
            continue
            
        parsed.append(dict(
            ts=float(ts),
            ts_str=datetime.fromtimestamp(ts).strftime("%H:%M"),
            o=float(o), h=float(h), l=float(l), c=float(close_p),
            vol=float(vol),
        ))

    # Automatically slice only the exact number of bars we need from the 15-day payload
    return parsed[-n_bars:]


def _bars_to_bar_format(raw_candles: list[dict]) -> list[dict]:
    """
    Convert raw OHLCV candles into the same dict format that BarBuilder
    produces, with synthetic delta/cvd/ofi/aggr_ratio estimates.

    We don't have tick data so we estimate:
    - delta  = (close - open) / range × volume  (price action proxy)
    - aggr_ratio = abs(delta) / volume
    - ofi    = delta / volume  (normalised)
    - cvd    = running cumulative delta
    """
    bars = []
    cvd_running = 0.0
    for b in raw_candles:
        rng = max(b["h"] - b["l"], 0.01)
        body = b["c"] - b["o"]
        # Directional volume estimate — this is NOT tick delta but it's
        # the best proxy from OHLCV and is good enough for Wyckoff/trend seeding
        delta = round((body / rng) * b["vol"], 0)
        cvd_running += delta
        aggr_ratio = round(abs(delta) / (b["vol"] + 1e-9), 3)
        ofi = round(delta / (b["vol"] + 1e-9), 3)
        bars.append(dict(
            ts=b["ts"], ts_str=b["ts_str"],
            o=b["o"], h=b["h"], l=b["l"], c=b["c"],
            vol=round(b["vol"], 0),
            delta=delta,
            cvd=round(cvd_running, 0),
            aggr_ratio=aggr_ratio,
            ofi=ofi,
            range=rng,
            body=abs(body),
            bull=b["c"] >= b["o"],
        ))
    return bars


def bootstrap_symbol(fyers, sym: str, st) -> bool:
    """
    Fetch historical bars for all three timeframes and inject them
    directly into the SymState BarBuilders for `sym`.

    Returns True if at least 1H data was loaded successfully.
    """
    print(f"🔄 [Bootstrap] Loading history for {sym}...")
    success = False

    # ── 1H — Wyckoff context ──────────────────────────────────────
    # 🔥 THE EXPIRY DAY CURE: Use Spot index for clean macro history!
    base_spot = "NSE:NIFTY50-INDEX"
    if "BANKNIFTY" in sym: base_spot = "NSE:NIFTYBANK-INDEX"
    elif "FINNIFTY" in sym: base_spot = "NSE:FINNIFTY-INDEX"
    elif "MIDCPNIFTY" in sym: base_spot = "NSE:MIDCPNIFTY-INDEX"

    raw_1h = _fetch_candles(fyers, base_spot, _RES["1h"], _PREFETCH["1h"])
    raw_1h_opt = _fetch_candles(fyers, sym, _RES["1h"], _PREFETCH["1h"])
    if raw_1h_opt:
        bars_1h = _bars_to_bar_format(raw_1h_opt)
        st.bar_1h.bars = bars_1h
        # Seed the running CVD of the BarBuilder so live ticks continue correctly
        st.bar_1h.cvd_running = bars_1h[-1]["cvd"] if bars_1h else 0.0
        success = True
        print(f"  ✅ 1H (30m) Option: {len(bars_1h)} bars loaded | last={bars_1h[-1]['ts_str']} c={bars_1h[-1]['c']}")
    else:
        print(f"  ❌ 1H Option: No data returned")

    # ── 15m — trend + zones ───────────────────────────────────────
    raw_15m = _fetch_candles(fyers, base_spot, _RES["15m"], _PREFETCH["15m"])
    raw_15m_opt = _fetch_candles(fyers, sym, _RES["15m"], _PREFETCH["15m"])
    if raw_15m_opt:
        bars_15m = _bars_to_bar_format(raw_15m_opt)
        st.bar_15m.bars = bars_15m
        st.bar_15m.cvd_running = bars_15m[-1]["cvd"] if bars_15m else 0.0
        print(f"  ✅ 15m Option: {len(bars_15m)} bars loaded | last={bars_15m[-1]['ts_str']} c={bars_15m[-1]['c']}")
    else:
        print(f"  ❌ 15m Option: No data returned")

    # ── 5m — setup detection ──────────────────────────────────────
    raw_5m = _fetch_candles(fyers, sym, _RES["5m"], _PREFETCH["5m"])
    if raw_5m:
        bars_5m = _bars_to_bar_format(raw_5m)
        st.bar_5m.bars = bars_5m
        st.bar_5m.cvd_running = bars_5m[-1]["cvd"] if bars_5m else 0.0
        print(f"  ✅ 5m Option: {len(bars_5m)} bars loaded | last={bars_5m[-1]['ts_str']} c={bars_5m[-1]['c']}")
    else:
        print(f"  ❌ 5m Option: No data returned")

    # ── Run MTF analyzers immediately on loaded data ──────────────
    # So st.wyckoff_phase, st.trend_15m, st.zones_15m, st.setup_5m
    # are all populated before tick #1 arrives.
    if raw_1h: # 🔥 THE FIX: Using Spot raw_1h for Wyckoff calculation
        bars_1h_spot = _bars_to_bar_format(raw_1h)
        from mtf_brain import detect_wyckoff
        st.wyckoff_phase, st.wyckoff_dir = detect_wyckoff(bars_1h_spot)
        print(f"  🧠 Wyckoff seeded (from Spot): {st.wyckoff_phase} / {st.wyckoff_dir}")

    if raw_15m: # 🔥 THE FIX: Using Spot raw_15m for Trend calculation
        bars_15m_spot = _bars_to_bar_format(raw_15m)
        from mtf_brain import analyze_15m
        st.trend_15m, st.ofi_shift_15m, st.cvd_momentum_15m, st.zone_respect_15m = analyze_15m(bars_15m_spot)
        print(f"  🧠 15m seeded (from Spot): trend={st.trend_15m}")
        
    if st.bar_15m.bars: # Using Option for Liquidity Zones
        from mtf_brain import build_liquidity_zones
        ltp_approx = st.bar_15m.bars[-1]["c"]
        st.zones_15m = build_liquidity_zones(st.bar_15m.bars, ltp_approx)
        print(f"  🧠 15m Zones seeded (from Option): zones={len(st.zones_15m)}")

    if st.bar_5m.bars:
        from mtf_brain import analyze_5m
        st.setup_5m, st.dir_5m, st.delta_flip_5m, st.cvd_div_5m, st.absorbed_5m = analyze_5m(st.bar_5m.bars)
        print(f"  🧠 5m seeded (Option): setup={st.setup_5m or '—'} dir={st.dir_5m or '—'}")

    return success

def bootstrap_all_symbols(fyers, symbols: list[str], _st_func, delay_between=0.5):
    """
    Bootstrap all watched symbols before tick stream starts.

    Args:
        fyers:           fyersModel instance (must have valid token)
        symbols:         list of Fyers symbol strings e.g. ["NSE:NIFTY2560522000CE"]
        _st_func:        the _st() function from mtf_brain that returns/creates SymState
        delay_between:   seconds to wait between symbols (avoid rate limits)
    """
    print(f"\n{'='*60}")
    print(f"  MTF Bootstrap — {len(symbols)} symbol(s)")
    print(f"{'='*60}")
    loaded = 0
    for sym in symbols:
        st = _st_func(sym)
        ok = bootstrap_symbol(fyers, sym, st)
        if ok:
            loaded += 1
        if delay_between > 0:
            time.sleep(delay_between)
    print(f"\n✅ Bootstrap complete: {loaded}/{len(symbols)} symbols ready")
    print(f"{'='*60}\n")
    return loaded