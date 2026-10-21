// Option symbols, expiry payoffs and the "best SPX close" analysis.

export type PutCall = "C" | "P";

export interface OptionLeg {
  symbol: string;
  underlying: string; // e.g. "SPX"
  root: string; // e.g. "SPXW"
  expiration: string; // YYYY-MM-DD
  putCall: PutCall;
  strike: number;
  /** Signed contracts: + long, − short. */
  qty: number;
  /** Average open price per share (e.g. 4.84). */
  avgPrice: number;
}

export const MULTIPLIER = 100;

/** Parse an OCC/Schwab option symbol, e.g. "SPXW  261020P07720000". */
export function parseOptionSymbol(symbol: string): { root: string; expiration: string; putCall: PutCall; strike: number } | null {
  const m = /^([A-Z0-9.$]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol.trim());
  if (!m) return null;
  const [, root, yy, mm, dd, pc, strike] = m;
  return {
    root,
    expiration: `20${yy}-${mm}-${dd}`,
    putCall: pc as PutCall,
    strike: Number(strike) / 1000,
  };
}

/** Map an option root to its underlying ("SPXW" -> "SPX"). */
export function rootToUnderlying(root: string): string {
  const r = root.replace(/^\$/, "");
  if (r === "SPXW" || r === "SPX") return "SPX";
  if (r === "NDXP" || r === "NDX") return "NDX";
  if (r === "RUTW" || r === "RUT") return "RUT";
  if (r === "XSP") return "XSP";
  return r.replace(/\d+$/, "");
}

export function intrinsic(putCall: PutCall, strike: number, s: number): number {
  return putCall === "C" ? Math.max(s - strike, 0) : Math.max(strike - s, 0);
}

/** Net cost of the legs in dollars (positive = debit paid, negative = credit received). */
export function netCost(legs: OptionLeg[]): number {
  return legs.reduce((sum, l) => sum + l.qty * l.avgPrice * MULTIPLIER, 0);
}

/** Total P/L at expiration if the underlying settles at `s` (cash-settled). */
export function expiryPnl(legs: OptionLeg[], s: number, extraCost = 0): number {
  let value = 0;
  for (const l of legs) value += l.qty * intrinsic(l.putCall, l.strike, s) * MULTIPLIER;
  return round2(value - netCost(legs) - extraCost);
}

export interface CurvePoint {
  price: number;
  pnl: number;
}

export function payoffCurve(legs: OptionLeg[], lo: number, hi: number, step = 1, extraCost = 0): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (let p = lo; p <= hi + 1e-9; p += step) out.push({ price: round2(p), pnl: expiryPnl(legs, p, extraCost) });
  return out;
}

/** Zero crossings of a curve (linear interpolation between grid points). */
export function breakevens(curve: CurvePoint[]): number[] {
  const out: number[] = [];
  let i = 1;
  while (i < curve.length) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a.pnl !== 0 && b.pnl !== 0 && Math.sign(a.pnl) !== Math.sign(b.pnl)) {
      out.push(round2(a.price + (-a.pnl * (b.price - a.price)) / (b.pnl - a.pnl)));
    } else if (a.pnl !== 0 && b.pnl === 0) {
      // Lands exactly on zero: a crossing only if the sign flips after the zero run.
      let j = i;
      while (j < curve.length && curve[j].pnl === 0) j++;
      if (j < curve.length && Math.sign(curve[j].pnl) !== Math.sign(a.pnl)) out.push(b.price);
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

export interface PriceRange {
  low: number;
  high: number;
}

export interface CloseAnalysis {
  spot: number;
  lo: number;
  hi: number;
  netCost: number;
  /** atEdge: the max sits at the edge of the range (P/L keeps rising beyond it, e.g. naked long calls). */
  best: { price: number; range: PriceRange | null; pnl: number; atEdge: boolean };
  /** Flat P/L run that contains the current price, if any (e.g. between an iron condor's shorts). */
  spotZone: { range: PriceRange; pnl: number } | null;
  worst: { price: number; range: PriceRange | null; pnl: number; atEdge: boolean };
  /** Breakevens bracketing the best close; null if beyond the analysed range. */
  profitZone: { lower: number | null; upper: number | null } | null;
  breakevens: number[];
  pnlAtSpot: number;
  curve: CurvePoint[];
  table: (CurvePoint & { isCurrent: boolean; isBest: boolean })[];
}

/** Contiguous run of points within `tol` of `target` around index `i`. */
function flatRange(curve: CurvePoint[], i: number, target: number, tol = 0.5): PriceRange | null {
  let a = i;
  let b = i;
  while (a > 0 && Math.abs(curve[a - 1].pnl - target) <= tol) a--;
  while (b < curve.length - 1 && Math.abs(curve[b + 1].pnl - target) <= tol) b++;
  return a === b ? null : { low: curve[a].price, high: curve[b].price };
}

/**
 * Analyse P/L at expiration over spot ±pct (1-point steps), plus a ±tableHalfWidth
 * table in tableStep increments around the current price.
 */
export function analyzeClose(
  legs: OptionLeg[],
  spot: number,
  opts: { pct?: number; step?: number; tableStep?: number; tableHalfWidth?: number; extraCost?: number } = {},
): CloseAnalysis | null {
  if (!legs.length || !(spot > 0)) return null;
  const { pct = 0.03, step = 1, tableStep = 5, tableHalfWidth = 50, extraCost = 0 } = opts;
  const lo = Math.ceil(spot * (1 - pct));
  const hi = Math.floor(spot * (1 + pct));
  const curve = payoffCurve(legs, lo, hi, step, extraCost);

  let bi = 0;
  let wi = 0;
  curve.forEach((p, i) => {
    if (p.pnl > curve[bi].pnl) bi = i;
    if (p.pnl < curve[wi].pnl) wi = i;
  });
  const best = curve[bi];
  const bestRange = flatRange(curve, bi, best.pnl);
  const worst = curve[wi];
  const worstRange = flatRange(curve, wi, worst.pnl);

  const bes = breakevens(curve);
  let profitZone: CloseAnalysis["profitZone"] = null;
  if (best.pnl > 0) {
    const ref = bestRange ? bestRange.low : best.price;
    const lower = [...bes].reverse().find((b) => b <= ref) ?? null;
    const upper = bes.find((b) => b >= (bestRange ? bestRange.high : best.price)) ?? null;
    profitZone = { lower, upper };
  }

  const center = Math.round(spot / tableStep) * tableStep;
  const rows: CurvePoint[] = [];
  for (let p = center + tableHalfWidth; p >= center - tableHalfWidth; p -= tableStep) {
    rows.push({ price: p, pnl: expiryPnl(legs, p, extraCost) });
  }
  const tableBest = rows.reduce((m, r) => (r.pnl > m ? r.pnl : m), -Infinity);
  const tableFlat = rows.every((r) => r.pnl === rows[0].pnl);
  const touchesEdge = (i: number, r: PriceRange | null) =>
    i === 0 || i === curve.length - 1 || (r !== null && (r.low === lo || r.high === hi));
  const si = Math.min(curve.length - 1, Math.max(0, Math.round((spot - lo) / step)));
  const spotRange = flatRange(curve, si, curve[si].pnl);

  return {
    spot,
    lo,
    hi,
    netCost: round2(netCost(legs) + extraCost),
    best: { price: best.price, range: bestRange, pnl: best.pnl, atEdge: touchesEdge(bi, bestRange) },
    spotZone: spotRange ? { range: spotRange, pnl: curve[si].pnl } : null,
    worst: {
      price: worst.price,
      range: worstRange,
      pnl: worst.pnl,
      atEdge: touchesEdge(wi, worstRange),
    },
    profitZone,
    breakevens: bes,
    pnlAtSpot: expiryPnl(legs, spot, extraCost),
    curve,
    table: rows.map((r) => ({ ...r, isCurrent: r.price === center, isBest: !tableFlat && r.pnl === tableBest })),
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
