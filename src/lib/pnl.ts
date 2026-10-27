// Weekly account performance from end-of-day net liquidation values.
import { addDays, isTradingDay } from "./time";

export interface WeekRow {
  /** Monday of the week (ET date). */
  week: string;
  /** Last trading day counted in the week (today for the current week). */
  end: string;
  startEquity: number;
  endEquity: number;
  /** Net deposits (+) / withdrawals (−) during the week; excluded from P/L. */
  transfers: number;
  pl: number;
  /** P/L as a fraction of start-of-week equity plus any money added during the week. */
  plPct: number | null;
  /** Some closes in the chain were back-filled from realized P/L rather than a Schwab snapshot. */
  estimated: boolean;
  current: boolean;
}

export interface WeeklyInput {
  /** Exact closing net liq by date (EOD snapshots; today's live value). */
  closes: Record<string, number>;
  /** Exact prior-close net liq by date (a snapshot's startNetLiq = previous session's close). */
  priorCloses: Record<string, number>;
  /** Realized P/L by session date (net of fees), used to back-fill days without snapshots. */
  realized: Record<string, number>;
  /** Net transfers by date. */
  transfers: Record<string, number>;
  /** First session to report (ET date). */
  from: string;
  today: string;
}

export const mondayOf = (date: string): string => {
  const dow = new Date(date + "T12:00:00Z").getUTCDay(); // 0 Sun … 6 Sat
  return addDays(date, -((dow + 6) % 7));
};

function prevSession(d: string): string {
  let p = addDays(d, -1);
  for (let i = 0; i < 10 && !isTradingDay(p); i++) p = addDays(p, -1);
  return p;
}

/**
 * Closing equity for every session from the session before `from` through today. Exact values
 * come from snapshots; gaps are filled backward from the nearest later exact close by removing
 * that day's realized P/L and transfers, and forward from an earlier one by adding them.
 */
export function dailyCloses(input: WeeklyInput): { date: string; equity: number; estimated: boolean }[] {
  const days: string[] = [];
  for (let d = prevSession(input.from); d <= input.today; d = addDays(d, 1)) if (isTradingDay(d) || d === input.today) days.push(d);
  const exact = new Map<string, number>();
  for (const [d, v] of Object.entries(input.priorCloses)) {
    const p = prevSession(d);
    if (!exact.has(p)) exact.set(p, v);
  }
  for (const [d, v] of Object.entries(input.closes)) exact.set(d, v);
  const flow = (d: string) => (input.realized[d] ?? 0) + (input.transfers[d] ?? 0);

  const out = new Map<string, { equity: number; estimated: boolean }>();
  // Backward pass from each exact close.
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (exact.has(d)) out.set(d, { equity: exact.get(d)!, estimated: false });
    else if (i + 1 < days.length && out.has(days[i + 1])) {
      const next = out.get(days[i + 1])!;
      out.set(d, { equity: next.equity - flow(days[i + 1]), estimated: true });
    }
  }
  // Forward pass for anything after the last exact close (e.g. a missed snapshot).
  for (let i = 1; i < days.length; i++) {
    const d = days[i];
    if (!out.has(d) && out.has(days[i - 1])) out.set(d, { equity: out.get(days[i - 1])!.equity + flow(d), estimated: true });
  }
  return days.filter((d) => out.has(d)).map((d) => ({ date: d, ...out.get(d)! }));
}

export function weeklyRows(input: WeeklyInput): WeekRow[] {
  const closes = dailyCloses(input);
  if (closes.length < 2) return [];
  const rows: WeekRow[] = [];
  let prev = closes[0];
  let i = 1;
  while (i < closes.length) {
    const week = mondayOf(closes[i].date);
    let estimated = prev.estimated;
    let transfers = 0;
    let last = closes[i];
    while (i < closes.length && mondayOf(closes[i].date) === week) {
      last = closes[i];
      transfers += input.transfers[last.date] ?? 0;
      estimated ||= last.estimated;
      i++;
    }
    // A back-filled start of ~0 in the week the account was funded means it was empty: use exactly 0.
    if (rows.length === 0 && prev.estimated && transfers > 0 && Math.abs(prev.equity) < 0.01 * transfers) {
      prev = { ...prev, equity: 0, estimated: false };
      estimated = last.estimated;
    }
    const pl = round2(last.equity - prev.equity - transfers);
    rows.push({
      week,
      end: last.date,
      startEquity: round2(prev.equity),
      endEquity: round2(last.equity),
      transfers: round2(transfers),
      pl,
      plPct: prev.equity + Math.max(transfers, 0) > 0 ? pl / (prev.equity + Math.max(transfers, 0)) : null,
      estimated,
      current: week === mondayOf(input.today),
    });
    prev = last;
  }
  return rows;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
