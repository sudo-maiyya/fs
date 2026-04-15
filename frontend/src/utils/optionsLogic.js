export function norm_cdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1; x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export function norm_pdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

export function bs_price(S, K, T, r, sigma, type) {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === "CE" ? S - K : K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === "CE") return S * norm_cdf(d1) - K * Math.exp(-r * T) * norm_cdf(d2);
  return K * Math.exp(-r * T) * norm_cdf(-d2) - S * norm_cdf(-d1);
}

export function greeks(S, K, T, r, sigma, type) {
  if (T <= 0 || sigma <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const delta = type === "CE" ? norm_cdf(d1) : -norm_cdf(-d1);
  const gamma = norm_pdf(d1) / (S * sigma * Math.sqrt(T));
  const tCE = (-(S * norm_pdf(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * norm_cdf(d2)) / 365;
  const tPE = (-(S * norm_pdf(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * norm_cdf(-d2)) / 365;
  const vega = S * norm_pdf(d1) * Math.sqrt(T) / 100;
  return { delta, gamma, theta: type === "CE" ? tCE : tPE, vega };
}

export function formatLiveChain(rawChain, currentSpot) {
  if (!rawChain || !rawChain.length) return [];
  const strikesMap = {};
  rawChain.forEach(opt => {
    const strike = opt.strike_price;
    if (!strikesMap[strike]) strikesMap[strike] = { strike, atm: false, pcr: 0, gex: 0, ce: {}, pe: {} };
    const type = opt.option_type === "CE" ? "ce" : "pe";
    strikesMap[strike][type] = {
      price: opt.ltp || 0, oi: opt.open_interest || 1, oiChg: opt.chng_in_oi || opt.oichnge || 0,
      vol: opt.volume || 0, iv: opt.implied_volatility || 0.15
    };
  });
  const r = 0.065, T = 6 / 365;
  const rows = Object.values(strikesMap).map(row => {
    row.atm = Math.abs(row.strike - currentSpot) < 100;
    if (!row.ce.price) row.ce = { price: 0, oi: 1, oiChg: 0, vol: 0, iv: 0.15 };
    if (!row.pe.price) row.pe = { price: 0, oi: 1, oiChg: 0, vol: 0, iv: 0.15 };
    row.pcr = row.pe.oi / (row.ce.oi || 1);
    const ceG = greeks(currentSpot, row.strike, T, r, row.ce.iv, "CE");
    const peG = greeks(currentSpot, row.strike, T, r, row.pe.iv, "PE");
    row.ce = { ...row.ce, ...ceG };
    row.pe = { ...row.pe, ...peG };
    row.gex = (row.ce.gamma * row.ce.oi * 50 * currentSpot * currentSpot * 0.0001) -
              (row.pe.gamma * row.pe.oi * 50 * currentSpot * currentSpot * 0.0001);
    return row;
  });
  return rows.sort((a, b) => a.strike - b.strike);
}

export function generateChain(spot = 22480) {
  const base = Math.round(spot / 100) * 100;
  const strikes = [];
  for (let i = -8; i <= 8; i++) strikes.push(base + i * 100);
  const r = 0.065, T = 6 / 365, rows = [];
  for (const K of strikes) {
    const m = (K - spot) / spot;
    const bIV = 0.15 + Math.abs(m) * 0.8;
    const ceIV = bIV + (Math.random() - 0.5) * 0.02;
    const peIV = bIV + 0.02 + (Math.random() - 0.5) * 0.02;
    const ceP = bs_price(spot, K, T, r, ceIV, "CE");
    const peP = bs_price(spot, K, T, r, peIV, "PE");
    const ceOI = Math.round(500000 * Math.exp(-Math.abs(m) * 8) + Math.random() * 50000);
    const peOI = Math.round(500000 * Math.exp(-Math.abs(m) * 8) + Math.random() * 50000);
    const ceOIchg = Math.round((Math.random() - 0.4) * ceOI * 0.15);
    const peOIchg = Math.round((Math.random() - 0.4) * peOI * 0.15);
    const ceG = greeks(spot, K, T, r, ceIV, "CE");
    const peG = greeks(spot, K, T, r, peIV, "PE");
    const gex = ceG.gamma * ceOI * 50 * spot * spot * 0.0001 - peG.gamma * peOI * 50 * spot * spot * 0.0001;
    rows.push({
      strike: K, atm: Math.abs(K - spot) < 100, pcr: peOI / ceOI, gex,
      ce: { price: ceP, oi: ceOI, oiChg: ceOIchg, vol: Math.round(ceOI * 0.1 + Math.random() * 10000), iv: ceIV, ...ceG },
      pe: { price: peP, oi: peOI, oiChg: peOIchg, vol: Math.round(peOI * 0.1 + Math.random() * 10000), iv: peIV, ...peG },
    });
  }
  return rows;
}

export function getOptSignal(row, spot) {
  const { strike, ce, pe, pcr } = row;
  const ceBuildup = ce.oiChg > ce.oi * 0.05, peBuildup = pe.oiChg > pe.oi * 0.05;
  const ceUnwind = ce.oiChg < -ce.oi * 0.05, peUnwind = pe.oiChg < -pe.oi * 0.05;
  const drasticCE = Math.abs(ce.oiChg) > ce.oi * 0.1, drasticPE = Math.abs(pe.oiChg) > pe.oi * 0.1;
  let action = "HOLD", bias = "NEUTRAL", carry = "—", strength = 50, reason = "";
  if (strike > spot) {
    if (ceBuildup && peUnwind) { action = "SELL CE"; bias = "BEARISH"; carry = "WRITE CALL"; strength = 75; reason = "CE buildup = resistance wall"; }
    else if (ceUnwind) { action = "BUY CE"; bias = "BULLISH"; carry = "BUY CALL OVERNIGHT"; strength = 65; reason = "CE unwinding = short covering"; }
    else if (peBuildup) { action = "SELL PE"; bias = "BULLISH"; carry = "WRITE PUT"; strength = 60; reason = "PE buildup at OTM = support"; }
  } else if (strike < spot) {
    if (peBuildup && ceUnwind) { action = "SELL PE"; bias = "BULLISH"; carry = "WRITE PUT"; strength = 75; reason = "PE buildup = support wall"; }
    else if (peUnwind) { action = "BUY PE"; bias = "BEARISH"; carry = "BUY PUT OVERNIGHT"; strength = 65; reason = "PE unwinding = long covering"; }
    else if (ceBuildup) { action = "SELL CE"; bias = "BEARISH"; carry = "WRITE CALL"; strength = 60; reason = "CE buildup at OTM = resistance"; }
  } else {
    if (pcr > 1.3) { action = "BUY CE"; bias = "BULLISH"; carry = "BUY ATM CALL"; strength = 70; reason = "High PCR = bullish"; }
    else if (pcr < 0.7) { action = "BUY PE"; bias = "BEARISH"; carry = "BUY ATM PUT"; strength = 70; reason = "Low PCR = bearish"; }
    else { action = "SELL STRADDLE"; bias = "NEUTRAL"; carry = "SELL STRADDLE"; strength = 55; reason = "Balanced PCR = range-bound"; }
  }
  return { action, bias, carry, strength, reason, drasticCE, drasticPE, drastic: drasticCE || drasticPE };
}