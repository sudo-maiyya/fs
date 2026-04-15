export const C = {
  bg: "#04070d", surf: "rgba(255,255,255,0.025)", border: "rgba(255,255,255,0.07)",
  bull: "#00e5a0", bear: "#ff4d6d", warn: "#f59e0b", neutral: "rgba(255,255,255,0.35)",
  purple: "#a78bfa", blue: "#60a5fa", gold: "#ffd166",
  gradeAp: "#00e5a0", gradeA: "#60a5fa", gradeB: "#f59e0b",
  phase: {
    WATCHING: "rgba(255,255,255,0.2)", CONTEXT: "#f59e0b", PRIMED: "#a78bfa",
    "SIGNAL [A+]": "#00e5a0", "SIGNAL [A]": "#60a5fa", "SIGNAL [B]": "#f59e0b"
  },
  part: {
    "AGGR BUY": "#00e5a0", "PASS BUY": "#6ee7b7", "NEUTRAL": "rgba(255,255,255,0.3)",
    "PASS SELL": "#fca5a5", "AGGR SELL": "#ff4d6d"
  },
  bias: { BULLISH: "#00e5a0", BEARISH: "#ff4d6d", NEUTRAL: "#ffd166" },
  action: {
    "BUY CE": "#00e5a0", "BUY PE": "#ff4d6d", "SELL CE": "#ffd166",
    "SELL PE": "#ffd166", "SELL STRADDLE": "#a78bfa", "HOLD": "rgba(255,255,255,0.3)"
  },
};

export const gc = g => g === "A+" ? C.gradeAp : g === "A" ? C.gradeA : C.gradeB;

export const WK_META = {
  ACCUMULATION: { icon: "📦", color: "#34d399", bg: "rgba(52,211,153,0.08)", border: "rgba(52,211,153,0.3)", desc: "Institutions absorbing supply. Price flat, CVD rising, high volume. Long setup building." },
  MANIPULATION: { icon: "🪤", color: "#fb923c", bg: "rgba(251,146,60,0.08)", border: "rgba(251,146,60,0.3)", desc: "Stop hunt in progress. Price will snap back. THIS is the entry bar for institutional moves." },
  EXPANSION:    { icon: "🚀", color: "#60a5fa", bg: "rgba(96,165,250,0.08)", border: "rgba(96,165,250,0.3)", desc: "The institutional move is underway. Strong directional bars, CVD aligned. Ride with trend." },
  DISTRIBUTION: { icon: "📤", color: "#f87171", bg: "rgba(248,113,113,0.08)", border: "rgba(248,113,113,0.3)", desc: "Institutions exiting into retail buying. Price at highs, CVD diverging. Exit longs." },
  RANGING:      { icon: "↔️", color: "#64748b", bg: "rgba(100,116,139,0.06)", border: "rgba(100,116,139,0.2)", desc: "No clear Wyckoff phase. Waiting for structure to form." },
  INSUFFICIENT_DATA: { icon: "⏳", color: "#64748b", bg: "rgba(100,116,139,0.06)", border: "rgba(100,116,139,0.2)", desc: "Need more 30m bars. Keep running — will update automatically." },
};

export const FP_SYMS = ["NIFTY22500CE", "NIFTY22500PE", "NIFTY22600CE", "NIFTY22400PE"];
export const BASE_P = { NIFTY22500CE: 85, NIFTY22500PE: 72, NIFTY22600CE: 46, NIFTY22400PE: 58 };

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }