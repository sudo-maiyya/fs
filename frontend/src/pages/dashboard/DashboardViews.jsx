import React, { useEffect } from "react";
import { C, gc, WK_META, BASE_P } from "../../utils/constants";
import { getOptSignal } from "../../utils/optionsLogic";
import { PhaseBadge } from "../../components/ui/PhaseBadge";
import { CVDChart, LiquidityChart, DeltaBar, GEXChart } from "../../components/charts/CoreCharts";
import { PCRHeatmap } from "../../components/heatmaps/PCRHeatmap";

// Shared Tailwind class for cards to ensure absolute consistency
const cardClass = "bg-white dark:bg-trade-surf border border-slate-200 dark:border-trade-border rounded-xl p-4 shadow-sm";
const headingClass = "text-[10px] text-slate-500 dark:text-slate-400 font-bold tracking-[0.15em] uppercase mb-3";

// ==========================================================
// 🚀 THE SAAS SIGNAL EXECUTOR & CREDENTIAL CATCHER
// ==========================================================
export const useSignalExecutor = (fpSignals) => {
  // 1. Catcher Logic for Auth Token
  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const authParam = urlParams.get('auth');
      if (authParam) {
        const decoded = JSON.parse(atob(authParam));
        if (decoded && decoded.uid && decoded.secret) {
          localStorage.setItem('quant_auth', JSON.stringify(decoded));
          console.log("✅ [SYSTEM] Secure Credentials accepted and stored in browser.");
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }
    } catch (e) {
      console.error("Failed to parse auth token", e);
    }
  }, []);

  // 2. Client-Side Execution Logic
  useEffect(() => {
    if (!fpSignals || fpSignals.length === 0) return;

    const authDataStr = localStorage.getItem('quant_auth');
    if (!authDataStr) return; // User did not consent. Act as view-only.

    // Use window object to prevent duplicate firing if the user switches tabs
    if (!window.processedSignals) {
      const stored = JSON.parse(localStorage.getItem("processedSignals") || "[]");
      window.processedSignals = new Set(stored);
    }
    
    let authData;
    try { authData = JSON.parse(authDataStr); } catch (e) { return; }

    let hasNewSignals = false; // 🛡️ THE FIX: Batch storage flag to unblock the main UI thread!

    fpSignals.forEach(async (sig) => {
      if (!window.processedSignals.has(sig.signal_id)) {
        window.processedSignals.add(sig.signal_id);
        hasNewSignals = true;
        
        // ==========================================================
        // 🔥 THE FIX: Frontend Time-Expiry Shield (Stale Signal Drop)
        // ==========================================================
        try {
            // Extract birth epoch from SIG_1711200000_STRAT
            const birthTime = parseInt(sig.signal_id.split('_')[1]);
            const nowTime = Math.floor(Date.now() / 1000);
            
            if (nowTime - birthTime > 25) {
                console.log(`⏳ [FRONTEND SHIELD] Ignored stale signal ${sig.signal_id}. Older than 25s.`);
                return; // 🛑 Stops execution! The trade is dead.
            }
        } catch (err) {
            console.error("Signal ID parsing failed", err);
        }
        // ==========================================================
        
        // ==========================================================
        // 🛡️ THE ADMIN DOUBLE-TRIGGER SHIELD (FRONTEND BOUNCER)
        // ==========================================================
        if (authData.is_admin) {
            console.log(`🛡️ [ADMIN SHIELD] Ignored frontend execution for ${sig.symbol} (${sig.signal_id}). Backend handles this natively.`);
            return; 
        }
        // ==========================================================

        try {
          console.log(`🚀 [FRONTEND EXECUTOR] Firing ${sig.signal_id} to Main Terminal...`);
          
          const payload = {
            user_id: authData.uid,
            secret_key: authData.secret,
            symbol: sig.symbol,
            formatted_symbol: sig.formatted_symbol || sig.symbol,
            direction: sig.dir,
            entry_price: parseFloat(sig.entry),
            sl: parseFloat(sig.sl),
            target: parseFloat(sig.target),
            lots: parseInt(sig.lots),
            strategy: sig.strategy || sig.entry_type,
            signal_id: sig.signal_id
          };

          const mainBackendUrl = "http://103.168.18.1:8000/api/orders/auto-place"; 
          
          const res = await fetch(mainBackendUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          if (res.ok) {
            console.log(`✅ [FRONTEND EXECUTOR] Successfully placed trade for ${sig.symbol}`);
          } else {
            const err = await res.json();
            console.error(`❌ [FRONTEND EXECUTOR] Rejected by Main Terminal:`, err);
          }
        } catch (e) {
          console.error(`❌ [FRONTEND EXECUTOR] Network error:`, e);
        }
      }
    });

    // 🛡️ THE FIX: Persist JSON to hard drive ONCE after loop finishes. Removes micro-stutters.
    if (hasNewSignals) {
        localStorage.setItem("processedSignals", JSON.stringify([...window.processedSignals]));
    }

  }, [fpSignals]);
};
// ==========================================================

// ── 1. COCKPIT TAB ──
export function CockpitView({ selSym, fpStates, cvd1h, cvd15m, cvd5m, fpSignals, zones, scoreTotal, gradeColorClass, gradeColorHex, confRows, wkm }) {
  const s = fpStates[selSym] || {};
  useSignalExecutor(fpSignals); // --- 🔥 INJECTED EXECUTOR ---

  // --- 📊 EXPORT SIGNALS TO CSV (PULLS FULL DB HISTORY) ---
  const handleDownloadSignalsCSV = () => {
    const mtfHost = window.location.hostname || "103.168.18.1";
    // Hit the Python endpoint to download entire SQLite history
    window.open(`http://${mtfHost}:5678/export_signals`, '_blank');
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 min-h-[calc(100vh-150px)]">
      
      {/* LEFT COLUMN: Structural Analysis (Span 3) */}
      <div className="lg:col-span-3 flex flex-col gap-5">
        
        {/* 1H WYCKOFF */}
        <div className={cardClass}>
          <div className={headingClass}>1H — WYCKOFF PHASE</div>
          <div className="p-3 rounded-lg flex items-center gap-3 mb-3 border" style={{ background: wkm.bg, borderColor: wkm.border }}>
            <div className="text-3xl flex-shrink-0">{wkm.icon}</div>
            <div>
              <div className="font-sans text-sm font-black tracking-tight" style={{ color: wkm.color }}>
                {s.wyckoff_phase || "INSUFFICIENT_DATA"} {s.wyckoff_dir && s.wyckoff_dir !== "NEUTRAL" ? `→ ${s.wyckoff_dir}` : ""}
              </div>
              <div className="text-xs mt-1 opacity-80 leading-relaxed text-slate-700 dark:text-slate-300">{wkm.desc}</div>
            </div>
          </div>
          <div className="flex gap-2 mb-4">
            {["ACCUMULATION", "MANIPULATION", "EXPANSION", "DISTRIBUTION"].map((ph, i) => {
              const colors = ["#34d399", "#fb923c", "#60a5fa", "#f87171"];
              const active = s.wyckoff_phase === ph;
              return (
                <div key={ph} className="flex-1 py-1.5 rounded text-[9px] font-bold text-center tracking-wider border transition-all" style={{
                  background: active ? `${colors[i]}25` : `${colors[i]}10`, color: active ? colors[i] : `${colors[i]}55`,
                  boxShadow: active ? `0 0 8px ${colors[i]}44` : "none", borderColor: active ? `${colors[i]}44` : "transparent"
                }}>{ph.substring(0, 5)}</div>
              );
            })}
          </div>
          <div className={headingClass}>1H CUMULATIVE VOLUME DELTA</div>
          <CVDChart data={cvd1h[selSym]} color="#a78bfa" height={60} />
        </div>

        {/* 15MIN STRUCTURE */}
        <div className={cardClass}>
          <div className={headingClass}>15MIN — STRUCTURAL ANALYSIS</div>
          <div className="space-y-2 mb-4">
            <div className="flex items-center gap-3 p-2 rounded-lg bg-slate-50 dark:bg-white/5">
              <div className="text-xs font-bold w-12 text-trade-blue">TREND</div>
              <div className="flex-1 h-1.5 bg-slate-200 dark:bg-white/10 rounded-full overflow-hidden">
                <div className="h-full" style={{ width: s.trend_15m === "BULL" ? "80%" : s.trend_15m === "BEAR" ? "20%" : "50%", background: s.trend_15m === "BULL" ? C.bull : s.trend_15m === "BEAR" ? C.bear : C.neutral }}></div>
              </div>
              <div className="text-xs font-bold w-16 text-right" style={{ color: s.trend_15m === "BULL" ? C.bull : s.trend_15m === "BEAR" ? C.bear : C.neutral }}>{s.trend_15m || "—"}</div>
            </div>
            <div className="flex items-center gap-3 p-2 rounded-lg bg-slate-50 dark:bg-white/5">
              <div className="text-xs font-bold w-12 text-trade-warn">OFI</div>
              <div className="flex-1 h-1.5 bg-slate-200 dark:bg-white/10 rounded-full overflow-hidden">
                <div className="h-full" style={{ width: s.ofi_shift_15m?.includes("BULL") ? "75%" : s.ofi_shift_15m?.includes("BEAR") ? "25%" : "50%", background: s.ofi_shift_15m?.includes("BULL") ? C.bull : s.ofi_shift_15m?.includes("BEAR") ? C.bear : C.neutral }}></div>
              </div>
              <div className="text-xs font-bold w-16 text-right" style={{ color: s.ofi_shift_15m?.includes("BULL") ? C.bull : s.ofi_shift_15m?.includes("BEAR") ? C.bear : C.neutral }}>{s.ofi_shift_15m || "NEUTRAL"}</div>
            </div>
            <div className="flex items-center gap-3 p-2 rounded-lg bg-slate-50 dark:bg-white/5">
              <div className="text-xs font-bold w-12 text-trade-purple">CVD</div>
              <div className="flex-1 text-xs font-bold text-right" style={{ color: s.cvd_momentum_15m ? C.bull : C.neutral }}>{s.cvd_momentum_15m ? "ACCELERATING" : "FLAT"}</div>
            </div>
          </div>
          <div className={headingClass}>15MIN CVD</div>
          <CVDChart data={cvd15m[selSym]} color="#60a5fa" height={50} />
        </div>

        {/* 5MIN SETUP */}
        <div className={cardClass}>
          <div className={headingClass}>5MIN — ENTRY CONTEXT</div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className={`p-3 rounded-lg text-center border bg-slate-50 dark:bg-white/5 ${s.setup_5m ? 'border-trade-warn/40' : 'border-slate-200 dark:border-white/10'}`}>
              <div className="text-[9px] text-slate-500 font-bold mb-1">SETUP</div>
              <div className="text-xs font-bold" style={{ color: s.setup_5m ? C.warn : C.neutral }}>{s.setup_5m || "—"}</div>
            </div>
            <div className="p-3 rounded-lg text-center border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5">
              <div className="text-[9px] text-slate-500 font-bold mb-1">DIRECTION</div>
              <div className="text-xs font-bold" style={{ color: s.dir_5m === "LONG" ? C.bull : s.dir_5m === "SHORT" ? C.bear : C.neutral }}>{s.dir_5m || "—"}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mb-4">
            {s.delta_flip_5m && <span className="text-[10px] px-2 py-1 rounded-full font-bold bg-trade-blue/20 text-trade-blue">ΔFLIP</span>}
            {s.absorbed_5m && <span className="text-[10px] px-2 py-1 rounded-full font-bold bg-trade-warn/20 text-trade-warn">ABSORPTION</span>}
            {s.cvd_div_5m && <span className="text-[10px] px-2 py-1 rounded-full font-bold bg-trade-purple/20 text-trade-purple">{s.cvd_div_5m}</span>}
          </div>
          <div className={headingClass}>5MIN CVD</div>
          <CVDChart data={cvd5m[selSym]} color="#00e5a0" height={50} />
        </div>
      </div>

      {/* MIDDLE COLUMN: Confluence & Signals (Span 5) */}
      <div className="lg:col-span-5 flex flex-col gap-5">
        
        {/* Confluence Gate */}
        <div className={cardClass}>
          <div className={headingClass}>TIMEFRAME CONFLUENCE GATE</div>
          <div className="space-y-1.5">
            {confRows.map((r, i) => {
              const dc = r.dir === "BULL" || r.dir === "LONG" ? C.bull : r.dir === "BEAR" || r.dir === "SHORT" ? C.bear : C.neutral;
              return (
                <div key={i} className={`flex items-center gap-3 p-2 rounded-lg border ${r.check ? `${r.bgClass} ${r.borderClass}` : 'border-slate-100 dark:border-white/5 bg-transparent'}`}>
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${r.check ? '' : 'bg-slate-300 dark:bg-white/10'}`} style={{ background: r.check ? r.colClass.replace('text-','').replace('trade-bull', C.bull).replace('trade-blue', C.blue).replace('trade-warn', C.warn).replace('trade-purple', C.purple) : undefined, boxShadow: r.check ? `0 0 8px ${r.colClass.replace('text-','').replace('trade-', 'var(--')}` : 'none' }}></div>
                  <div className={`text-[10px] font-black w-8 ${r.colClass}`}>{r.label}</div>
                  <div className="text-xs font-semibold text-slate-500 flex-1">{r.name}</div>
                  <div className="text-[10px] font-black w-12" style={{ color: dc }}>{r.dir === "—" ? "" : r.dir}</div>
                  <div className={`text-xs font-bold w-32 ${r.check ? r.colClass : 'text-slate-400 dark:text-slate-500'}`}>{r.val}</div>
                  <div className="text-[10px] text-slate-400 font-bold ml-2">+{r.weight}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Tick State Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className={`${cardClass} flex flex-col items-center justify-center text-center`}>
            <div className={headingClass}>OFI FAST</div>
            <div className="text-2xl font-black" style={{ color: (s.ofi_fast || 0) > 0.55 ? C.bull : (s.ofi_fast || 0) < -0.55 ? C.bear : C.warn }}>
              {(s.ofi_fast >= 0 ? "+" : "") + (s.ofi_fast || 0).toFixed(2)}
            </div>
            <div className="text-[10px] text-slate-500 font-bold mt-1">{s.part || "NEUTRAL"}</div>
          </div>
          <div className={`${cardClass} flex flex-col items-center justify-center text-center`}>
            <div className={headingClass}>TAPE SPEED</div>
            <div className="text-2xl font-black" style={{ color: s.tape_phase === "URGENT" ? C.bear : s.tape_phase === "FAST" ? C.warn : C.neutral }}>
              {(s.tape_speed || 0).toFixed(1)}
            </div>
            <div className="text-[10px] text-slate-500 font-bold mt-1">{s.tape_phase || "NORMAL"}</div>
          </div>
          <div className={`${cardClass} flex flex-col items-center justify-center text-center`}>
            <div className={headingClass}>TICK CVD</div>
            <div className="text-2xl font-black" style={{ color: (s.cvd || 0) > 0 ? C.bull : C.bear }}>
              {(s.cvd >= 0 ? "+" : "") + Math.round(s.cvd || 0).toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-500 font-bold mt-1">SP: {s.spread_phase || "—"} z={(s.spread_z || 0).toFixed(1)}</div>
          </div>
          <div className={`${cardClass} flex flex-col items-center justify-center text-center`}>
            <div className={headingClass}>SCORE</div>
            <div className={`text-2xl font-black ${gradeColorClass}`}>{scoreTotal}</div>
            <div className={`text-[10px] font-bold mt-1 ${gradeColorClass}`}>{s.last_grade ? `${s.last_grade} SIGNAL` : "WATCHING"}</div>
          </div>
        </div>

        {/* ── UPDATED SIGNALS LOG (Matching the new Card style) ── */}
        <div className={`${cardClass} flex-1 flex flex-col overflow-hidden min-h-[300px] !bg-slate-50 dark:!bg-[#0d1117]`}>
          <div className="flex justify-between items-center mb-4">
            <span className={headingClass} style={{marginBottom: 0}}>LIVE SIGNAL LOG</span>
            <div className="flex items-center gap-2">
              {/* --- ⬇️ INJECTED DB EXPORT BUTTON HERE --- */}
              <button 
                onClick={handleDownloadSignalsCSV}
                className="text-[9px] md:text-[10px] px-2 md:px-3 py-1 rounded font-bold transition-all shadow-sm flex items-center gap-1 bg-blue-100 hover:bg-blue-200 text-blue-700 border border-blue-300 dark:bg-blue-900/50 dark:hover:bg-blue-800 dark:text-blue-400 dark:border-blue-800"
              >
                ⬇ CSV
              </button>
              <span className="text-xs font-bold text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2 py-1 rounded">{fpSignals.length} Generated</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto hide-scrollbar space-y-4">
            {fpSignals.length === 0 ? (
              <div className="text-center py-12 text-slate-400 dark:text-slate-600">
                <div className="text-4xl mb-3">🏛️</div>
                <div className="text-sm font-bold">Waiting for multi-TF confluence...</div>
                <div className="text-xs mt-1 opacity-70">All 4 timeframes must agree before execution</div>
              </div>
            ) : (
              fpSignals.slice(0, 12).map((sig, i) => {
                const gc2 = gc(sig.grade) || C.neutral;
                const isLong = sig.dir === "LONG";
                const wkmS = WK_META[sig.wyckoff] || { color: C.neutral };
                
                return (
                  <div key={i} className="bg-white dark:bg-[#1a1f2b] border rounded-lg p-4 shadow-sm font-mono" style={{ borderColor: `${gc2}40` }}>
                    
                    {/* Card Header */}
                    <div className="flex justify-between items-start mb-4">
                      <div className="flex items-center gap-4">
                        <span className="text-[10px] px-2.5 py-1 rounded font-bold tracking-widest" style={{ background: `${gc2}15`, color: gc2, border: `1px solid ${gc2}30` }}>
                          GRADE {sig.grade}
                        </span>
                        <span className={`text-sm font-bold flex items-center gap-2 ${isLong ? "text-emerald-400" : "text-rose-500"}`}>
                          {isLong ? "▲ LONG" : "▼ SHORT"}
                          <span className="text-slate-400 text-xs ml-1 flex items-center">
                            ⚡ {sig.score}/100
                          </span>
                        </span>
                      </div>
                      <div className="text-right">
                        {/* Auto-Formatted IST Time from Python */}
                        <div className="text-slate-400 text-[10px] font-bold">{sig.time}</div>
                        {/* NEW: Clean Formatted Symbol */}
                        <div className="text-slate-500 text-[11px] font-semibold mt-1">{sig.formatted_symbol || sig.symbol}</div>
                      </div>
                    </div>

                    {/* Entry/SL/Target Grid */}
                    <div className="grid grid-cols-4 gap-2 mb-4 text-center">
                      <div className="bg-slate-50 dark:bg-[#242b3d] p-2 rounded">
                        <div className="text-slate-500 text-[9px] uppercase tracking-widest font-bold mb-1">Entry</div>
                        <div className="text-orange-400 font-bold text-sm">{(sig.entry || 0).toFixed(2)}</div>
                      </div>
                      <div className="bg-slate-50 dark:bg-[#242b3d] p-2 rounded">
                        <div className="text-slate-500 text-[9px] uppercase tracking-widest font-bold mb-1">SL</div>
                        <div className="text-rose-400 font-bold text-sm">{(sig.sl || 0).toFixed(2)}</div>
                      </div>
                      <div className="bg-slate-50 dark:bg-[#242b3d] p-2 rounded">
                        <div className="text-slate-500 text-[9px] uppercase tracking-widest font-bold mb-1">Target</div>
                        <div className="text-emerald-400 font-bold text-sm">{(sig.target || 0).toFixed(2)}</div>
                      </div>
                      <div className="bg-slate-50 dark:bg-[#242b3d] p-2 rounded">
                        <div className="text-slate-500 text-[9px] uppercase tracking-widest font-bold mb-1">R:R</div>
                        <div className="text-blue-400 font-bold text-sm">1:{sig.rr}</div>
                      </div>
                    </div>

                    {/* Card Footer: Confluence & Specific Strategy */}
                    <div className="bg-slate-50 dark:bg-[#242b3d] rounded p-2 text-[10px] flex justify-between items-center border border-slate-100 dark:border-transparent">
                      <div className="truncate text-slate-500 dark:text-slate-400 font-semibold flex-1">
                        <span className="opacity-50">1H: </span><span style={{ color: wkmS.color }}>{sig.wyckoff || "—"}/{sig.bias_1h || "—"}</span>
                        <span className="mx-2 opacity-30">|</span>
                        <span className="opacity-50">15m: </span><span className="text-trade-blue">{sig.trend_15m || "—"}</span>
                        <span className="mx-2 opacity-30">|</span>
                        <span className="opacity-50">5m: </span><span className="text-trade-warn">{sig.setup_5m || "—"}</span>
                      </div>
                      
                      {/* NEW: Dedicated Strategy Tag */}
                      <div className="text-indigo-500 dark:text-indigo-400 font-bold px-2.5 py-1 bg-indigo-50 dark:bg-indigo-900/30 rounded border border-indigo-200 dark:border-indigo-500/20 whitespace-nowrap ml-2">
                        {sig.strategy || sig.entry_type}
                      </div>
                    </div>

                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* RIGHT COLUMN: Execution & Zones (Span 4) */}
      <div className="lg:col-span-4 flex flex-col gap-5">
        
        {/* Entry Gate Meter */}
        <div className={cardClass}>
          <div className={headingClass}>ENTRY GATE — ALL LAYERS</div>
          <div className="flex items-center gap-4">
            <div className="relative w-16 h-16 shrink-0">
              <svg width="64" height="64" className="-rotate-90">
                <circle cx="32" cy="32" r="28" fill="none" className="stroke-slate-200 dark:stroke-white/10" strokeWidth="6" />
                <circle cx="32" cy="32" r="28" fill="none" stroke={gradeColorHex} strokeWidth="6" strokeDasharray="175.9" strokeDashoffset={175.9 * (1 - scoreTotal / 100)} className="transition-all duration-500 ease-out" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className={`text-sm font-black ${gradeColorClass}`}>{scoreTotal}</span>
              </div>
            </div>
            <div>
              <div className={`text-lg font-black font-sans tracking-tight mb-1 ${gradeColorClass}`}>
                {scoreTotal >= 85 ? "A+ — EXECUTE" : scoreTotal >= 65 ? "A — ALERT READY" : scoreTotal >= 45 ? "B — WATCHING" : "WAITING FOR SETUP"}
              </div>
              <div className="text-xs font-bold text-slate-500">{confRows.filter(r => r.check).length}/7 conditions met</div>
              <div className="text-xs font-bold text-slate-400 mt-0.5">{s.wyckoff_dir || "NEUTRAL"} structural bias</div>
            </div>
          </div>
        </div>

        {/* 15m Zones List */}
        <div className={cardClass}>
          <div className={headingClass}>15MIN LIQUIDITY ZONES</div>
          <div className="max-h-[220px] overflow-y-auto hide-scrollbar space-y-2">
            {!(zones[selSym] || []).length ? (
              <div className="text-xs text-slate-400 py-2">Scanning for liquidity zones...</div>
            ) : (
              (zones[selSym] || []).slice(0, 10).map((z, i) => {
                const isRes = z.type === "resistance";
                const col = isRes ? C.bear : C.bull;
                const near = Math.abs((s.ltp || 0) - z.price) < 1.0;
                return (
                  <div key={i} className={`flex items-center gap-3 p-2 rounded border ${near ? 'bg-slate-50 dark:bg-white/10 border-slate-300 dark:border-white/20' : 'bg-transparent border-transparent'} ${z.swept ? 'opacity-40' : 'opacity-100'}`}>
                    <div className="text-[10px] font-black w-4" style={{ color: col }}>{isRes ? "R" : "S"}</div>
                    <div className={`text-xs w-12 text-right ${near ? 'font-black' : 'font-bold'}`} style={{ color: near ? col : C.neutral }}>{z.price.toFixed(1)}</div>
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-slate-200 dark:bg-white/10">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(z.vol * 5, 100)}%`, background: col }}></div>
                    </div>
                    <div className="text-[10px] font-bold text-slate-500 w-16 text-right">{z.swept ? "Swept" : z.tests > 1 ? `${z.tests}× Tested` : "Fresh"}</div>
                    <div className="text-[10px] font-bold text-slate-400 w-8 text-right">{z.vol.toFixed(0)}k</div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Phase Guide */}
        <div className={cardClass}>
          <div className={headingClass}>WYCKOFF PHASE GUIDE</div>
          <div className="text-[10px] leading-relaxed font-bold text-slate-600 dark:text-slate-400 space-y-2">
            <div><span className="text-emerald-400">ACCUMULATION</span> — Institutions absorbing supply. Price flat, CVD rising, high vol. Prep for Longs.</div>
            <div><span className="text-amber-500">MANIPULATION</span> — Stop hunt. Price breaks level then snaps back. This is the entry trigger bar.</div>
            <div><span className="text-blue-400">EXPANSION</span> — The markup phase. Strong directional bars, CVD aligned. Ride the trend.</div>
            <div><span className="text-rose-400">DISTRIBUTION</span> — Institutions exiting into retail buying. Price at highs, CVD diverging. Close Longs.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 2. CHARTS TAB ──
export function ChartView({ selSym, fpStates, fpPrices, zones, fpSignals, availableSyms, setSelSym }) {
  const sObj = fpStates[selSym] || {}, lp = fpPrices[selSym];
  const zList = zones[selSym] || [];
  
  useSignalExecutor(fpSignals); // --- 🔥 INJECTED EXECUTOR ---

  return (
    <div className="flex flex-col gap-6">
      {/* Primary Chart Container */}
      <div className="bg-white dark:bg-trade-surf border border-trade-bull/30 rounded-xl p-4 shadow-lg">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-3">
            <div className="text-xl font-black">{selSym}</div>
            <PhaseBadge phase={sObj.phase} />
            {sObj.burst && <span className="text-[10px] font-bold text-trade-warn animate-pulse px-2 py-1 bg-trade-warn/10 rounded">⚡ BURST</span>}
            {sObj.absorbed_5m && <span className="text-[10px] font-bold text-trade-warn px-2 py-1 bg-trade-warn/10 rounded">ABSORPTION</span>}
            {sObj.sweep_sig && <span className="text-[10px] font-bold px-2 py-1 rounded" style={{ color: sObj.sweep_sig === "BULL_SWEEP" ? C.bull : C.bear, backgroundColor: sObj.sweep_sig === "BULL_SWEEP" ? `${C.bull}20` : `${C.bear}20` }}>{sObj.sweep_sig}</span>}
          </div>
          <div className="text-3xl font-black" style={{ color: lp > BASE_P[selSym] ? C.bull : C.bear }}>{lp?.toFixed(2)}</div>
        </div>
        
        {/* Canvas elements remain unchanged as they draw internally, but container is responsive */}
        <div className="w-full overflow-hidden rounded-lg border border-slate-200 dark:border-white/10">
          <LiquidityChart ltpHistory={sObj.ltpHistory} bars={sObj.bars} zones={zList} ltp={lp} signals={fpSignals} sym={selSym} height={400} />
        </div>
        <div className="mt-2 w-full overflow-hidden rounded border border-slate-200 dark:border-white/10">
           <DeltaBar bars={sObj.bars || []} />
        </div>
        
        <div className="flex gap-2 mt-4 flex-wrap items-center">
          <span className="text-[10px] font-bold text-slate-500 mr-2">ACTIVE ZONES:</span>
          {zList.length === 0 && <span className="text-xs text-slate-400">Accumulating footprint data...</span>}
          {[...zList].sort((a, b) => b.low - a.low).map((z, i) => {
            const col = z.type === "buy" ? C.bull : C.bear;
            const near = lp != null && Math.min(Math.abs(lp - z.low), Math.abs(lp - z.high)) <= 2.0 && !z.swept;
            return (
              <span key={i} className={`px-2 py-1 rounded-full text-[10px] font-bold border transition-colors ${z.swept ? 'opacity-40 border-slate-300 dark:border-white/20 text-slate-500' : ''}`} style={{
                background: z.swept ? 'transparent' : near ? `${col}20` : `${col}10`,
                borderColor: z.swept ? '' : near ? `${col}80` : `${col}40`,
                color: z.swept ? '' : col
              }}>
                {z.type === "buy" ? "▲" : "▼"} {z.low.toFixed(1)}–{z.high.toFixed(1)} ({z.vol}K){near ? " ◀ IN ZONE" : ""}{z.swept ? " ✕ SWEPT" : ""}
              </span>
            );
          })}
        </div>
      </div>

      {/* Mini Charts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {availableSyms.filter(s => s !== selSym).map(sym => {
          const sObjO = fpStates[sym] || {}, lpO = fpPrices[sym], zListO = zones[sym] || [];
          return (
            <div key={sym} className="bg-white dark:bg-trade-surf border border-slate-200 dark:border-trade-border rounded-xl p-3 cursor-pointer hover:border-trade-bull/50 transition-colors shadow-sm" onClick={() => setSelSym(sym)}>
              <div className="flex justify-between items-center mb-3">
                <div className="text-xs font-bold flex items-center gap-2">
                  {sym.replace("NIFTY", "")}
                  <PhaseBadge phase={sObjO.phase} />
                </div>
                <div className="text-lg font-black" style={{ color: lpO > BASE_P[sym] ? C.bull : C.bear }}>{lpO?.toFixed(2)}</div>
              </div>
              <div className="w-full overflow-hidden rounded border border-slate-200 dark:border-white/5 mb-1">
                <LiquidityChart ltpHistory={sObjO.ltpHistory} bars={sObjO.bars} zones={zListO} ltp={lpO} signals={fpSignals} sym={sym} height={180} />
              </div>
              <div className="w-full overflow-hidden rounded border border-slate-200 dark:border-white/5">
                <DeltaBar bars={sObjO.bars || []} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 3. OPTION CHAIN TAB ──
export function OptionChainView({ chainFilter, setChainFilter, filteredChain, spot }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2 mb-2">
        {["ALL", "ATM", "DRASTIC"].map(f => (
          <button 
            key={f} 
            onClick={() => setChainFilter(f)} 
            className={`px-4 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
              chainFilter === f 
                ? "bg-trade-bull/10 border-trade-bull/40 text-trade-bull" 
                : "bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:border-trade-bull/30"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="w-full overflow-x-auto hide-scrollbar bg-white dark:bg-trade-surf border border-slate-200 dark:border-trade-border rounded-xl shadow-sm">
        <table className="w-full border-collapse text-xs min-w-[1100px]">
          <thead>
            <tr className="border-b border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-transparent">
              {["CE OI", "OI Δ", "IV", "Delta", "Gamma", "Theta", "Vol", "LTP", "STRIKE", "LTP", "Vol", "IV", "Delta", "PE OI", "OI Δ", "PCR", "GEX", "ACTION", "SIGNAL"].map((h, i) => (
                <th key={i} className={`p-3 text-slate-500 dark:text-slate-400 font-bold tracking-wider text-[10px] whitespace-nowrap ${i < 8 ? "text-right" : i === 8 ? "text-center" : "text-left"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/5">
            {filteredChain.map(row => {
              const sig = getOptSignal(row, spot);
              const isATM = Math.abs(row.strike - spot) < 60;
              const ac = C.action[sig.action] || "rgba(255,255,255,0.3)";
              return (
                <tr key={row.strike} className={`transition-colors hover:bg-slate-50 dark:hover:bg-white/5 ${isATM ? "bg-amber-50 dark:bg-trade-gold/5" : sig.drastic ? "bg-rose-50 dark:bg-trade-bear/5" : "bg-transparent"}`}>
                  <td className="p-2 text-right text-trade-blue font-semibold text-[11px]">{(row.ce.oi / 1000).toFixed(0)}K</td>
                  <td className="p-2 text-right font-semibold text-[11px]" style={{ color: row.ce.oiChg > 0 ? C.bull : C.bear }}>
                    {row.ce.oiChg > 0 ? "+" : ""}{(row.ce.oiChg / 1000).toFixed(0)}K
                    {sig.drasticCE && <span className="animate-pulse ml-1 text-[9px] text-trade-gold">⚡</span>}
                  </td>
                  <td className="p-2 text-right text-trade-purple font-semibold text-[11px]">{(row.ce.iv * 100).toFixed(1)}%</td>
                  <td className="p-2 text-right text-trade-blue font-semibold text-[11px]">{row.ce.delta.toFixed(3)}</td>
                  <td className="p-2 text-right text-slate-400 text-[10px]">{row.ce.gamma.toFixed(5)}</td>
                  <td className="p-2 text-right text-trade-bear font-semibold text-[11px]">{row.ce.theta.toFixed(2)}</td>
                  <td className="p-2 text-right text-slate-400 text-[10px]">{(row.ce.vol / 1000).toFixed(0)}K</td>
                  <td className="p-2 text-right font-black text-xs text-slate-800 dark:text-slate-200">{row.ce.price.toFixed(1)}</td>
                  
                  <td className={`p-2 text-center font-black text-sm border-x border-slate-200 dark:border-white/10 ${isATM ? "text-trade-gold bg-trade-gold/5" : "text-slate-800 dark:text-slate-100 bg-slate-50 dark:bg-white/5"}`}>
                    {row.strike}
                    {isATM && <div className="text-[8px] text-trade-gold uppercase mt-0.5 tracking-widest">ATM</div>}
                  </td>
                  
                  <td className="p-2 text-left font-black text-xs text-slate-800 dark:text-slate-200">{row.pe.price.toFixed(1)}</td>
                  <td className="p-2 text-left text-slate-400 text-[10px]">{(row.pe.vol / 1000).toFixed(0)}K</td>
                  <td className="p-2 text-left text-trade-purple font-semibold text-[11px]">{(row.pe.iv * 100).toFixed(1)}%</td>
                  <td className="p-2 text-left text-trade-bear font-semibold text-[11px]">{row.pe.delta.toFixed(3)}</td>
                  <td className="p-2 text-left text-trade-bear font-semibold text-[11px]">{(row.pe.oi / 1000).toFixed(0)}K</td>
                  <td className="p-2 text-left font-semibold text-[11px]" style={{ color: row.pe.oiChg > 0 ? C.bull : C.bear }}>
                    {row.pe.oiChg > 0 ? "+" : ""}{(row.pe.oiChg / 1000).toFixed(0)}K
                    {sig.drasticPE && <span className="animate-pulse ml-1 text-[9px] text-trade-gold">⚡</span>}
                  </td>
                  <td className="p-2 text-left font-black text-[11px]" style={{ color: row.pcr > 1.3 ? C.bull : row.pcr < 0.7 ? C.bear : C.gold }}>{row.pcr.toFixed(2)}</td>
                  <td className="p-2 text-left font-semibold text-[11px]" style={{ color: row.gex > 0 ? C.bull : C.bear }}>{(row.gex / 1e6).toFixed(2)}M</td>
                  <td className="p-2 text-left">
                    <span className="px-2 py-1 rounded text-[9px] font-bold tracking-wider" style={{ background: ac + "22", color: ac }}>{sig.action}</span>
                  </td>
                  <td className="p-2 text-left text-[10px] font-black" style={{ color: C.bias[sig.bias] || C.neutral }}>{sig.bias}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 4. PCR HEATMAP TAB ──
export function PCRView({ chainData, spot }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-5">
        <div className={cardClass}>
          <div className={headingClass}>PCR GUIDE</div>
          <div className="space-y-3 mt-4">
            {[["PCR > 1.3", C.bull, "Bullish Bias"], ["PCR 0.7–1.3", C.gold, "Neutral / Range"], ["PCR < 0.7", C.bear, "Bearish Bias"]].map(([l, c, d]) => (
              <div key={l} className="flex items-center gap-3">
                <div className="w-3 h-3 rounded shadow-sm" style={{ backgroundColor: c }}></div>
                <span className="text-xs font-bold" style={{ color: c }}>{l}</span>
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">→ {d}</span>
              </div>
            ))}
          </div>
        </div>
        
        <div className={`md:col-span-2 xl:col-span-3 ${cardClass}`}>
          <div className={headingClass}>SKEW — NEAR ATM (±400 POINTS)</div>
          <div className="mt-2 space-y-1.5 max-h-[200px] overflow-y-auto hide-scrollbar pr-2">
            {chainData.filter(d => Math.abs(d.strike - spot) < 400).map(d => (
              <div key={d.strike} className="flex items-center gap-3">
                <span className="text-[10px] font-bold text-slate-500 w-10 text-right">{d.strike}</span>
                <div className="flex-1 h-2 bg-slate-100 dark:bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(d.pcr / 2 * 100, 100)}%`, backgroundColor: d.pcr > 1 ? C.bull : C.bear }} />
                </div>
                <span className="text-[10px] font-black w-8" style={{ color: d.pcr > 1.3 ? C.bull : d.pcr < 0.7 ? C.bear : C.gold }}>{d.pcr.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      <div className={cardClass}>
        <div className={headingClass}>PCR HEATMAP — CE OI / PCR / PE OI</div>
        <div className="w-full overflow-hidden rounded-lg border border-slate-200 dark:border-white/10">
          <PCRHeatmap data={chainData} />
        </div>
      </div>
    </div>
  );
}

// ── 5. GEX PROFILE TAB ──
export function GEXView({ chainData, spot, netGEX }) {
  const maxGexStrike = chainData.reduce((a, b) => b.gex > a.gex ? b : a).strike;
  const minGexStrike = chainData.reduce((a, b) => b.gex < a.gex ? b : a).strike;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {[{ l: "NET GEX", v: (netGEX / 1e6).toFixed(2) + "M", c: netGEX > 0 ? C.bull : C.bear, h: netGEX > 0 ? "MM suppresses vol → Range Bound" : "MM adds fuel → Trending Market" },
          { l: "+GEX WALL (CALLS)", v: maxGexStrike, c: C.bull, h: "Strong Price Magnet / Resistance" },
          { l: "-GEX WALL (PUTS)", v: minGexStrike, c: C.bear, h: "Acceleration Zone / Support" },
        ].map(m => (
          <div key={m.l} className={`${cardClass} text-center flex flex-col justify-center`}>
            <div className={headingClass}>{m.l}</div>
            <div className="text-3xl font-black mt-1" style={{ color: m.c }}>{m.v}</div>
            <div className="text-xs font-bold text-slate-400 mt-2">{m.h}</div>
          </div>
        ))}
      </div>
      
      <div className={cardClass}>
        <div className={headingClass}>
          GAMMA EXPOSURE PROFILE — <span className="text-trade-bull">+GEX STABILIZES</span> / <span className="text-trade-bear">-GEX ACCELERATES</span>
        </div>
        <div className="w-full overflow-hidden rounded-lg border border-slate-200 dark:border-white/10">
          <GEXChart data={chainData} spot={spot} />
        </div>
      </div>
    </div>
  );
}

// ── 6. OVERNIGHT TAB ──
export function OvernightView({ chainData, spot }) {
  const pain = {};
  chainData.forEach(row => {
    chainData.forEach(r => {
      if (!pain[row.strike]) pain[row.strike] = 0;
      pain[row.strike] += Math.max(0, row.strike - r.strike) * r.ce.oi + Math.max(0, r.strike - row.strike) * r.pe.oi;
    });
  });
  const mp = Object.entries(pain).reduce((a, b) => b[1] < a[1] ? b : a)[0];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-5xl">
        <div className={cardClass}>
          <div className={headingClass}>OVERNIGHT POSITION TRACKER</div>
          <div className="space-y-3 max-h-[250px] overflow-y-auto hide-scrollbar pr-2 mt-4">
            {chainData.filter(d => Math.abs(d.strike - spot) < 400).map(row => (
              <div key={row.strike} className="pb-3 border-b border-slate-100 dark:border-white/5 last:border-0 last:pb-0">
                <div className="flex justify-between items-center mb-2">
                  <span className={`text-xs font-black ${row.atm ? 'text-trade-gold' : 'text-slate-700 dark:text-slate-300'}`}>
                    {row.strike}{row.atm ? " ATM" : ""}
                  </span>
                  <span className="text-[10px] font-bold text-slate-500">PCR {row.pcr.toFixed(2)}</span>
                </div>
                <div className="flex gap-3">
                  <span className="flex-1 text-center py-1 rounded text-[9px] font-bold tracking-wider bg-trade-blue/10 text-trade-blue border border-trade-blue/20">
                    CE: {row.ce.oiChg > 0 ? "LONGS ADDED" : "SHORT COVER"}
                  </span>
                  <span className="flex-1 text-center py-1 rounded text-[9px] font-bold tracking-wider bg-trade-bear/10 text-trade-bear border border-trade-bear/20">
                    PE: {row.pe.oiChg > 0 ? "LONGS ADDED" : "SHORT COVER"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={`${cardClass} flex flex-col justify-center items-center text-center`}>
          <div className={headingClass}>MAX PAIN THEORY</div>
          <div className="mt-4">
            <div className="text-5xl font-black text-trade-gold mb-2">{mp}</div>
            <div className="text-xs font-bold text-slate-500 mb-6">Option sellers profit most if expiration occurs exactly here.</div>
            
            <div className="inline-block text-left bg-slate-50 dark:bg-white/5 p-4 rounded-lg border border-slate-200 dark:border-white/10 space-y-2">
              <div className="text-xs font-bold">
                <span className="text-slate-500 mr-2">Spot Price:</span> 
                <span className="text-slate-900 dark:text-slate-100">{spot.toFixed(1)}</span>
              </div>
              <div className="text-xs font-bold">
                <span className="text-slate-500 mr-2">Distance:</span> 
                <span style={{ color: Math.abs(spot - mp) > 200 ? C.bear : C.bull }}>{(spot - mp).toFixed(0)} points</span>
              </div>
              <div className="text-xs font-bold">
                <span className="text-slate-500 mr-2">Expected Drift:</span> 
                <span style={{ color: spot > mp ? C.bear : C.bull }}>{spot > mp ? "↓ Pulling down toward Max Pain" : "↑ Pushing up toward Max Pain"}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={cardClass}>
        <div className={headingClass}>CARRY TRADE RECOMMENDATIONS</div>
        <div className="w-full overflow-x-auto hide-scrollbar">
          <table className="w-full border-collapse text-xs min-w-[900px]">
            <thead>
              <tr className="border-b border-slate-200 dark:border-white/10">
                {["STRIKE", "ACTION", "CARRY STRATEGY", "BIAS", "STRENGTH", "CE OI Δ", "PE OI Δ", "THETA DECAY/DAY", "RATIONALE"].map(h => (
                  <th key={h} className="p-3 text-left text-[10px] text-slate-500 dark:text-slate-400 font-bold tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {chainData.map(row => {
                const sig = getOptSignal(row, spot);
                const ac = C.action[sig.action] || C.neutral;
                const theta = (row.ce.theta * row.ce.oi * 0.01 + row.pe.theta * row.pe.oi * 0.01).toFixed(0);
                return (
                  <tr key={row.strike} className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
                    <td className="p-3 font-black text-sm" style={{ color: row.atm ? C.gold : "" }}>{row.strike}{row.atm ? " ★" : ""}</td>
                    <td className="p-3">
                      <span className="px-2 py-1 rounded text-[9px] font-bold tracking-wider" style={{ background: ac + "20", color: ac }}>{sig.action}</span>
                    </td>
                    <td className="p-3 font-semibold text-slate-600 dark:text-slate-300">{sig.carry}</td>
                    <td className="p-3 font-black text-[11px]" style={{ color: C.bias[sig.bias] || C.neutral }}>{sig.bias}</td>
                    <td className="p-3 w-32">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-slate-200 dark:bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${sig.strength}%`, background: sig.strength > 70 ? C.bull : sig.strength > 55 ? C.warn : C.bear }} />
                        </div>
                        <span className="text-[10px] font-bold text-slate-500 w-8">{sig.strength}%</span>
                      </div>
                    </td>
                    <td className="p-3 font-semibold text-[11px]" style={{ color: row.ce.oiChg > 0 ? C.bull : C.bear }}>{row.ce.oiChg > 0 ? "▲" : "▼"}{(row.ce.oiChg / 1000).toFixed(0)}K</td>
                    <td className="p-3 font-semibold text-[11px]" style={{ color: row.pe.oiChg > 0 ? C.bull : C.bear }}>{row.pe.oiChg > 0 ? "▲" : "▼"}{(row.pe.oiChg / 1000).toFixed(0)}K</td>
                    <td className="p-3 font-black text-[11px]" style={{ color: theta < 0 ? C.bear : C.bull }}>{theta}</td>
                    <td className="p-3 text-[10px] font-semibold text-slate-500 dark:text-slate-400 truncate max-w-[200px]" title={sig.reason}>{sig.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── 7. FP SIGNALS TAB (UPDATED WITH STRATEGY AND CSV) ──
export function FPSignalsView({ fpSignals }) {
  
  useSignalExecutor(fpSignals); // --- 🔥 INJECTED EXECUTOR ---

  // --- 📊 EXPORT SIGNALS TO CSV (FIXED TO PULL ALL DB RECORDS) ---
  const handleDownloadSignalsCSV = () => {
    const mtfHost = window.location.hostname || "103.168.18.1";
    // Hit the brand new Python endpoint we just created
    window.open(`http://${mtfHost}:5678/export_signals`, '_blank');
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        {/* 🛡️ THE FIX: Replaced "ACTIVE" with "GENERATED" */}
        {[{ l: "TOTAL GENERATED", v: fpSignals.length, c: C.bull }, { l: "GRADE A+", v: fpSignals.filter(s => s.grade === "A+").length, c: C.gradeAp },
        { l: "GRADE A", v: fpSignals.filter(s => s.grade === "A").length, c: C.gradeA }, { l: "GRADE B", v: fpSignals.filter(s => s.grade === "B").length, c: C.gradeB }
        ].map(m => (
          <div key={m.l} className={`${cardClass} text-center`}>
            <div className={headingClass}>{m.l}</div>
            <div className="text-3xl font-black mt-2" style={{ color: m.v > 0 ? m.c : C.neutral }}>{m.v}</div>
          </div>
        ))}
      </div>
      
      <div className={cardClass}>
        {/* --- ⬇️ EXPORT BUTTON ADDED TO HEADER --- */}
        <div className="flex justify-between items-center mb-3">
          <div className={headingClass} style={{marginBottom: 0}}>MULTI-TIMEFRAME FOOTPRINT SIGNALS</div>
          <button 
            onClick={handleDownloadSignalsCSV}
            className="text-[9px] md:text-[10px] px-2 md:px-3 py-1 rounded font-bold transition-all shadow-sm flex items-center gap-1 bg-blue-100 hover:bg-blue-200 text-blue-700 border border-blue-300 dark:bg-blue-900/50 dark:hover:bg-blue-800 dark:text-blue-400 dark:border-blue-800"
          >
            ⬇ EXPORT DB
          </button>
        </div>

        {fpSignals.length === 0 ? (
          <div className="text-center py-16 text-slate-400 dark:text-slate-500">
            <div className="text-5xl mb-4">👁</div>
            <div className="text-sm font-bold tracking-wider">Watching for 3-phase footprint confluence...</div>
          </div>
        ) : (
          <div className="w-full overflow-x-auto hide-scrollbar mt-4">
            <table className="w-full border-collapse text-xs min-w-[1000px]">
              <thead>
                <tr className="border-b border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-transparent">
                  {["TIME", "SYMBOL", "GRADE", "DIR", "LTP", "ENTRY", "SL", "TARGET", "R:R", "LOTS", "STRATEGY", "CONTEXT", "SCORE BREAKDOWN"].map(h => (
                    <th key={h} className="p-3 text-left text-[10px] text-slate-500 dark:text-slate-400 font-bold tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                {fpSignals.map((sig, i) => {
                  const gCol = gc(sig.grade) || C.neutral;
                  return (
                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
                      <td className="p-3 text-[10px] font-bold text-slate-400">{sig.time}</td>
                      <td className="p-3 font-black text-[11px]">{sig.formatted_symbol || sig.symbol?.replace("NIFTY", "")}</td>
                      <td className="p-3">
                        <span className="px-2 py-1 rounded-full text-[9px] font-black border" style={{ background: gCol + "15", color: gCol, borderColor: gCol + "40" }}>
                          {sig.grade}
                        </span>
                      </td>
                      <td className="p-3 font-black text-[11px]" style={{ color: sig.dir === "LONG" ? C.bull : C.bear }}>{sig.dir === "LONG" ? "▲ LONG" : "▼ SHORT"}</td>
                      <td className="p-3 font-semibold text-[11px] text-slate-800 dark:text-slate-200">{sig.ltp?.toFixed(2)}</td>
                      <td className="p-3 font-black text-[11px] text-trade-warn">{sig.entry?.toFixed(2)}</td>
                      <td className="p-3 font-black text-[11px] text-trade-bear">{sig.sl?.toFixed(2)}</td>
                      <td className="p-3 font-black text-[11px] text-trade-bull">{sig.target?.toFixed(2)}</td>
                      <td className="p-3 font-black text-[11px]" style={{ color: sig.rr >= 2.5 ? C.bull : sig.rr >= 1.5 ? C.warn : C.bear }}>1:{sig.rr}</td>
                      <td className="p-3 font-bold text-[11px]" style={{ color: gCol }}>{sig.lots}L</td>
                      
                      <td className="p-3 text-[10px] font-bold text-indigo-500 dark:text-indigo-400 whitespace-nowrap">{sig.strategy || sig.entry_type}</td>
                      
                      <td className="p-3 text-[10px] font-bold text-slate-500 whitespace-nowrap">{sig.mtf}</td>
                      <td className="p-3 text-[9px] font-bold text-slate-400 max-w-[150px] truncate" title={sig.score_breakdown}>{(sig.score_breakdown || "").substring(0, 30)}...</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 8. MATRIX TAB ──
export function MatrixView({ availableSyms, fpStates, fpPrices, selSym, setSelSym, setTab }) {
  const tick = v => v ? <span className="text-trade-bull text-xs font-black">✓</span> : <span className="text-slate-300 dark:text-white/10 text-xs">—</span>;
  return (
    <div className={cardClass}>
      <div className={headingClass}>FULL STATE MATRIX — ALL FOOTPRINT SYMBOLS</div>
      <div className="w-full overflow-x-auto hide-scrollbar mt-4">
        <table className="w-full border-collapse text-xs min-w-[1000px]">
          <thead>
            <tr className="border-b border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-transparent">
              {["SYMBOL", "LTP", "PHASE", "OFI", "TAPE", "SPREAD", "WYCKOFF", "15m TREND", "15m OFI", "5m SETUP", "ABS", "FLIP", "SCORE"].map(h => (
                <th key={h} className="p-3 text-left text-[9px] text-slate-500 dark:text-slate-400 font-bold tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/5">
            {availableSyms.map(sym => {
              const sObj = fpStates[sym] || {};
              const lp = fpPrices[sym];
              const isSel = selSym === sym;
              return (
                <tr 
                  key={sym} 
                  className={`cursor-pointer transition-colors hover:bg-slate-100 dark:hover:bg-white/10 ${isSel ? "bg-trade-bull/5 border-l-2 border-trade-bull" : "border-l-2 border-transparent bg-transparent"}`}
                  onClick={() => { setSelSym(sym); setTab("cockpit"); }}
                >
                  <td className={`p-3 font-black text-[11px] ${isSel ? 'text-trade-bull' : 'text-slate-700 dark:text-slate-300'}`}>{sym.replace("NIFTY", "")}</td>
                  <td className="p-3 font-black text-[11px]" style={{ color: lp > BASE_P[sym] ? C.bull : C.bear }}>{lp?.toFixed(2)}</td>
                  <td className="p-3"><PhaseBadge phase={sObj.phase || "WATCHING"} /></td>
                  <td className="p-3 font-black text-[11px]" style={{ color: sObj.ofi_fast > 0.3 ? C.bull : sObj.ofi_fast < -0.3 ? C.bear : C.neutral }}>{(sObj.ofi_fast >= 0 ? "+" : "") + (sObj.ofi_fast || 0).toFixed(2)}</td>
                  <td className="p-3 text-[10px] font-bold" style={{ color: sObj.tape_phase !== "NORMAL" ? C.warn : C.neutral }}>{sObj.tape_phase || "NORMAL"}</td>
                  <td className="p-3 text-[10px] font-bold" style={{ color: sObj.spread_phase === "WIDE_ALERT" ? C.warn : C.neutral }}>{sObj.spread_phase || "NORMAL"}</td>
                  <td className="p-3 text-[10px] font-bold text-slate-600 dark:text-slate-300">{sObj.wyckoff_phase || "—"}</td>
                  <td className="p-3 text-[10px] font-black" style={{ color: sObj.trend_15m === "BULL" ? C.bull : sObj.trend_15m === "BEAR" ? C.bear : C.neutral }}>{sObj.trend_15m || "—"}</td>
                  <td className="p-3 text-[10px] font-bold" style={{ color: sObj.ofi_shift_15m ? C.blue : C.neutral }}>{sObj.ofi_shift_15m || "—"}</td>
                  <td className="p-3 text-[10px] font-bold" style={{ color: sObj.setup_5m ? C.warn : C.neutral }}>{sObj.setup_5m || "—"}</td>
                  <td className="p-3 text-center">{tick(sObj.absorbed_5m)}</td>
                  <td className="p-3 text-center">{tick(sObj.delta_flip_5m)}</td>
                  <td className="p-3 font-black text-sm" style={{ color: sObj.score >= 85 ? C.gradeAp : sObj.score >= 65 ? C.gradeA : sObj.score >= 45 ? C.gradeB : C.neutral }}>{sObj.score || 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}