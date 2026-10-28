// Allocation simulator: re-size OO backtest trades from per-strategy allocation % and compounding equity.
import { parseLegs, tradeSlot, type OOTrade } from "./ooCsv";
import { canonicalStrategy } from "./scorecard";

export interface StrategyAlloc {
  /** % of current equity committed to each new trade (sized on risk per contract, like OO). */
  pct: number;
  /** Optional cap on contracts per trade (e.g. 1 for an add-on); 0/undefined = no cap. */
  maxContracts?: number;
}

/** Schwab Port 2026 allocations in Option Omega (as of Oct 28, 2026), keyed by the scorecard's short names. */
export const PORTFOLIO_ALLOC: Record<string, StrategyAlloc> = {
  Long: { pct: 7.2 },
  Short: { pct: 3.4 },
  "8SMA IC": { pct: 5.4 },
  FOMC: { pct: 0.5 },
  "$8 IC": { pct: 0.9 },
  "$8 IC Dip": { pct: 100, maxContracts: 1 },
  "5d IC": { pct: 3 },
  BWB: { pct: 0.5 },
  "VIX>30 1DTE": { pct: 1 },
  "VIX-up PS": { pct: 1 },
  "2DTE": { pct: 3 },
};

/** The portfolio's setting for an OO strategy name, if it's one of the book's strategies. */
export function portfolioAlloc(name: string): StrategyAlloc | undefined {
  const key = /dip\s*add/i.test(name) ? "$8 IC Dip" : canonicalStrategy(name);
  return PORTFOLIO_ALLOC[key];
}

export interface SimTrade {
  strategy: string;
  open: string; // "YYYY-MM-DD HH:MM:SS"
  close: string;
  closeDate: string;
  plPerLot: number;
  riskPerLot: number;
  premiumPerLot: number;
}

const MULT = 100;

/** Worst P/L at expiration for one contract of the structure (legs + net premium), ≥ 0 as a cost. */
export function maxLossPerLot(t: Pick<OOTrade, "legs" | "dateOpened" | "contracts" | "premium">): { risk: number; premium: number } {
  const n = Math.max(1, t.contracts || 1);
  const legs = parseLegs(t.legs, t.dateOpened).map((l) => ({ ...l, q: l.qty / n }));
  const premium = legs.length ? legs.reduce((s, l) => s - l.q * l.price, 0) * MULT : (t.premium ?? 0);
  if (!legs.length) return { risk: Math.max(0, -premium), premium };
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const probes = [0, ...strikes, strikes[strikes.length - 1] * 3];
  let worst = Infinity;
  for (const s of probes) {
    const payoff = legs.reduce((acc, l) => acc + l.q * (l.putCall === "P" ? Math.max(l.strike - s, 0) : Math.max(s - l.strike, 0)), 0) * MULT;
    worst = Math.min(worst, payoff + premium);
  }
  // A naked side (no hedge beyond the last strike) is unbounded; fall back to the margin OO reported.
  return { risk: Math.max(0, -worst), premium };
}

/** One trade per entry slot (different OO runs of the same entry are the same trade): newest upload first, then rows with margin. */
export function uniqueEntries(trades: OOTrade[]): OOTrade[] {
  // Rows stored before uploads were tagged are leftovers of older runs once a strategy has a tagged upload.
  const tagged = new Set(trades.filter((t) => t.source).map((t) => t.strategy.trim()));
  trades = trades.filter((t) => t.source || !tagged.has(t.strategy.trim()));
  const by = new Map<string, OOTrade>();
  const rank = (t: OOTrade) => [t.uploadedAt ?? 0, typeof t.margin === "number" ? 1 : 0];
  for (const t of trades) {
    const k = tradeSlot(t);
    const cur = by.get(k);
    if (!cur) by.set(k, t);
    else {
      const [a, b] = [rank(t), rank(cur)];
      // Ties broken by key so the choice doesn't depend on storage order.
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && t.key > cur.key)))) by.set(k, t);
    }
  }
  return [...by.values()];
}

export function toSimTrades(trades: OOTrade[]): SimTrade[] {
  const out: SimTrade[] = [];
  for (const t of uniqueEntries(trades)) {
    const n = Math.max(1, t.contracts || 1);
    const { risk, premium } = maxLossPerLot(t);
    const marginPerLot = typeof t.margin === "number" && t.margin > 0 ? t.margin / n : 0;
    const riskPerLot = marginPerLot || risk;
    if (!(riskPerLot > 0)) continue;
    const closeDate = t.dateClosed ?? t.dateOpened;
    out.push({
      strategy: t.strategy.trim(),
      open: `${t.dateOpened} ${t.timeOpened}`,
      close: `${closeDate} ${t.timeClosed ?? "16:00:00"}`,
      closeDate,
      plPerLot: t.pl / n,
      riskPerLot,
      // OO's net premium per contract (+ credit, − debit) when the log has it.
      premiumPerLot: t.premium ?? premium,
    });
  }
  return out.sort((a, b) => a.open.localeCompare(b.open) || a.strategy.localeCompare(b.strategy));
}

/**
 * The sizing OO used, per strategy: a contract cap when many trades sit at the same maximum, and the
 * allocation from (contracts × risk) / funds at entry over the trades below that cap. OO rounds contracts
 * down, so that ratio sits just under the setting: take its 90th percentile.
 */
export function impliedAllocations(trades: OOTrade[]): Record<string, StrategyAlloc> {
  const by = new Map<string, { ratios: number[]; contracts: number[] }>();
  // Sizing differs between OO runs: read it from one run per strategy (the upload with the most of its rows).
  const counts = new Map<string, Map<string, number>>();
  for (const t of trades) {
    const m = counts.get(t.strategy.trim()) ?? new Map<string, number>();
    m.set(t.source ?? "", (m.get(t.source ?? "") ?? 0) + 1);
    counts.set(t.strategy.trim(), m);
  }
  const mainSource = new Map([...counts].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  trades = trades.filter((t) => (t.source ?? "") === mainSource.get(t.strategy.trim()));
  // When a strategy's log carries Margin Req., trust only those rows (older uploads without it may be stale runs).
  const withMargin = new Set(trades.filter((t) => typeof t.margin === "number" && t.margin > 0).map((t) => t.strategy.trim()));
  for (const t of uniqueEntries(trades)) {
    const name = t.strategy.trim();
    if (withMargin.has(name) && !(typeof t.margin === "number" && t.margin > 0)) continue;
    if (t.fundsAtClose === null || !t.contracts) continue;
    const [sim] = toSimTrades([t]);
    const fundsAtOpen = t.fundsAtClose - t.pl;
    if (!sim || fundsAtOpen <= 0) continue;
    const v = by.get(name) ?? { ratios: [], contracts: [] };
    v.ratios.push((t.contracts * sim.riskPerLot) / fundsAtOpen);
    v.contracts.push(t.contracts);
    by.set(name, v);
  }
  const out: Record<string, StrategyAlloc> = {};
  const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))];
  for (const [s, v] of by) {
    if (v.contracts.every((c) => c === 1)) {
      out[s] = { pct: 100, maxContracts: 1 };
      continue;
    }
    const top = Math.max(...v.contracts);
    const capped = v.contracts.filter((c) => c === top).length >= Math.max(3, v.contracts.length * 0.3);
    const below = v.ratios.filter((_, i) => v.contracts[i] < top);
    const r = capped ? (below.length ? p90(below) : Math.max(...v.ratios)) : p90(v.ratios);
    out[s] = { pct: Math.round(r * 10_000) / 100, ...(capped ? { maxContracts: top } : {}) };
  }
  return out;
}

export interface StrategyResult {
  strategy: string;
  trades: number;
  tradeShare: number;
  pl: number;
  contribution: number;
  winPct: number;
  profitFactor: number | null;
  riskReward: number | null;
  maxDd: number;
  maxDdPct: number;
  avgContracts: number;
}

export interface MonthRow {
  month: string; // YYYY-MM
  pl: number;
  pct: number;
}

export interface SimResult {
  start: number;
  end: number;
  pl: number;
  trades: number;
  winPct: number;
  profitFactor: number | null;
  riskReward: number | null;
  maxDd: number;
  maxDdPct: number;
  avgDaysToRecover: number | null;
  cagr: number | null;
  mar: number | null;
  sharpe: number | null;
  sortino: number | null;
  captureRate: number | null;
  peak: number;
  avgMarginUtil: number;
  maxMarginUtil: number;
  firstDate: string | null;
  lastDate: string | null;
  strategies: StrategyResult[];
  months: MonthRow[];
  equity: { date: string; equity: number; dd: number }[];
}

interface Sized extends SimTrade {
  contracts: number;
  pl: number;
  margin: number;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

export function simulate(trades: SimTrade[], alloc: Record<string, StrategyAlloc>, startEquity: number): SimResult {
  // 1) Size each trade in time order; equity grows as earlier trades close (realized P/L only).
  const sized: Sized[] = [];
  const pending: Sized[] = []; // open, not yet credited
  let realized = startEquity;
  const settle = (until: string) => {
    pending.sort((a, b) => a.close.localeCompare(b.close));
    while (pending.length && pending[0].close <= until) realized += pending.shift()!.pl;
  };
  for (const t of trades) {
    const a = alloc[t.strategy];
    if (!a || !(a.pct > 0)) continue;
    settle(t.open);
    let n = Math.floor(((a.pct / 100) * Math.max(realized, 0)) / t.riskPerLot);
    if (a.maxContracts && a.maxContracts > 0) n = Math.min(n, a.maxContracts);
    if (n <= 0) continue;
    const s: Sized = { ...t, contracts: n, pl: t.plPerLot * n, margin: t.riskPerLot * n };
    sized.push(s);
    pending.push(s);
  }

  // 2) Daily realized equity and drawdowns.
  const byDay = new Map<string, number>();
  for (const s of sized) byDay.set(s.closeDate, (byDay.get(s.closeDate) ?? 0) + s.pl);
  const days = [...byDay.keys()].sort();
  const equity: SimResult["equity"] = [];
  let eq = startEquity;
  let peak = startEquity;
  let peakDate = days[0] ?? "";
  let maxDd = 0;
  let maxDdPct = 0;
  const recoveries: number[] = [];
  let inDd = false;
  const rets: number[] = [];
  for (const d of days) {
    const prev = eq;
    eq += byDay.get(d)!;
    rets.push(prev > 0 ? (eq - prev) / prev : 0);
    if (eq >= peak) {
      if (inDd) recoveries.push(dayDiff(peakDate, d));
      inDd = false;
      peak = eq;
      peakDate = d;
    } else inDd = true;
    const dd = eq - peak;
    if (dd < maxDd) maxDd = dd;
    if (peak > 0 && dd / peak < maxDdPct) maxDdPct = dd / peak;
    equity.push({ date: d, equity: eq, dd: peak > 0 ? dd / peak : 0 });
  }

  // 3) Trade stats.
  const wins = sized.filter((s) => s.pl > 0);
  const losses = sized.filter((s) => s.pl < 0);
  const gw = wins.reduce((s, t) => s + t.pl, 0);
  const gl = -losses.reduce((s, t) => s + t.pl, 0);
  const pl = eq - startEquity;
  const firstDate = sized.length ? sized[0].open.slice(0, 10) : null;
  const lastDate = days.length ? days[days.length - 1] : null;
  const years = firstDate && lastDate ? Math.max(dayDiff(firstDate, lastDate), 1) / 365.25 : 0;
  const cagr = years > 0 && eq > 0 ? Math.pow(eq / startEquity, 1 / years) - 1 : null;
  // Daily returns over trading days in the range (no-trade days count as 0).
  const all: number[] = [];
  if (firstDate && lastDate) {
    const map = new Map(days.map((d, i) => [d, rets[i]]));
    for (let d = firstDate; d <= lastDate; d = nextDay(d)) {
      const dow = new Date(d + "T12:00:00Z").getUTCDay();
      if (dow !== 0 && dow !== 6) all.push(map.get(d) ?? 0);
    }
  }
  const mean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
  const sd = all.length > 1 ? Math.sqrt(all.reduce((a, r) => a + (r - mean) ** 2, 0) / (all.length - 1)) : 0;
  const down = all.length ? Math.sqrt(all.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / all.length) : 0;
  // OO's premium capture: P/L over net premium (credits − debits).
  const premium = sized.reduce((s, t) => s + t.premiumPerLot * t.contracts, 0);

  // 4) Margin in use: peak concurrent margin each day vs that morning's realized equity.
  const events: { at: string; d: number }[] = [];
  for (const s of sized) events.push({ at: s.open, d: s.margin }, { at: s.close, d: -s.margin });
  events.sort((a, b) => a.at.localeCompare(b.at) || a.d - b.d);
  const dayPeak = new Map<string, number>();
  let inUse = 0;
  for (const e of events) {
    inUse += e.d;
    const day = e.at.slice(0, 10);
    if (e.d > 0) dayPeak.set(day, Math.max(dayPeak.get(day) ?? 0, inUse));
  }
  const eqBefore = new Map<string, number>();
  {
    let e2 = startEquity;
    const allDays = [...new Set([...days, ...dayPeak.keys()])].sort();
    for (const d of allDays) {
      eqBefore.set(d, e2);
      e2 += byDay.get(d) ?? 0;
    }
  }
  const utils = [...dayPeak].map(([d, m]) => m / Math.max(eqBefore.get(d) ?? startEquity, 1));
  const avgMarginUtil = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : 0;

  // 5) Per strategy.
  const names = [...new Set(sized.map((s) => s.strategy))].sort();
  const strategies: StrategyResult[] = names.map((name) => {
    const ts = sized.filter((s) => s.strategy === name);
    const w = ts.filter((s) => s.pl > 0);
    const l = ts.filter((s) => s.pl < 0);
    const sw = w.reduce((s, t) => s + t.pl, 0);
    const sl = -l.reduce((s, t) => s + t.pl, 0);
    const p = ts.reduce((s, t) => s + t.pl, 0);
    // Strategy's own realized curve; % is of account equity at the strategy's peak.
    const daily = new Map<string, number>();
    for (const t of ts) daily.set(t.closeDate, (daily.get(t.closeDate) ?? 0) + t.pl);
    let cum = 0;
    let pk = 0;
    let dd = 0;
    let ddPct = 0;
    let pkEq = startEquity;
    const acct = new Map(equity.map((e) => [e.date, e.equity]));
    for (const d of [...daily.keys()].sort()) {
      cum += daily.get(d)!;
      if (cum >= pk) {
        pk = cum;
        pkEq = acct.get(d) ?? pkEq;
      }
      if (cum - pk < dd) dd = cum - pk;
      if ((cum - pk) / pkEq < ddPct) ddPct = (cum - pk) / pkEq;
    }
    return {
      strategy: name,
      trades: ts.length,
      tradeShare: sized.length ? ts.length / sized.length : 0,
      pl: p,
      contribution: pl !== 0 ? p / pl : 0,
      winPct: ts.length ? w.length / ts.length : 0,
      profitFactor: sl > 0 ? sw / sl : null,
      riskReward: w.length && l.length ? sw / w.length / (sl / l.length) : null,
      maxDd: dd,
      maxDdPct: ddPct,
      avgContracts: ts.length ? ts.reduce((s, t) => s + t.contracts, 0) / ts.length : 0,
    };
  });

  // 6) Months.
  const monthPl = new Map<string, number>();
  for (const d of days) monthPl.set(d.slice(0, 7), (monthPl.get(d.slice(0, 7)) ?? 0) + byDay.get(d)!);
  const months: MonthRow[] = [];
  let mEq = startEquity;
  for (const m of [...monthPl.keys()].sort()) {
    const v = monthPl.get(m)!;
    months.push({ month: m, pl: v, pct: mEq > 0 ? v / mEq : 0 });
    mEq += v;
  }

  return {
    start: startEquity,
    end: eq,
    pl,
    trades: sized.length,
    winPct: sized.length ? wins.length / sized.length : 0,
    profitFactor: gl > 0 ? gw / gl : null,
    riskReward: wins.length && losses.length ? gw / wins.length / (gl / losses.length) : null,
    maxDd,
    maxDdPct,
    avgDaysToRecover: recoveries.length ? recoveries.reduce((a, b) => a + b, 0) / recoveries.length : null,
    cagr,
    mar: cagr !== null && maxDdPct < 0 ? cagr / -maxDdPct : null,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : null,
    sortino: down > 0 ? (mean / down) * Math.sqrt(252) : null,
    captureRate: premium > 0 ? pl / premium : null,
    peak,
    avgMarginUtil,
    maxMarginUtil: utils.length ? Math.max(...utils) : 0,
    firstDate,
    lastDate,
    strategies,
    months,
    equity,
  };
}

function nextDay(d: string): string {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

export type Objective = "pl" | "cagr" | "mar" | "sharpe" | "sortino" | "dd";

export interface OptimizeOptions {
  objective: Objective;
  /** Strategies the search may change; the rest keep their allocation. */
  include: string[];
  /** Limits as fractions (0.25 = 25%); null = no limit. */
  maxAvgMargin: number | null;
  maxPeakMargin: number | null;
  maxDrawdown: number | null;
  /** For the "dd" objective: keep P/L at least this. */
  minPl?: number | null;
  /** Highest % per trade the search may set (default 20). */
  maxPct?: number;
}

export interface OptimizeResult {
  alloc: Record<string, StrategyAlloc>;
  result: SimResult;
  feasible: boolean;
  runs: number;
}

function score(r: SimResult, o: OptimizeOptions): number {
  if (o.maxAvgMargin !== null && r.avgMarginUtil > o.maxAvgMargin) return -Infinity;
  if (o.maxPeakMargin !== null && r.maxMarginUtil > o.maxPeakMargin) return -Infinity;
  if (o.maxDrawdown !== null && -r.maxDdPct > o.maxDrawdown) return -Infinity;
  if (o.objective === "dd" && o.minPl !== null && o.minPl !== undefined && r.pl < o.minPl) return -Infinity;
  switch (o.objective) {
    case "pl":
      return r.pl;
    case "cagr":
      return r.cagr ?? -Infinity;
    case "mar":
      return r.mar ?? -Infinity;
    case "sharpe":
      return r.sharpe ?? -Infinity;
    case "sortino":
      return r.sortino ?? -Infinity;
    case "dd":
      return r.maxDdPct; // closer to 0 is better
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Coordinate search: for each included strategy try scaled and nudged allocations, keep any change that
 * improves the objective within the limits, and repeat until a full pass finds nothing better.
 * Capped add-ons (100% × a few contracts) are just switched on or off. Yields to the UI between steps.
 */
export async function optimize(
  trades: SimTrade[],
  start: Record<string, StrategyAlloc>,
  equity: number,
  o: OptimizeOptions,
  onProgress?: (runs: number, best: SimResult) => void,
): Promise<OptimizeResult> {
  const maxPct = o.maxPct ?? 20;
  let alloc = { ...start };
  let best = simulate(trades, alloc, equity);
  let bestScore = score(best, o);
  let runs = 1;
  // Start infeasible (e.g. margin above the limit)? Scale everything down until it fits.
  for (let f = 0.9; bestScore === -Infinity && f > 0.05; f *= 0.9) {
    const scaled = Object.fromEntries(
      Object.entries(start).map(([k, a]) => [k, o.include.includes(k) && !(a.maxContracts && a.pct >= 100) ? { ...a, pct: round2(a.pct * f) } : a]),
    );
    const r = simulate(trades, scaled, equity);
    runs++;
    if (score(r, o) > -Infinity) {
      alloc = scaled;
      best = r;
      bestScore = score(r, o);
    }
  }
  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    for (const name of o.include) {
      const cur = alloc[name] ?? { pct: 0 };
      const addOn = !!cur.maxContracts && (cur.pct >= 100 || (start[name]?.pct ?? 0) >= 100);
      const p = cur.pct;
      const candidates = addOn
        ? [0, 100]
        : [0, p * 0.5, p * 0.75, p * 0.9, p * 1.1, p * 1.25, p * 1.5, p * 2, p - 0.1, p + 0.1, p + 0.5, p === 0 ? 0.5 : p]
            .map((v) => round2(Math.min(maxPct, Math.max(0, v))));
      for (const v of [...new Set(candidates)]) {
        if (v === p) continue;
        const trial = { ...alloc, [name]: { ...cur, pct: v } };
        const r = simulate(trades, trial, equity);
        runs++;
        const sc = score(r, o);
        if (sc > bestScore + 1e-9) {
          alloc = trial;
          best = r;
          bestScore = sc;
          improved = true;
        }
      }
      onProgress?.(runs, best);
      await new Promise((res) => setTimeout(res, 0));
    }
    if (!improved) break;
  }
  return { alloc, result: best, feasible: bestScore > -Infinity, runs };
}
