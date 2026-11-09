// 0DTE premium gauge: did SPX 0DTE options price in more or less movement than SPX actually made?
// Each trading day: the 10:00 ET at-the-money SPXW 0DTE straddle (mid) vs |16:00 close − strike|.
// Read-only reporting; pure functions here, Schwab capture in gaugeCapture.ts.

export interface GaugeWing {
  /** Same-day put whose Black-Scholes delta (from its own mid-implied vol) is closest to −0.10. */
  strike: number;
  mid: number;
  iv: number;
  delta: number;
  /** max(strike − s16, 0) once the day has closed (spec: payout of the 10-delta put wing). */
  payout?: number;
}

export interface GaugeRow {
  date: string;
  s10: number | null;
  K: number | null;
  call_mid: number | null;
  put_mid: number | null;
  straddle: number | null;
  s16: number | null;
  move: number | null;
  ratio: number | null;
  edge: number | null;
  straddle_pct: number | null;
  /** open: 10:00 snapshot taken, waiting for the close; closed: complete; skipped / error: see reason. */
  status: "open" | "closed" | "skipped" | "error";
  reason?: string;
  captured_at: number;
  closed_at?: number;
  wing?: GaugeWing | null;
}

/** Reference lines from the 2022–2026 history (20-day and 60-day rolling means of the ratio). */
export const REFERENCE = {
  d20: { p5: 0.75, median: 0.97, p95: 1.26, p99: 1.36 },
  d60: { p5: 0.86, median: 0.98, p95: 1.1, p99: 1.13 },
  /** 75th percentile of the 60-day mean: the green/amber boundary. */
  d60p75: 1.04,
} as const;

/** 10-delta put wing, rolling 60-day "premium kept", May 2022 – Nov 2026. Context only. */
export const WING_BANDS = { p5: -1.09, p25: -0.23, median: 0.24, p75: 0.62, p95: 0.89, belowZero: 0.34 } as const;

/** Monthly mean of the ratio, May 2022 – Oct 2026 (10:00 ATM SPXW 0DTE straddle mid vs |16:00 close − K|). */
export const SEED_MONTHLY: Record<string, number> = Object.fromEntries(
  (
    [
      [2022, { 5: 0.852, 6: 1.061, 7: 1.112, 8: 0.862, 9: 0.931, 10: 0.869, 11: 0.965, 12: 0.977 }],
      [2023, { 1: 1.323, 2: 0.887, 3: 1.008, 4: 1.115, 5: 0.905, 6: 1.042, 7: 0.983, 8: 1.254, 9: 0.869, 10: 0.992, 11: 0.826, 12: 1.121 }],
      [2024, { 1: 0.891, 2: 0.782, 3: 0.967, 4: 1.311, 5: 0.911, 6: 0.991, 7: 1.152, 8: 1.029, 9: 0.871, 10: 0.966, 11: 0.879, 12: 1.23 }],
      [2025, { 1: 0.921, 2: 1.183, 3: 0.783, 4: 1.135, 5: 0.732, 6: 0.843, 7: 1.01, 8: 0.986, 9: 0.803, 10: 1.278, 11: 1.233, 12: 0.873 }],
      [2026, { 1: 0.623, 2: 0.981, 3: 1.018, 4: 1.02, 5: 0.879, 6: 1.175, 7: 0.812, 8: 0.873, 9: 0.973, 10: 0.888 }],
    ] as [number, Record<number, number>][]
  ).flatMap(([y, ms]) => Object.entries(ms).map(([m, v]) => [`${y}-${String(m).padStart(2, "0")}`, v])),
);

/** Month-end 60-day mean readings carried over from the history (the last is Nov 6, 2026). */
export const SEED_60D: { date: string; value: number }[] = [
  { date: "2026-07-31", value: 0.947 },
  { date: "2026-08-31", value: 0.949 },
  { date: "2026-09-30", value: 0.879 },
  { date: "2026-10-30", value: 0.851 },
  { date: "2026-11-06", value: 0.927 },
];

export const TOOLTIP =
  "Below 1.0 means options priced in more movement than SPX actually made, so premium sellers were paid. A 60-day mean persistently above 1.10 has never happened since daily expirations began in 2022, and would suggest 0DTE premium has become too cheap.";

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** Strike nearest the price, on SPX's 5-point grid. */
export const atmStrike = (s: number) => Math.round(s / 5) * 5;

/** Fill in the close: move, ratio, edge (idempotent: the same s16 gives the same row). */
export function closeRow(row: GaugeRow, s16: number, at = Date.now()): GaugeRow {
  if (row.status !== "open" && row.status !== "closed") return row;
  if (row.K === null || row.straddle === null || !(row.straddle > 0)) return row;
  const move = Math.abs(s16 - row.K);
  const wing = row.wing ? { ...row.wing, payout: round(Math.max(row.wing.strike - s16, 0), 2) } : row.wing;
  return {
    ...row,
    s16,
    move: round(move, 2),
    ratio: round(move / row.straddle),
    edge: round((row.straddle - move) / row.straddle),
    status: "closed",
    closed_at: at,
    wing,
  };
}

const valid = (rows: GaugeRow[]) => rows.filter((r) => r.status === "closed" && r.ratio !== null).sort((a, b) => a.date.localeCompare(b.date));

/** Mean ratio over the last `window` valid days, once at least `min` valid days exist (else null). */
export function rollingMean(rows: GaugeRow[], window: number, min: number): { mean: number; days: number } | null {
  const v = valid(rows);
  if (v.length < min) return null;
  const last = v.slice(-window);
  return { mean: round(last.reduce((s, r) => s + r.ratio!, 0) / last.length), days: last.length };
}

/** The 60-day mean as of each valid day that has at least 40 valid days behind it. */
export function series60(rows: GaugeRow[]): { date: string; value: number }[] {
  const v = valid(rows);
  const out: { date: string; value: number }[] = [];
  for (let i = 39; i < v.length; i++) {
    const w = v.slice(Math.max(0, i - 59), i + 1);
    out.push({ date: v[i].date, value: round(w.reduce((s, r) => s + r.ratio!, 0) / w.length) });
  }
  return out;
}

/** Month means of the ratio: the seed history, overridden by live captures for months that have any. */
export function monthlyMeans(rows: GaugeRow[]): Record<string, { mean: number; days: number | null }> {
  const out: Record<string, { mean: number; days: number | null }> = Object.fromEntries(
    Object.entries(SEED_MONTHLY).map(([m, v]) => [m, { mean: v, days: null }]),
  );
  const by = new Map<string, number[]>();
  for (const r of valid(rows)) by.set(r.date.slice(0, 7), [...(by.get(r.date.slice(0, 7)) ?? []), r.ratio!]);
  for (const [m, xs] of by) out[m] = { mean: round(xs.reduce((s, x) => s + x, 0) / xs.length), days: xs.length };
  return out;
}

export type Chip = "green" | "amber" | "red";

/**
 * Status of the 60-day mean: green below 1.04 (its 75th percentile), amber 1.04–1.10, red above 1.10,
 * and red when every month-end 60-day reading of the last 3 months is above 1.0.
 */
export function chipFor(mean60: number, monthEnds: { date: string; value: number }[]): Chip {
  const last3 = monthEnds.slice(-3);
  if (mean60 > REFERENCE.d60.p95 || (last3.length === 3 && last3.every((m) => m.value > 1))) return "red";
  if (mean60 >= REFERENCE.d60p75) return "amber";
  return "green";
}

/** The last reading of each month from a dated series. */
export function monthEndReadings(points: { date: string; value: number }[]): { date: string; value: number }[] {
  const byMonth = new Map<string, { date: string; value: number }>();
  for (const p of [...points].sort((a, b) => a.date.localeCompare(b.date))) byMonth.set(p.date.slice(0, 7), p);
  return [...byMonth.values()];
}

/** 10-delta put wing over the last 60 valid days: 1 − Σ payout ÷ Σ premium (null without data). */
export function wingKept60(rows: GaugeRow[]): { kept: number; days: number } | null {
  const w = valid(rows)
    .filter((r) => r.wing && typeof r.wing.payout === "number" && r.wing.mid > 0)
    .slice(-60);
  if (!w.length) return null;
  const prem = w.reduce((s, r) => s + r.wing!.mid, 0);
  const paid = w.reduce((s, r) => s + r.wing!.payout!, 0);
  return { kept: round(1 - paid / prem), days: w.length };
}

// ---- Black-Scholes (r = 0) for the 10-delta wing ----

const normCdf = (x: number) => {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
};

export function bsPut(s: number, k: number, t: number, vol: number): number {
  if (t <= 0 || vol <= 0) return Math.max(k - s, 0);
  const sd = vol * Math.sqrt(t);
  const d1 = (Math.log(s / k) + 0.5 * vol * vol * t) / sd;
  return k * normCdf(-(d1 - sd)) - s * normCdf(-d1);
}

export function putDelta(s: number, k: number, t: number, vol: number): number {
  const d1 = (Math.log(s / k) + 0.5 * vol * vol * t) / (vol * Math.sqrt(t));
  return normCdf(d1) - 1;
}

/** Implied vol of a put from its price (bisection); null when the price is outside what any vol gives. */
export function impliedVolPut(price: number, s: number, k: number, t: number): number | null {
  const intrinsic = Math.max(k - s, 0);
  if (!(price > intrinsic) || t <= 0) return null;
  let lo = 0.001;
  let hi = 10;
  if (bsPut(s, k, t, hi) < price) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (bsPut(s, k, t, mid) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** From same-day puts (strike, mid), the one whose delta is closest to −0.10. `t` in years. */
export function tenDeltaPut(puts: { strike: number; mid: number }[], s: number, t: number): GaugeWing | null {
  let best: GaugeWing | null = null;
  for (const p of puts) {
    if (!(p.mid > 0) || p.strike >= s) continue;
    const iv = impliedVolPut(p.mid, s, p.strike, t);
    if (iv === null) continue;
    const delta = putDelta(s, p.strike, t, iv);
    if (!best || Math.abs(delta + 0.1) < Math.abs(best.delta + 0.1)) best = { strike: p.strike, mid: round(p.mid, 2), iv: round(iv), delta: round(delta) };
  }
  return best;
}
