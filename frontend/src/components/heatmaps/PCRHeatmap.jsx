import React, { useRef, useEffect } from "react";

export function PCRHeatmap({ data }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const cW = W / data.length, cH = H / 3;
    data.forEach((row, i) => {
      [[row.ce.oi, 800000, "200"], [row.pcr * 100000, 200000, row.pcr > 1 ? "120" : "0"], [row.pe.oi, 800000, "120"]].forEach(([v, mx, h], j) => {
        const pct = Math.min(v / mx, 1), l = Math.round(20 + pct * 50);
        ctx.fillStyle = `hsl(${h},70%,${l}%)`; ctx.fillRect(i * cW, j * cH, cW - 1, cH - 1);
        if (row.atm) { ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 2; ctx.strokeRect(i * cW, j * cH, cW - 1, cH - 1); }
      });
      ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center";
      ctx.fillText(row.strike, i * cW + cW / 2, H - 3);
    });
    ctx.strokeStyle = "#ffd16655"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    for (let j = 1; j < 3; j++) { ctx.beginPath(); ctx.moveTo(0, j * cH); ctx.lineTo(W, j * cH); ctx.stroke(); }
    ctx.setLineDash([]);
    ["CE OI", "PCR", "PE OI"].forEach((l, j) => {
      ctx.fillStyle = "rgba(255,255,255,0.5)"; ctx.font = "9px monospace"; ctx.textAlign = "left";
      ctx.fillText(l, 3, j * cH + cH / 2 + 4);
    });
  }, [data]);
  return <canvas ref={ref} width={900} height={180} style={{ width: "100%", display: "block" }} />;
}