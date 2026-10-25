// Fills & Health Scorecard: live Schwab fills vs the same day's OO backtest trades.
// Read-only reporting. All prices are per share ($/share); "per contract" = × 100.
import { parseLegs, type OOTrade } from "./ooCsv";
import { matchLots, type Fill } from "./realized";
import { etParts, todayET } from "./time";

/** Costs the backtests assume ($/share, except fees which are $/contract/side). */
export const ASSUMPTIONS = { feePerSide: 0.88, entry: 0.05, exit: 0.05, stop: 0.1 };

/** Backtest expectations, May 2022 – Oct 2026, per contract. */
export const EXPECTED: Record<string, { avgPl: number; stopRate: number; note?: string }> = {
  Long: { avgPl: 158, stopRate: 0.3 },
  Short: { avgPl: 203, stopRate: 0.18 },
  "8SMA IC": { avgPl: 288, stopRate: 0.1 },
  "$8 IC": { avgPl: 175, stopRate: 0.1, note: "incl. Dip add-on" },
  "5d IC": { avgPl: 32.5, stopRate: 0.11, note: "~$30–35" },
  BWB: { avgPl: 102, stopRate: 0.18 },
  "2DTE": { avgPl: 178, stopRate: 0.08 },
};
export const STRATEGIES = Object.keys(EXPECTED);

/** Map an OO strategy name to the book's short name. */
export function canonicalStrategy(name: string): string {
  const n = name.toLowerCase();
  if (/2\s*dte/.test(n)) return "2DTE";
  if (/bwb|butterfly|fly/.test(n)) return "BWB";
  if (/5d\s*ic/.test(n)) return "5d IC";
  if (/\$\s*8\s*ic/.test(n)) return "$8 IC"; // includes the Dip add-on
  if (/8\s*sma\s*ic/.test(n)) return "8SMA IC";
  if (/sell calls|\bshort\b/.test(n)) return "Short";
  if (/sell puts|\blong\b/.test(n)) return "Long";
  return name.replace(/^[!\s]+/, "").trim();
}

export type ExitKind = "expired" | "profit" | "time" | "stop" | "other";

export function exitKindFromReason(reason: string): ExitKind {
  const r = reason.toLowerCase();
  if (/expir/.test(r)) return "expired";
  if (/stop/.test(r)) return "stop";
  if (/profit/.test(r)) return "profit";
  if (/time|exit at|end of day|eod/.test(r)) return "time";
  return "other";
}

interface Leg {
  putCall: "P" | "C";
  strike: number;
  qty: number;
  price: number;
  expiration: string;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const minutesET = (ms: number) => etParts(ms).minutesOfDay + etParts(ms).second / 60;
const hhmmToMin = (t: string) => {
  const [h, m, s] = t.split(":").map(Number);
  return h * 60 + m + (s || 0) / 60;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
const sortLegs = (legs: Leg[]) => [...legs].sort((a, b) => a.putCall.localeCompare(b.putCall) || a.strike - b.strike);

/** Structure fingerprint: types, sides, ratios and DTE (e.g. "P+1@0,P-1@0,C-1@0,C+1@0"). */
function signature(legs: Leg[], units: number, entryDate: string): string {
  return sortLegs(legs)
    .map((l) => `${l.putCall}${l.qty > 0 ? "+" : "-"}${Math.abs(l.qty) / units}@${daysBetween(entryDate, l.expiration)}`)
    .join(",");
}

export interface LiveTrade {
  orderId: string;
  date: string;
  time: number;
  legs: Leg[];
  units: number;
  /** Net entry credit per share per unit (negative = debit). */
  credit: number;
  signature: string;
  status: "open" | "closed";
  /** "expired" if every leg settled; "trade" if closed by an order. */
  exitVia: "expired" | "trade" | null;
  /** Net closing debit per share per unit (negative = credit received to close). */
  debit: number | null;
  closeTime: number | null;
  /** Schwab-reported fees ($) for opening and closing. */
  fees: number;
  /** Contract-sides traded (opening contracts + contracts closed by orders). */
  contractSides: number;
  plPerCt: number | null;
}

/** Group opening fills by Schwab order into live trades and attach their closes (FIFO). */
export function buildLiveTrades(fills: Fill[], since: string): LiveTrade[] {
  const options = fills.filter((f) => f.assetType === "OPTION");
  const opens = new Map<string, Fill[]>();
  for (const f of options) {
    if (f.effect === "CLOSING" || f.settlement || f.bookDate < since) continue;
    opens.set(f.orderId, [...(opens.get(f.orderId) ?? []), f]);
  }
  const matches = matchLots(options);
  const trades: LiveTrade[] = [];
  for (const [orderId, fs] of opens) {
    const bySymbol = new Map<string, Leg & { cost: number }>();
    for (const f of fs) {
      const l = bySymbol.get(f.symbol) ?? { putCall: f.putCall!, strike: f.strike!, qty: 0, price: 0, expiration: f.expiration!, cost: 0 };
      l.qty += f.qty;
      l.cost += f.qty * f.price;
      bySymbol.set(f.symbol, l);
    }
    const legs: Leg[] = [...bySymbol.values()].filter((l) => l.qty !== 0).map(({ cost, ...l }) => ({ ...l, price: cost / l.qty }));
    if (!legs.length) continue;
    const units = legs.reduce((g, l) => gcd(g, Math.abs(l.qty)), 0);
    const credit = -legs.reduce((s, l) => s + l.qty * l.price, 0) / units;
    const openContracts = legs.reduce((s, l) => s + Math.abs(l.qty), 0);
    let fees = fs.reduce((s, f) => s + f.schwabFees, 0);

    const closes = matches.filter((m) => m.openOrderId === orderId);
    let closedQty = 0;
    let debitTotal = 0;
    let tradeClosed = 0;
    let closeTime: number | null = null;
    for (const m of closes) {
      const q = Math.abs(m.openQty);
      const share = q / Math.abs(m.close.qty);
      closedQty += q;
      if (m.close.settlement) {
        debitTotal += (-m.close.cash * share) / 100; // settlement value from Schwab's posted cash
      } else {
        debitTotal += -Math.sign(m.openQty) * m.close.price * q;
        fees += m.close.schwabFees * share;
        tradeClosed += q;
        closeTime = Math.max(closeTime ?? 0, m.close.time);
      }
    }
    const closed = closedQty >= openContracts;
    const debit = closed ? debitTotal / units : null;
    trades.push({
      orderId,
      date: fs[0].bookDate,
      time: Math.min(...fs.map((f) => f.time)),
      legs,
      units,
      credit: round4(credit),
      signature: signature(legs, units, fs[0].bookDate),
      status: closed ? "closed" : "open",
      exitVia: closed ? (tradeClosed > 0 ? "trade" : "expired") : null,
      debit: debit === null ? null : round4(debit),
      closeTime,
      fees: round2(fees),
      contractSides: openContracts + tradeClosed,
      plPerCt: debit === null ? null : round2((credit - debit) * 100 - fees / units),
    });
  }
  return trades.sort((a, b) => a.time - b.time);
}

export interface BacktestTrade {
  key: string;
  strategy: string;
  rawStrategy: string;
  date: string;
  time: string;
  legs: Leg[];
  units: number;
  /** Entry credit per share (OO Premium, already net of the assumed entry slippage). */
  credit: number;
  /** Closing debit per share, derived from P/L and fees (includes assumed exit slippage). */
  debit: number;
  plPerCt: number;
  kind: ExitKind;
  reason: string;
  closeDate: string | null;
  closeTime: string | null;
  signature: string;
}

export function toBacktest(t: OOTrade): BacktestTrade | null {
  const legs = parseLegs(t.legs, t.dateOpened);
  if (!legs.length || !t.contracts) return null;
  const units = t.contracts;
  const legCredit = -legs.reduce((s, l) => s + l.qty * l.price, 0) / units;
  const credit = t.premium !== null ? t.premium / 100 : legCredit;
  const debit = credit - (t.pl + t.openFees + t.closeFees) / (units * 100);
  return {
    key: t.key,
    strategy: canonicalStrategy(t.strategy),
    rawStrategy: t.strategy,
    date: t.dateOpened,
    time: t.timeOpened,
    legs,
    units,
    credit: round4(credit),
    debit: round4(debit),
    plPerCt: round2(t.pl / units),
    kind: exitKindFromReason(t.reason),
    reason: t.reason,
    closeDate: t.dateClosed,
    closeTime: t.timeClosed,
    signature: signature(legs, units, t.dateOpened),
  };
}

export type Category = "expired" | "profit" | "time" | "stop" | "other";

export interface ScoreTrade {
  id: string;
  date: string;
  entryTime: string;
  strategy: string;
  rawStrategy: string | null;
  status: "matched" | "extra" | "missed" | "awaiting";
  live: LiveTrade | null;
  bt: BacktestTrade | null;
  /** bt credit − live credit ($/share): positive = live worse. */
  entrySlip: number | null;
  category: Category | null;
  categoryInferred: boolean;
  /** live debit − bt debit ($/share): positive = live worse. */
  exitSlip: number | null;
  plDiffPerCt: number | null;
  /** Schwab-reported fees per contract per side. */
  feePerSide: number | null;
  flags: string[];
}

export const MAX_MATCH_MINUTES = 15;
export const LATE_STOP_MIN = 15 * 60 + 55;
export const BIG_MISS = 1.0;

function category(live: LiveTrade, bt: BacktestTrade | null): { category: Category | null; inferred: boolean } {
  if (live.status !== "closed") return { category: null, inferred: false };
  if (live.exitVia === "expired") return { category: "expired", inferred: false };
  if (bt && (bt.kind === "stop" || bt.kind === "profit" || bt.kind === "time")) return { category: bt.kind, inferred: false };
  // Closed by an order but the backtest has no matching exit: a loss-taking close is a stop.
  return { category: (live.debit ?? 0) > live.credit ? "stop" : "profit", inferred: true };
}

/** Match each live trade to the same day's backtest trade (same structure, nearest entry time). */
export function scoreTrades(live: LiveTrade[], backtest: BacktestTrade[], since: string, coverageEnd: string | null): ScoreTrade[] {
  const bt = backtest.filter((b) => b.date >= since);
  const pairs: { l: LiveTrade; b: BacktestTrade; score: number }[] = [];
  for (const l of live) {
    for (const b of bt) {
      if (b.date !== l.date || b.signature !== l.signature) continue;
      const dt = Math.abs(minutesET(l.time) - hhmmToMin(b.time));
      if (dt > MAX_MATCH_MINUTES) continue;
      const ls = sortLegs(l.legs);
      const bs = sortLegs(b.legs);
      const strikeDist = ls.reduce((s, x, i) => s + Math.abs(x.strike - bs[i].strike), 0) / ls.length;
      pairs.push({ l, b, score: dt + strikeDist / 10 });
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  const usedL = new Set<string>();
  const usedB = new Set<string>();
  const matched = new Map<string, BacktestTrade>();
  for (const p of pairs) {
    if (usedL.has(p.l.orderId) || usedB.has(p.b.key)) continue;
    usedL.add(p.l.orderId);
    usedB.add(p.b.key);
    matched.set(p.l.orderId, p.b);
  }

  const out: ScoreTrade[] = [];
  for (const l of live) {
    const b = matched.get(l.orderId) ?? null;
    const { category: cat, inferred } = category(l, b);
    const entrySlip = b ? round4(b.credit - l.credit) : null;
    const exitSlip = b && l.debit !== null ? round4(l.debit - b.debit) : null;
    const awaiting = !b && (coverageEnd === null || l.date > coverageEnd);
    const flags: string[] = [];
    if (cat === "stop" && l.closeTime && minutesET(l.closeTime) >= LATE_STOP_MIN) flags.push("Stop filled ≥ 15:55 ET");
    if ((entrySlip ?? 0) >= BIG_MISS) flags.push("Entry ≥ $1.00 worse than backtest");
    if ((exitSlip ?? 0) >= BIG_MISS) flags.push("Exit ≥ $1.00 worse than backtest");
    if (!b && !awaiting) flags.push("Extra entry (live only)");
    out.push({
      id: `L${l.orderId}`,
      date: l.date,
      entryTime: etTime(l.time),
      strategy: b?.strategy ?? "Unmatched",
      rawStrategy: b?.rawStrategy ?? null,
      status: b ? "matched" : awaiting ? "awaiting" : "extra",
      live: l,
      bt: b,
      entrySlip,
      category: cat,
      categoryInferred: inferred,
      exitSlip,
      plDiffPerCt: b && l.plPerCt !== null ? round2(l.plPerCt - b.plPerCt) : null,
      feePerSide: l.contractSides ? round4(l.fees / l.contractSides) : null,
      flags,
    });
  }
  for (const b of bt) {
    if (usedB.has(b.key) || (coverageEnd !== null && b.date > coverageEnd)) continue;
    out.push({
      id: `B${b.key}`,
      date: b.date,
      entryTime: b.time,
      strategy: b.strategy,
      rawStrategy: b.rawStrategy,
      status: "missed",
      live: null,
      bt: b,
      entrySlip: null,
      category: null,
      categoryInferred: false,
      exitSlip: null,
      plDiffPerCt: null,
      feePerSide: null,
      flags: ["Missed entry (backtest only)"],
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.entryTime.localeCompare(a.entryTime));
}

// ---------- Aggregates & lights ----------

export type Light = "green" | "yellow" | "red" | "few" | "none";

export interface Dist {
  n: number;
  mean: number | null;
  median: number | null;
  worst5: number | null;
}

/** $/contract distribution (input in $/share). worst5 = 95th percentile (nearest rank). */
export function dist(xs: number[]): Dist {
  if (!xs.length) return { n: 0, mean: null, median: null, worst5: null };
  const s = [...xs].map((x) => x * 100).sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    n: s.length,
    mean: round2(s.reduce((a, b) => a + b, 0) / s.length),
    median: round2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2),
    worst5: round2(s[Math.max(0, Math.ceil(0.95 * s.length) - 1)]),
  };
}

export interface Aggregate {
  name: string;
  liveTrades: number;
  closedTrades: number;
  matchedClosed: number;
  entry: Dist;
  normalExit: Dist;
  stop: Dist;
  slippageCost: number;
  btPl: number;
  livePl: number;
  slippagePctOfBt: number | null;
  stopRate: number | null;
  stopRateRolling20: number | null;
  expectedStopRate: number | null;
  livePerCt: number | null;
  btPerCt: number | null;
  expectedPerCt: number | null;
  gapPct: number | null;
  missed: number;
  extra: number;
  maxMissedExtraInMonth: number;
  feePerSide: number | null;
  flaggedFills: number;
  lights: { slippage: Light; stopRate: Light; missedExtra: Light; gap: Light };
}

export const MIN_TRADES_TO_JUDGE = 10;

function slipLight(d: Dist, assumption: number): Light {
  if (d.mean === null) return "none";
  // Backtest prices already include the assumed slippage, so live − backtest is the excess:
  // ≤ 0 → actual slippage at/under the assumption; ≤ +50% of it → up to 1.5× the assumption.
  const excess = d.mean / 100;
  if (excess <= 1e-9) return "green";
  if (excess <= 0.5 * assumption + 1e-9) return "yellow";
  return "red";
}

const worst = (ls: Light[]): Light =>
  ls.includes("red") ? "red" : ls.includes("yellow") ? "yellow" : ls.includes("green") ? "green" : ls.includes("few") ? "few" : "none";

export function aggregate(name: string, trades: ScoreTrade[], expectedFor: (strategy: string) => { avgPl: number; stopRate: number } | undefined): Aggregate {
  const own = expectedFor(name);
  const live = trades.filter((t) => t.live);
  const closed = live.filter((t) => t.live!.status === "closed");
  const matched = trades.filter((t) => t.status === "matched");
  const matchedClosed = matched.filter((t) => t.live!.status === "closed");
  const entry = dist(matched.map((t) => t.entrySlip!));
  const normalExit = dist(matchedClosed.filter((t) => t.category === "profit" || t.category === "time").map((t) => t.exitSlip!));
  const stop = dist(matchedClosed.filter((t) => t.category === "stop").map((t) => t.exitSlip!));
  const units = (t: ScoreTrade) => t.live!.units;
  const slippageCost = matched.reduce((s, t) => s + ((t.entrySlip ?? 0) + (t.exitSlip ?? 0)) * 100 * units(t), 0);
  const btPl = matchedClosed.reduce((s, t) => s + t.bt!.plPerCt * units(t), 0);
  const livePl = matchedClosed.reduce((s, t) => s + t.live!.plPerCt! * units(t), 0);
  const stops = closed.filter((t) => t.category === "stop").length;
  const byClose = [...closed].sort((a, b) => (a.live!.closeTime ?? a.live!.time) - (b.live!.closeTime ?? b.live!.time));
  const last20 = byClose.slice(-20);
  // Expected values: trade-weighted mix of the strategies present.
  const strategies = closed.map((t) => expectedFor(t.strategy)).filter((e) => e !== undefined);
  const expectedStopRate = own?.stopRate ?? (strategies.length ? strategies.reduce((s, e) => s + e.stopRate, 0) / strategies.length : null);
  const expectedPerCt = own?.avgPl ?? (strategies.length ? strategies.reduce((s, e) => s + e.avgPl, 0) / strategies.length : null);
  const missed = trades.filter((t) => t.status === "missed").length;
  const extra = trades.filter((t) => t.status === "extra").length;
  const perMonth = new Map<string, number>();
  for (const t of trades) if (t.status === "missed" || t.status === "extra") perMonth.set(t.date.slice(0, 7), (perMonth.get(t.date.slice(0, 7)) ?? 0) + 1);
  const maxMissedExtraInMonth = Math.max(0, ...perMonth.values());
  const fees = live.reduce((s, t) => s + t.live!.fees, 0);
  const sides = live.reduce((s, t) => s + t.live!.contractSides, 0);
  const flaggedFills = trades.filter((t) => t.flags.some((f) => f.startsWith("Stop filled") || f.includes("$1.00 worse"))).length;

  const stopRateRolling20 = last20.length ? last20.filter((t) => t.category === "stop").length / last20.length : null;
  let stopLight: Light = "none";
  if (closed.length < MIN_TRADES_TO_JUDGE) stopLight = closed.length ? "few" : "none";
  else if (expectedStopRate && stopRateRolling20 !== null) {
    stopLight = stopRateRolling20 > 2 * expectedStopRate ? "red" : stopRateRolling20 > 1.5 * expectedStopRate ? "yellow" : "green";
  }
  const gapPct = btPl ? ((livePl - btPl) / Math.abs(btPl)) * 100 : null;
  let gapLight: Light = "none";
  if (matchedClosed.length < MIN_TRADES_TO_JUDGE) gapLight = matchedClosed.length ? "few" : "none";
  else if (gapPct !== null) gapLight = gapPct < -25 ? "red" : gapPct < -10 ? "yellow" : "green";
  const slippage = worst([slipLight(entry, ASSUMPTIONS.entry), slipLight(normalExit, ASSUMPTIONS.exit), slipLight(stop, ASSUMPTIONS.stop)]);

  return {
    name,
    liveTrades: live.length,
    closedTrades: closed.length,
    matchedClosed: matchedClosed.length,
    entry,
    normalExit,
    stop,
    slippageCost: round2(slippageCost),
    btPl: round2(btPl),
    livePl: round2(livePl),
    slippagePctOfBt: btPl ? round2((slippageCost / Math.abs(btPl)) * 100) : null,
    stopRate: closed.length ? stops / closed.length : null,
    stopRateRolling20,
    expectedStopRate,
    livePerCt: closed.length ? round2(closed.reduce((s, t) => s + t.live!.plPerCt!, 0) / closed.length) : null,
    btPerCt: matchedClosed.length ? round2(matchedClosed.reduce((s, t) => s + t.bt!.plPerCt, 0) / matchedClosed.length) : null,
    expectedPerCt: expectedPerCt === null ? null : round2(expectedPerCt),
    gapPct: gapPct === null ? null : round2(gapPct),
    missed,
    extra,
    maxMissedExtraInMonth,
    feePerSide: sides ? round4(fees / sides) : null,
    flaggedFills,
    lights: {
      slippage: flaggedFills > 0 ? "red" : slippage,
      stopRate: stopLight,
      missedExtra:
        trades.filter((t) => t.status !== "awaiting").length === 0
          ? "none"
          : missed + extra === 0
            ? "green"
            : maxMissedExtraInMonth >= 2
              ? "red"
              : "yellow",
      gap: gapLight,
    },
  };
}

export interface Scorecard {
  asOf: number;
  inception: string;
  monthStart: string;
  coverageEnd: string | null;
  trades: ScoreTrade[];
  periods: Record<"mtd" | "inception", { book: Aggregate; strategies: Aggregate[] }>;
}

export function buildScorecard(fills: Fill[], ooTrades: OOTrade[], inception: string, now = Date.now()): Scorecard {
  const backtest = ooTrades.map(toBacktest).filter((b) => b !== null);
  const coverageEnd = backtest.length ? backtest.reduce((m, b) => (b.date > m ? b.date : m), "") : null;
  const trades = scoreTrades(buildLiveTrades(fills, inception), backtest, inception, coverageEnd);
  const today = todayET(now);
  const monthStart = today.slice(0, 8) + "01" > inception ? today.slice(0, 8) + "01" : inception;
  const expectedFor = (s: string) => EXPECTED[s];
  const period = (from: string) => {
    const ts = trades.filter((t) => t.date >= from);
    const names = [...STRATEGIES, ...new Set(ts.map((t) => t.strategy).filter((s) => !EXPECTED[s]))];
    return {
      book: aggregate("Book", ts, expectedFor),
      strategies: names.map((n) => aggregate(n, ts.filter((t) => t.strategy === n), expectedFor)),
    };
  };
  return { asOf: now, inception, monthStart, coverageEnd, trades, periods: { mtd: period(monthStart), inception: period(inception) } };
}

function etTime(ms: number): string {
  const p = etParts(ms);
  return [p.hour, p.minute, p.second].map((x) => String(x).padStart(2, "0")).join(":");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
