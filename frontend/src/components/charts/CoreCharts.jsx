import React, { useRef, useEffect } from "react";
import { C, gc, clamp } from "../../utils/constants";

export function CVDChart({ data = [], color = "#00e5a0", height = 45 }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = height;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + "px"; cv.style.height = H + "px";
    const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    ctx.fillStyle = "transparent"; ctx.fillRect(0, 0, W, H);
    if (!data || data.length < 2) return;
    const vals = data.map(d => d.cvd || 0);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const rng = hi - lo || 1;
    const n = vals.length;
    const xOf = i => (i / (n - 1)) * W;
    const yOf = v => H - ((v - lo) / rng) * (H * 0.85) - H * 0.075;
    const y0 = yOf(0);
    ctx.strokeStyle = "rgba(255,255,255,0.1)"; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();
    ctx.beginPath();
    vals.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
    ctx.lineTo(W, y0); ctx.lineTo(0, y0); ctx.closePath();
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, color + "44"); grd.addColorStop(1, "transparent");
    ctx.fillStyle = grd; ctx.fill();
    ctx.beginPath();
    vals.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    const last = vals[vals.length - 1];
    const lc = last >= 0 ? color : "#ff4d6d";
    ctx.fillStyle = lc; ctx.font = `bold 8px 'JetBrains Mono'`; ctx.textAlign = "right";
    ctx.fillText((last >= 0 ? "+" : "") + Math.round(last).toLocaleString(), W - 3, 10);
  }, [data, color, height]);
  return <canvas ref={ref} style={{ display: "block", width: "100%", borderRadius: 5 }} />;
}

export function LiquidityChart({ ltpHistory = [], bars = [], zones = [], ltp, signals = [], sym = "", height = 280 }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 500, H = height;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + "px"; cv.style.height = H + "px";
    const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#06090f"; ctx.fillRect(0, 0, W, H);
    if (!bars.length && !ltpHistory.length) {
      ctx.fillStyle = "rgba(255,255,255,0.15)"; ctx.font = "10px monospace"; ctx.textAlign = "center";
      ctx.fillText("Accumulating...", W / 2, H / 2); return;
    }
    const allP = [...bars.map(b => [b.h, b.l]).flat(), ...ltpHistory.map(p => p.v), ...zones.map(z => [z.low, z.high]).flat(), ltp].filter(v => v != null && isFinite(v));
    if (!allP.length) return;
    const rawLo = Math.min(...allP), rawHi = Math.max(...allP), pr = (rawHi - rawLo) || 1;
    const lo = rawLo - pr * 0.07, hi = rawHi + pr * 0.07, rng = hi - lo;
    const PL = 50, PR = 56, PT = 14, PB = 40;
    const cW = W - PL - PR, cH = H - PT - PB;
    const yP = v => PT + cH - ((v - lo) / rng) * cH;
    const xB = i => PL + (i / Math.max(bars.length, 1)) * cW;
    const cw = Math.max(Math.floor(cW / Math.max(bars.length, 1)) - 1, 2);
    ctx.strokeStyle = "rgba(255,255,255,0.04)"; ctx.lineWidth = 1;
    for (let g = 0; g <= 5; g++) {
      const y = PT + g * (cH / 5); ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL + cW, y); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.font = "9px monospace"; ctx.textAlign = "right";
      ctx.fillText((hi - (g / 5) * rng).toFixed(1), PL - 4, y + 3);
    }
    const maxV = Math.max(...zones.map(z => z.vol || 0), 1);
    zones.forEach(z => {
      const y1 = yP(z.high), y2 = yP(z.low); if (!isFinite(y1) || !isFinite(y2)) return;
      const zH = Math.max(y2 - y1, 2), col = z.type === "buy" ? "#00e5a0" : "#ff4d6d";
      const near = ltp != null && Math.min(Math.abs(ltp - z.low), Math.abs(ltp - z.high)) <= 2.0 && !z.swept;
      const alpha = z.swept ? 0.03 : near ? 0.15 : 0.07;
      const gZ = ctx.createLinearGradient(PL, 0, PL + cW, 0);
      gZ.addColorStop(0, col + Math.round(alpha * 255).toString(16).padStart(2, "0"));
      gZ.addColorStop(1, "transparent");
      ctx.fillStyle = gZ; ctx.fillRect(PL, y1, cW, zH);
      ctx.strokeStyle = col + (z.swept ? "15" : near ? "bb" : "44"); ctx.lineWidth = near ? 1.5 : 0.8;
      ctx.setLineDash(z.swept ? [3, 4] : []);
      ctx.beginPath(); ctx.moveTo(PL, y1); ctx.lineTo(PL + cW, y1); ctx.stroke();
      ctx.setLineDash([]);
      const vW = Math.max(((z.vol || 0) / maxV) * (PR - 12), 2);
      ctx.fillStyle = col + (z.swept ? "22" : "66"); ctx.fillRect(PL + cW + 2, y1 + 1, vW, Math.max(zH - 2, 1));
      const mid = (y1 + y2) / 2;
      ctx.fillStyle = col + (z.swept ? "55" : "cc"); ctx.font = (near ? "bold " : "") + "8px monospace"; ctx.textAlign = "left";
      ctx.fillText((z.type === "buy" ? "▲B" : "▼S") + " " + (z.vol || 0).toFixed(0) + "K" + (z.swept ? " ✕" : near ? " ◀" : ""), PL + cW + 4, mid + 3);
      if (near) {
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(PL - 9, mid, 4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = col + "44"; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(PL - 9, mid, 7, 0, Math.PI * 2); ctx.stroke();
      }
    });
    if (ltpHistory.length > 1) {
      const vals = ltpHistory.map(p => p.v), lc = vals.at(-1) >= vals[0] ? "#00e5a055" : "#ff4d6d55";
      const xH = i => PL + (i / Math.max(vals.length - 1, 1)) * cW;
      ctx.beginPath(); vals.forEach((v, i) => i === 0 ? ctx.moveTo(xH(i), yP(v)) : ctx.lineTo(xH(i), yP(v)));
      ctx.strokeStyle = lc; ctx.lineWidth = 1; ctx.stroke();
    }
    const avgV = bars.reduce((s, b) => s + b.vol, 0) / Math.max(bars.length, 1);
    const avgR = bars.reduce((s, b) => s + b.range, 0) / Math.max(bars.length, 1);
    bars.forEach((b, i) => {
      const x = xB(i), isBull = b.c >= b.o, col = isBull ? "#00e5a0" : "#ff4d6d";
      const oY = yP(b.o), cY = yP(b.c), hY = yP(b.h), lY = yP(b.l);
      ctx.strokeStyle = col + "bb"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + cw / 2, hY); ctx.lineTo(x + cw / 2, lY); ctx.stroke();
      const bY = Math.min(oY, cY), bH = Math.max(Math.abs(oY - cY), 1);
      ctx.fillStyle = isBull ? col + "99" : col + "88"; ctx.fillRect(x, bY, cw, bH);
      ctx.strokeStyle = col; ctx.lineWidth = 0.8; ctx.strokeRect(x, bY, cw, bH);
      if (b.vol > avgV * 1.8 && b.range < avgR * 0.45) { ctx.strokeStyle = "#f59e0baa"; ctx.lineWidth = 2; ctx.strokeRect(x - 1, bY - 1, cw + 2, bH + 2); }
    });
    const sig = signals.filter(s => s.symbol === sym)[0];
    if (sig) {
      const isL = sig.dir === "LONG", gCol = gc(sig.grade);
      const eY = yP(sig.entry), tY = yP(sig.target), slY = yP(sig.sl);
      ctx.fillStyle = (isL ? "#00e5a0" : "#ff4d6d") + "0a"; ctx.fillRect(PL, Math.min(eY, tY), cW, Math.abs(eY - tY));
      [[sig.entry, "ENTRY", gCol], [sig.sl, "SL", "#ff4d6d"], [sig.target, "TGT", "#00e5a0"]].forEach(([v, l, c]) => {
        const y = yP(v); ctx.strokeStyle = c + "99"; ctx.lineWidth = l === "ENTRY" ? 1.5 : 1;
        ctx.setLineDash(l === "ENTRY" ? [5, 3] : [3, 3]);
        ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL + cW, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = c; ctx.font = "bold 8px monospace"; ctx.textAlign = "right";
        ctx.fillText(l + " " + v.toFixed(2), PL - 4, y + 3);
      });
      ctx.fillStyle = gCol; ctx.font = "bold 9px monospace"; ctx.textAlign = "left";
      ctx.fillText("[" + sig.grade + "] " + (isL ? "▲ LONG" : "▼ SHORT"), PL + 4, PT + 13);
    }
    if (ltp != null) {
      const ltpY = yP(ltp), ltpC = bars.length > 0 && ltp >= bars.at(-1).o ? "#00e5a0" : "#ff4d6d";
      ctx.strokeStyle = ltpC + "88"; ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
      ctx.beginPath(); ctx.moveTo(PL, ltpY); ctx.lineTo(PL + cW, ltpY); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ltpC; ctx.fillRect(PL + cW + 2, ltpY - 8, 48, 16);
      ctx.fillStyle = "#04070d"; ctx.font = "bold 9px monospace"; ctx.textAlign = "center";
      ctx.fillText(ltp.toFixed(2), PL + cW + 26, ltpY + 3.5);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL, PT); ctx.lineTo(PL, PT + cH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PL, PT + cH); ctx.lineTo(PL + cW, PT + cH); ctx.stroke();
  }, [ltpHistory, bars, zones, ltp, signals, sym, height]);
  return <canvas ref={ref} style={{ width: "100%", height, display: "block", borderRadius: 6 }} />;
}

export function DeltaBar({ bars }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv || !bars.length) return;
    const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const mx = Math.max(...bars.map(b => Math.abs(b.delta)), 1);
    const bw = Math.max(W / bars.length - 1, 2), my = H / 2;
    bars.forEach((b, i) => {
      const bh = clamp(Math.abs(b.delta) / mx, 0, 1) * (H / 2 - 2), col = b.delta > 0 ? C.bull : C.bear;
      ctx.fillStyle = col + "55"; ctx.fillRect(i * bw, b.delta > 0 ? my - bh : my, bw - 1, bh);
    });
    ctx.strokeStyle = "rgba(255,255,255,0.1)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(W, my); ctx.stroke();
    if (bars.length) {
      const lb = bars.at(-1); ctx.fillStyle = lb.delta > 0 ? C.bull : C.bear;
      ctx.font = "8px monospace"; ctx.textAlign = "right"; ctx.fillText((lb.delta > 0 ? "+" : "") + Math.round(lb.delta), W - 2, H - 2);
    }
  }, [bars]);
  return <canvas ref={ref} width={500} height={26} style={{ width: "100%", display: "block" }} />;
}

export function GEXChart({ data, spot }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 55, r: 12, t: 16, b: 30 };
    const iW = W - pad.l - pad.r, iH = H - pad.t - pad.b;
    const maxG = Math.max(...data.map(d => Math.abs(d.gex))) * 1.1 || 1;
    const midY = pad.t + iH / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) { const y = pad.t + g * iH / 4; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + iW, y); ctx.stroke(); }
    ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pad.l, midY); ctx.lineTo(pad.l + iW, midY); ctx.stroke();
    const bW = iW / data.length - 2;
    data.forEach((row, i) => {
      const x = pad.l + i * (iW / data.length) + 1, bH = (row.gex / maxG) * (iH / 2), col = row.gex > 0 ? "#00e5a0" : "#ff4d6d";
      ctx.fillStyle = col + "88"; ctx.fillRect(x, bH < 0 ? midY : midY - bH, bW, Math.abs(bH));
      if (row.atm) { ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 2; ctx.strokeRect(x - 1, bH < 0 ? midY : midY - bH, bW + 2, Math.abs(bH)); }
      ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.font = "7px monospace"; ctx.textAlign = "center";
      ctx.fillText(row.strike, x + bW / 2, H - pad.b + 12);
    });
    [["+" + (maxG / 1e6).toFixed(1) + "M", pad.t + 2], ["0", midY + 4], ["-" + (maxG / 1e6).toFixed(1) + "M", pad.t + iH]].forEach(([l, y]) => {
      ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.font = "9px monospace"; ctx.textAlign = "right"; ctx.fillText(l, pad.l - 4, y);
    });
  }, [data]);
  return <canvas ref={ref} width={900} height={200} style={{ width: "100%", display: "block" }} />;
}