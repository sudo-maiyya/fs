import React from "react";
import { C } from "../../utils/constants";

export function PhaseBadge({ phase }) {
  const col = C.phase[phase] || C.neutral;
  const pulse = phase?.startsWith("SIGNAL") || phase === "PRIMED";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 99,
      border: `1px solid ${col}44`, background: `${col}10`, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", color: col,
      animation: pulse ? "phasePulse 1.4s ease-in-out infinite" : "none"
    }}>
      <span style={{ width: 4, height: 4, borderRadius: "50%", background: col }} />
      {phase || "WATCHING"}
    </span>
  );
}