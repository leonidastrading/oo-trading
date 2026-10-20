// Strategy statistics and daily P/L series from OO trades.
import type { OOTrade } from "./ooCsv";

export type CloseKind = "stop" | "expired" | "other";

export function classifyReason(reason: string): CloseKind {
  if (/stop/i.test(reason)) return "stop";
  if (/expir/i.test(reason)) return "expired";
  return "other";
}

export interface StrategyStats {
  strategy: string;
  trades: number;
  winners: number;
  losers: number;
  winPct: number;
  totalPl: number;
  contracts: number;
  avgPlPerLot: number;
  avgWinner: number;
  avgLoser: number;
  maxWinner: number;
  maxLoser: number;
  losersByKind: Record<CloseKind, number>;
  losersPctByKind: Record<CloseKind, number>;
  lostByKind: Record<CloseKind, number>;
  fees: number;
}

export const ALL = "All strategies";

export function strategyStats(trades: OOTrade[], name: string): StrategyStats {
  const wins = trades.filter((t) => t.pl > 0);
  const losses = trades.filter((t) => t.pl < 0);
  const totalPl = sum(trades.map((t) => t.pl));
  const contracts = sum(trades.map((t) => t.contracts));
  const losersByKind: Record<CloseKind, number> = { stop: 0, expired: 0, other: 0 };
  const lostByKind: Record<CloseKind, number> = { stop: 0, expired: 0, other: 0 };
  for (const t of losses) {
    const k = classifyReason(t.reason);
    losersByKind[k]++;
    lostByKind[k] += t.pl;
  }
  const pct = (n: number) => (losses.length ? (n / losses.length) * 100 : 0);
  return {
    strategy: name,
    trades: trades.length,
    winners: wins.length,
    losers: losses.length,
    winPct: trades.length ? (wins.length / trades.length) * 100 : 0,
    totalPl: round2(totalPl),
    contracts,
    avgPlPerLot: contracts ? round2(totalPl / contracts) : 0,
    avgWinner: wins.length ? round2(sum(wins.map((t) => t.pl)) / wins.length) : 0,
    avgLoser: losses.length ? round2(sum(losses.map((t) => t.pl)) / losses.length) : 0,
    maxWinner: wins.length ? Math.max(...wins.map((t) => t.pl)) : 0,
    maxLoser: losses.length ? Math.min(...losses.map((t) => t.pl)) : 0,
    losersByKind,
    losersPctByKind: { stop: pct(losersByKind.stop), expired: pct(losersByKind.expired), other: pct(losersByKind.other) },
    lostByKind: { stop: round2(lostByKind.stop), expired: round2(lostByKind.expired), other: round2(lostByKind.other) },
    fees: round2(sum(trades.map((t) => t.openFees + t.closeFees))),
  };
}

export function statsByStrategy(trades: OOTrade[]): StrategyStats[] {
  const by = groupBy(trades, (t) => t.strategy);
  const rows = [...by.entries()].map(([s, ts]) => strategyStats(ts, s)).sort((a, b) => b.totalPl - a.totalPl);
  if (rows.length > 1) rows.push(strategyStats(trades, ALL));
  return rows;
}

/** The day a trade's P/L is realized. */
export const tradeDay = (t: OOTrade) => t.dateClosed ?? t.dateOpened;

export interface DailyRow {
  date: string;
  total: number;
  byStrategy: Record<string, number>;
  cumulative: number;
  /** Cumulative minus running peak (≤ 0). */
  drawdown: number;
  trades: number;
}

export function dailyPnl(trades: OOTrade[]): DailyRow[] {
  const by = groupBy(trades, tradeDay);
  const dates = [...by.keys()].sort();
  let cum = 0;
  let peak = 0;
  return dates.map((date) => {
    const ts = by.get(date)!;
    const byStrategy: Record<string, number> = {};
    for (const t of ts) byStrategy[t.strategy] = round2((byStrategy[t.strategy] ?? 0) + t.pl);
    const total = round2(sum(ts.map((t) => t.pl)));
    cum = round2(cum + total);
    peak = Math.max(peak, cum);
    return { date, total, byStrategy, cumulative: cum, drawdown: round2(cum - peak), trades: ts.length };
  });
}

export function maxDrawdown(rows: DailyRow[]): { amount: number; date: string | null } {
  let worst = 0;
  let date: string | null = null;
  for (const r of rows) {
    if (r.drawdown < worst) {
      worst = r.drawdown;
      date = r.date;
    }
  }
  return { amount: worst, date };
}

export function bestWorstDays(rows: DailyRow[], n = 10): { best: DailyRow[]; worst: DailyRow[] } {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  return {
    best: sorted.filter((r) => r.total > 0).slice(0, n),
    worst: [...sorted].reverse().filter((r) => r.total < 0).slice(0, n),
  };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function dailyToCsv(rows: DailyRow[], strategies: string[]): string {
  const header = ["Date", "Day Total", ...strategies, "Cumulative"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.date, r.total.toFixed(2), ...strategies.map((s) => (r.byStrategy[s] ?? 0).toFixed(2)), r.cumulative.toFixed(2)]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
