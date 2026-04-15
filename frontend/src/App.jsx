import React, { useState, useEffect } from "react";
import { useMarketData } from "./hooks/useMarketData";
import { C, BASE_P, WK_META } from "./utils/constants";
import { getOptSignal } from "./utils/optionsLogic";
import { PhaseBadge } from "./components/ui/PhaseBadge";

// Import all Tab Views
import { 
  CockpitView, ChartView, OptionChainView, PCRView, 
  GEXView, OvernightView, FPSignalsView, MatrixView 
} from "./pages/dashboard/DashboardViews";

export default function App() {
  const [paused, setPaused] = useState(false);
  const [tab, setTab] = useState("cockpit");
  const [chainFilter, setChainFilter] = useState("ALL");

  // --- THEME SYSTEM ---
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Custom hook manages all background state
  const { 
    spot, chainData, availableSyms, fpStates, fpPrices, fpSignals, 
    mtfData, cvd5m, cvd15m, cvd1h, zones, selSym, setSelSym, isOnline, lastUpdate 
  } = useMarketData(paused);

  // Derived Values for Header & Tabs
  const s = fpStates[selSym] || {};
  const wkm = WK_META[s.wyckoff_phase] || WK_META["RANGING"];
  const scoreTotal = s.score || 0;
  
  const gradeColorClass = scoreTotal >= 85 ? "text-trade-bull" : scoreTotal >= 65 ? "text-trade-blue" : scoreTotal >= 45 ? "text-trade-warn" : "text-gray-400";
  const gradeColorHex = scoreTotal >= 85 ? C.gradeAp : scoreTotal >= 65 ? C.gradeA : scoreTotal >= 45 ? C.gradeB : "rgba(255,255,255,0.3)";

  const netGEX = chainData.reduce((acc, d) => acc + d.gex, 0);
  const filteredChain = chainFilter === "ALL" ? chainData : chainFilter === "DRASTIC" ? chainData.filter(d => getOptSignal(d, spot).drastic) : chainData.filter(d => Math.abs(d.strike - spot) < 300);

  const confRows = [
    { label: "1H", name: "Wyckoff", check: s.wyckoff_phase && !["RANGING", "INSUFFICIENT_DATA"].includes(s.wyckoff_phase), val: s.wyckoff_phase || "—", dir: s.wyckoff_dir || "—", weight: 25, colClass: "text-trade-purple", borderClass: "border-trade-purple/30", bgClass: "bg-trade-purple/10" },
    { label: "15m", name: "Trend", check: s.trend_15m && s.trend_15m !== "NEUTRAL", val: s.trend_15m || "—", dir: s.trend_15m || "—", weight: 20, colClass: "text-trade-blue", borderClass: "border-trade-blue/30", bgClass: "bg-trade-blue/10" },
    { label: "15m", name: "OFI Shift", check: !!s.ofi_shift_15m, val: s.ofi_shift_15m || "—", dir: s.ofi_shift_15m?.includes("BULL") ? "BULL" : s.ofi_shift_15m?.includes("BEAR") ? "BEAR" : "—", weight: 10, colClass: "text-trade-blue", borderClass: "border-trade-blue/30", bgClass: "bg-trade-blue/10" },
    { label: "5m", name: "Setup", check: !!s.setup_5m, val: s.setup_5m || "—", dir: s.dir_5m || "—", weight: 15, colClass: "text-trade-warn", borderClass: "border-trade-warn/30", bgClass: "bg-trade-warn/10" },
    { label: "Tick", name: "OFI", check: Math.abs(s.ofi_fast || 0) >= 0.55, val: (s.ofi_fast || 0).toFixed(2), dir: (s.ofi_fast || 0) > 0 ? "BULL" : "BEAR", weight: 5, colClass: "text-trade-bull", borderClass: "border-trade-bull/30", bgClass: "bg-trade-bull/10" },
    { label: "Tick", name: "Tape", check: s.tape_phase !== "NORMAL" && !!s.tape_phase, val: s.tape_phase || "NORMAL", dir: "—", weight: 20, colClass: "text-trade-bull", borderClass: "border-trade-bull/30", bgClass: "bg-trade-bull/10" },
    { label: "Tick", name: "Spread", check: s.spread_phase === "WIDE_ALERT", val: s.spread_phase || "—", dir: s.spread_dir || "—", weight: 20, colClass: "text-trade-warn", borderClass: "border-trade-warn/30", bgClass: "bg-trade-warn/10" },
  ];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-trade-bg text-slate-900 dark:text-slate-100 font-mono transition-colors duration-200">
      
      {/* ── HEADER ── */}
      <header className="p-4 border-b border-slate-200 dark:border-trade-border flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-white dark:bg-trade-surf/50 backdrop-blur-md sticky top-0 z-50">
        <div className="flex flex-col md:flex-row md:items-center gap-6">
          
          {/* Brand & Spot */}
          <div className="flex items-center gap-6">
            <div>
              <div className="font-sans text-xl font-black tracking-tight">
                <span className="text-trade-bull">NIFTY</span><span className="text-slate-400 dark:text-slate-600 mx-1">::</span>
                <span>UNIFIED</span><span className="text-trade-purple">INTEL</span>
              </div>
              <div className="text-[10px] text-slate-500 tracking-[0.2em] mt-1 font-bold">MTF ENGINE + OPTIONS CHAIN</div>
            </div>
            <div className="border-l border-slate-300 dark:border-trade-border pl-6">
              <div className="text-2xl font-black tracking-tight">{spot.toFixed(1)}</div>
              <div className="text-[10px] text-slate-500 tracking-[0.1em] font-bold">NIFTY SPOT</div>
            </div>
          </div>

          {/* Symbol Selectors */}
          <div className="flex flex-wrap gap-2">
            {availableSyms.map(sym => (
              <button 
                key={sym} 
                onClick={() => setSelSym(sym)}
                className={`px-3 py-1.5 text-xs font-bold rounded-md border transition-all ${
                  selSym === sym 
                    ? "bg-trade-bull/10 border-trade-bull/50 text-trade-bull" 
                    : "bg-slate-100 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 hover:border-trade-bull/30"
                }`}
              >
                {sym.replace("NIFTY", "")}
                <span className={`ml-2 ${fpPrices[sym] > BASE_P[sym] ? "text-trade-bull" : "text-trade-bear"}`}>
                  {fpPrices[sym]?.toFixed(1)}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Status Indicators & Controls */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-center px-4 py-1 bg-slate-100 dark:bg-trade-surf border border-slate-200 dark:border-trade-border rounded-lg">
            <div className="text-[9px] text-slate-500 mb-0.5 tracking-wider font-bold">SIGNALS</div>
            <div className="text-base font-black text-trade-bull">{fpSignals.length}</div>
          </div>
          <div className="text-center px-4 py-1 bg-slate-100 dark:bg-trade-surf border border-slate-200 dark:border-trade-border rounded-lg">
            <div className="text-[9px] text-slate-500 mb-0.5 tracking-wider font-bold">WYCKOFF</div>
            <div className="text-base font-black" style={{ color: wkm.color }}>{s.wyckoff_phase ? s.wyckoff_phase.slice(0, 5) : "—"}</div>
          </div>
          <div className="text-center px-4 py-1 bg-slate-100 dark:bg-trade-surf border border-slate-200 dark:border-trade-border rounded-lg">
            <div className="text-[9px] text-slate-500 mb-0.5 tracking-wider font-bold">SCORE</div>
            <div className={`text-base font-black ${gradeColorClass}`}>{scoreTotal}</div>
          </div>
          
          <div className={`flex items-center text-xs font-bold px-3 py-1.5 rounded-full border ${isOnline ? "border-trade-bull/40 text-trade-bull bg-trade-bull/5" : "border-trade-bear/40 text-trade-bear bg-trade-bear/5"}`}>
            <span className={`w-2 h-2 rounded-full mr-2 ${isOnline ? "bg-trade-bull animate-pulse" : "bg-trade-bear"}`}></span>
            {isOnline ? "LIVE" : "OFFLINE"}
          </div>
          
          <button 
            onClick={() => setPaused(p => !p)} 
            className={`px-4 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
              paused 
                ? "bg-trade-bear/10 border-trade-bear/50 text-trade-bear hover:bg-trade-bear/20" 
                : "bg-trade-bull/10 border-trade-bull/50 text-trade-bull hover:bg-trade-bull/20"
            }`}
          >
            {paused ? "▶ RESUME" : "⏸ PAUSE"}
          </button>

          {/* Theme Switcher */}
          <button 
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="p-2 rounded-lg bg-slate-200 dark:bg-trade-surf border border-slate-300 dark:border-trade-border text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-white/10 transition-colors"
            title="Toggle Theme"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {/* ── NAVIGATION TABS ── */}
      <div className="px-4 border-b border-slate-200 dark:border-trade-border flex overflow-x-auto hide-scrollbar bg-white dark:bg-transparent">
        {[
          ["cockpit", "⚡ MTF COCKPIT"], ["chart", "📈 CHARTS + ZONES"], 
          ["chain", "⛓ OPTION CHAIN"], ["pcr", "🌡 PCR HEATMAP"], 
          ["gex", "📊 GEX PROFILE"], ["overnight", "🌙 OVERNIGHT"], 
          ["fpsignals", "🔔 FP SIGNALS"], ["matrix", "📋 MATRIX"]
        ].map(([k, l]) => (
          <button 
            key={k} 
            onClick={() => setTab(k)}
            className={`whitespace-nowrap px-5 py-3 text-xs font-bold tracking-wider transition-all border-b-2 ${
              tab === k 
                ? "text-trade-bull border-trade-bull" 
                : "text-slate-500 dark:text-slate-400 border-transparent hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* ── TAB CONTENT AREA ── */}
      <main className="p-4 md:p-6 overflow-x-auto">
        {tab === "cockpit" && <CockpitView selSym={selSym} fpStates={fpStates} mtfData={mtfData} cvd1h={cvd1h} cvd15m={cvd15m} cvd5m={cvd5m} fpSignals={fpSignals} zones={zones} scoreTotal={scoreTotal} gradeColorClass={gradeColorClass} gradeColorHex={gradeColorHex} confRows={confRows} wkm={wkm} />}
        {tab === "chart" && <ChartView selSym={selSym} fpStates={fpStates} fpPrices={fpPrices} zones={zones} fpSignals={fpSignals} availableSyms={availableSyms} setSelSym={setSelSym} />}
        {tab === "chain" && <OptionChainView chainFilter={chainFilter} setChainFilter={setChainFilter} filteredChain={filteredChain} spot={spot} />}
        {tab === "pcr" && <PCRView chainData={chainData} spot={spot} />}
        {tab === "gex" && <GEXView chainData={chainData} spot={spot} netGEX={netGEX} />}
        {tab === "overnight" && <OvernightView chainData={chainData} spot={spot} />}
        {tab === "fpsignals" && <FPSignalsView fpSignals={fpSignals} />}
        {tab === "matrix" && <MatrixView availableSyms={availableSyms} fpStates={fpStates} fpPrices={fpPrices} selSym={selSym} setSelSym={setSelSym} setTab={setTab} />}
      </main>

      {/* ── FOOTER ── */}
      <footer className="px-6 py-3 border-t border-slate-200 dark:border-white/5 text-[10px] text-slate-500 font-bold tracking-wider flex flex-wrap gap-6 bg-slate-100 dark:bg-transparent">
        <span className="text-trade-warn">⚠ REAL DATA — fetching from Flask MTF Engine live feed</span>
        <span>Greeks: Black-Scholes · Footprint: MTF Confluence · NOT FINANCIAL ADVICE</span>
      </footer>
    </div>
  );
}