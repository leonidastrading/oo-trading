"use client";

import { useMemo } from "react";
import type { SimTrade } from "@/lib/allocSim";

export const STREAKS = [2, 3, 4, 5, 6] as const;

export interface StreakRow {
  strategy: string;
  trades: number;
  stops: number;
  /** Longest run of back-to-back stop-outs. */
  longest: number;
  /** For each N: runs of at least N stops in a row, and the share of all trades that sit in such a run. */
  byN: Record<number, { runs: number; pct: number }>;
}

export type StreakKind = "stop" | "loss";
/** A stop-out (OO closed it with a stop loss), or any losing trade (stop, expiry or time exit at a loss). */
const isBad = (kind: StreakKind) => (t: SimTrade) => (kind === "stop" ? t.stopped : t.plPerLot < 0);

/** Back-to-back stop-outs (or losses) per strategy, in entry order, worst first. */
export function stopStreaks(trades: SimTrade[], kind: StreakKind = "stop"): StreakRow[] {
  const bad = isBad(kind);
  const by = new Map<string, SimTrade[]>();
  for (const t of trades) by.set(t.strategy, [...(by.get(t.strategy) ?? []), t]);
  const rows: StreakRow[] = [];
  for (const [strategy, ts] of by) {
    ts.sort((a, b) => a.open.localeCompare(b.open));
    const runs: number[] = [];
    let run = 0;
    for (const t of ts) {
      if (bad(t)) run++;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
    if (run) runs.push(run);
    const byN: StreakRow["byN"] = {};
    for (const n of STREAKS) {
      const long = runs.filter((r) => r >= n);
      byN[n] = { runs: long.length, pct: ts.length ? long.reduce((s, r) => s + r, 0) / ts.length : 0 };
    }
    rows.push({ strategy, trades: ts.length, stops: ts.filter(bad).length, longest: Math.max(0, ...runs), byN });
  }
  // Worst first: longest streak, then how often 3+ and 2+ stops come in a row.
  return rows.sort((a, b) => b.longest - a.longest || b.byN[3].pct - a.byN[3].pct || b.byN[2].pct - a.byN[2].pct);
}

const pct = (v: number) => (v === 0 ? "—" : `${(v * 100).toFixed(1)}%`);
const heat = (v: number) => (v === 0 ? "transparent" : `rgba(230, 103, 103, ${Math.min(0.75, 0.15 + v * 4)})`);

export function StopStreaks({ trades, label, kind = "stop" }: { trades: SimTrade[]; label: (s: string) => string; kind?: StreakKind }) {
  const rows = useMemo(() => stopStreaks(trades, kind), [trades, kind]);
  if (!rows.length) return null;
  const word = kind === "stop" ? "stop-outs" : "losses";
  return (
    <section className="card space-y-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-bold text-accent">{kind === "stop" ? "Stop-outs in a row" : "Losses in a row"}</h3>
        <span className="text-xs text-muted">per strategy, worst first, in the selected range</span>
      </div>
      <div className="overflow-x-auto">
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Trades</th>
              <th>{kind === "stop" ? "Stops" : "Losses"}</th>
              {STREAKS.map((n) => (
                <th key={n}>{n}+ in a row</th>
              ))}
              <th>Longest</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.strategy}>
                <td className="whitespace-normal" title={r.strategy}>
                  {label(r.strategy)}
                </td>
                <td className="num">{r.trades}</td>
                <td className="num">
                  {r.stops} <span className="text-xs text-muted">({pct(r.trades ? r.stops / r.trades : 0)})</span>
                </td>
                {STREAKS.map((n) => (
                  <td
                    key={n}
                    className="num"
                    style={{ background: heat(r.byN[n].pct) }}
                    title={`${r.byN[n].runs} run${r.byN[n].runs === 1 ? "" : "s"} of ${n}+ ${word}`}
                  >
                    {pct(r.byN[n].pct)}
                    {r.byN[n].runs > 0 && <span className="block text-[10px] text-ink-2">{r.byN[n].runs}×</span>}
                  </td>
                ))}
                <td className={`num font-semibold ${r.longest >= 4 ? "text-loss" : ""}`}>{r.longest || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Each strategy&apos;s trades in entry order;{" "}
        {kind === "stop"
          ? "a stop is a trade OO closed with a stop loss."
          : "a loss is any trade that lost money, whether stopped out, expired at a loss or closed at its time exit."}{" "}
        &quot;N+ in a row&quot; = share of the strategy&apos;s trades that were part of a run of at least N back-to-back {word} (below it:
        how many such runs). Sorted by the longest run, then by how often 3+ and 2+ {word} came together.
      </p>
    </section>
  );
}
