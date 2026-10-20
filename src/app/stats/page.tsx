"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { money, pct, plClass, SERIES } from "@/components/format";
import { CalendarHeatmap, DrawdownChart, EquityChart } from "@/components/StatsCharts";
import { Tile, toneOf } from "@/components/Tile";
import type { EodSnapshot } from "@/lib/eod";
import type { OOTrade } from "@/lib/ooCsv";
import { ALL, bestWorstDays, dailyPnl, dailyToCsv, maxDrawdown, statsByStrategy, tradeDay, type DailyRow } from "@/lib/stats";
import { addDays, formatDateTimeET, formatTimeET, todayET } from "@/lib/time";

const RANGES = [
  { label: "All", days: null },
  { label: "YTD", days: "ytd" },
  { label: "90D", days: 90 },
  { label: "30D", days: 30 },
] as const;

export default function StatsPage() {
  const [trades, setTrades] = useState<OOTrade[] | null>(null);
  const [meta, setMeta] = useState<{ updatedAt: number } | null>(null);
  const [snapshots, setSnapshots] = useState<EodSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [range, setRange] = useState(0);
  const [showAllDays, setShowAllDays] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([fetch("/api/oo/trades").then((r) => r.json()), fetch("/api/snapshots").then((r) => r.json())])
      .then(([t, s]) => {
        setTrades(t.trades ?? []);
        setMeta(t.meta ?? null);
        setSnapshots(s.snapshots ?? []);
        setLoadedAt(Date.now());
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  // Fixed color per strategy (alphabetical), so filters never repaint survivors.
  const strategies = useMemo(() => [...new Set((trades ?? []).map((t) => t.strategy))].sort(), [trades]);
  const colorOf = (s: string) => SERIES[strategies.indexOf(s) % SERIES.length];

  const filtered = useMemo(() => {
    const today = todayET();
    const r = RANGES[range].days;
    const from = r === null ? "" : r === "ytd" ? `${today.slice(0, 4)}-01-01` : addDays(today, -r);
    return (trades ?? []).filter((t) => !hidden.has(t.strategy) && tradeDay(t) >= from);
  }, [trades, hidden, range]);

  const stats = useMemo(() => statsByStrategy(filtered), [filtered]);
  const daily = useMemo(() => dailyPnl(filtered), [filtered]);
  const visibleStrategies = strategies.filter((s) => !hidden.has(s));
  const dd = maxDrawdown(daily);
  const { best, worst } = bestWorstDays(daily, 10);
  const all = stats.find((s) => s.strategy === ALL) ?? stats[0];

  const download = () => {
    const blob = new Blob([dailyToCsv(daily, visibleStrategies)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `daily-pnl-${todayET()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (error) return <p className="text-loss">Failed to load: {error}</p>;
  if (!trades) return <p className="text-muted">Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Strategy stats</h1>
        <span className="num text-sm text-ink-2">
          Last updated {formatTimeET(loadedAt)}
          {meta?.updatedAt ? ` · CSVs uploaded ${formatDateTimeET(meta.updatedAt)}` : ""}
        </span>
      </div>

      {!trades.length ? (
        <div className="card p-4 text-sm">
          No Option Omega trades yet.{" "}
          <Link href="/settings" className="font-semibold text-link underline">
            Upload trade-log CSVs in Settings
          </Link>
          .
        </div>
      ) : (
        <>
          {/* Filters: one row above the charts */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-border text-sm" role="group" aria-label="Date range">
              {RANGES.map((r, i) => (
                <button
                  key={r.label}
                  onClick={() => setRange(i)}
                  aria-pressed={i === range}
                  className={`px-3 py-1.5 ${i === range ? "bg-surface-2 text-ink" : "text-muted"}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {strategies.map((s) => {
              const on = !hidden.has(s);
              return (
                <button
                  key={s}
                  aria-pressed={on}
                  onClick={() =>
                    setHidden((h) => {
                      const n = new Set(h);
                      if (n.has(s)) n.delete(s);
                      else n.add(s);
                      return n;
                    })
                  }
                  className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                    on ? "border-border text-ink" : "border-border/50 text-muted line-through"
                  }`}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: on ? colorOf(s) : "var(--muted)" }} />
                  <span className="truncate">{s}</span>
                </button>
              );
            })}
          </div>

          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Total P/L" value={money(all?.totalPl, { sign: true })} tone={toneOf(all?.totalPl)} />
            <Tile label="Trades" value={all?.trades ?? 0} sub={`${pct(all?.winPct)} winners`} />
            <Tile label="Avg P/L per lot" value={money(all?.avgPlPerLot, { cents: true, sign: true })} tone={toneOf(all?.avgPlPerLot)} />
            <Tile label="Max drawdown" value={money(dd.amount)} tone={dd.amount < 0 ? "loss" : null} sub={dd.date ?? undefined} />
          </section>

          <section>
            <h2 className="mb-2 text-lg font-bold text-accent">By strategy</h2>
            <div className="card overflow-x-auto">
              <table className="data w-full text-sm">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Trades</th>
                    <th>Win %</th>
                    <th>Avg P/L / lot</th>
                    <th>Avg winner</th>
                    <th>Avg loser</th>
                    <th>Max winner</th>
                    <th>Max loser</th>
                    <th>Total P/L</th>
                    <th title="Share of losing trades by close reason">Losers: stop / exp / other</th>
                    <th>$ lost to stops</th>
                    <th>$ lost to expirations</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr key={s.strategy} className={s.strategy === ALL ? "font-semibold" : undefined}>
                      <td className="min-w-[13rem] whitespace-normal">
                        {s.strategy !== ALL && (
                          <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: colorOf(s.strategy) }} />
                        )}
                        <span className={s.strategy === ALL ? "" : "text-link"}>{s.strategy}</span>
                      </td>
                      <td>{s.trades}</td>
                      <td>{pct(s.winPct)}</td>
                      <td className={plClass(s.avgPlPerLot)}>{money(s.avgPlPerLot, { cents: true, sign: true })}</td>
                      <td className="text-gain">{money(s.avgWinner, { sign: true })}</td>
                      <td className="text-loss">{money(s.avgLoser, { sign: true })}</td>
                      <td className="text-gain">{money(s.maxWinner, { sign: true })}</td>
                      <td className="text-loss">{money(s.maxLoser, { sign: true })}</td>
                      <td className={plClass(s.totalPl)}>{money(s.totalPl, { sign: true })}</td>
                      <td className="text-ink-2">
                        {s.losers
                          ? `${s.losersPctByKind.stop.toFixed(0)}% / ${s.losersPctByKind.expired.toFixed(0)}% / ${s.losersPctByKind.other.toFixed(0)}%`
                          : "—"}
                      </td>
                      <td className={plClass(s.lostByKind.stop)}>{money(s.lostByKind.stop)}</td>
                      <td className={plClass(s.lostByKind.expired)}>{money(s.lostByKind.expired)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4">
              <h2 className="mb-2 font-bold text-accent">Equity curve</h2>
              <EquityChart rows={daily} />
            </div>
            <div className="card p-4">
              <h2 className="mb-2 font-bold text-accent">Drawdown</h2>
              <DrawdownChart rows={daily} />
            </div>
          </section>

          <section className="card p-4">
            <h2 className="mb-3 font-bold text-accent">Calendar</h2>
            <CalendarHeatmap rows={daily} />
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <DayList title="Best 10 days" rows={best} />
            <DayList title="Worst 10 days" rows={worst} />
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-bold text-accent">Daily P/L</h2>
              <button onClick={download} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2">
                Download CSV
              </button>
            </div>
            <div className="card overflow-x-auto">
              <table className="data w-full text-sm">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day total</th>
                    {visibleStrategies.map((s) => (
                      <th key={s} className="max-w-[10rem] truncate" title={s}>
                        <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: colorOf(s) }} />
                        {s.length > 18 ? s.slice(0, 17) + "…" : s}
                      </th>
                    ))}
                    <th>Cumulative</th>
                  </tr>
                </thead>
                <tbody>
                  {[...daily]
                    .reverse()
                    .slice(0, showAllDays ? undefined : 30)
                    .map((r) => (
                      <tr key={r.date}>
                        <td>{r.date}</td>
                        <td className={`font-semibold ${plClass(r.total)}`}>{money(r.total, { sign: true })}</td>
                        {visibleStrategies.map((s) => (
                          <td key={s} className={plClass(r.byStrategy[s])}>
                            {r.byStrategy[s] !== undefined ? money(r.byStrategy[s], { sign: true }) : <span className="text-muted">—</span>}
                          </td>
                        ))}
                        <td className={plClass(r.cumulative)}>{money(r.cumulative, { sign: true })}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {daily.length > 30 && (
              <button onClick={() => setShowAllDays((v) => !v)} className="mt-2 text-sm text-link underline">
                {showAllDays ? "Show last 30 days" : `Show all ${daily.length} days`}
              </button>
            )}
          </section>
        </>
      )}

      <section>
        <h2 className="mb-1 text-lg font-bold text-accent">Account history (end-of-day snapshots)</h2>
        <p className="mb-2 text-xs text-muted">Saved automatically from Schwab at ~16:30 ET each trading day.</p>
        {snapshots.length ? (
          <div className="card overflow-x-auto">
            <table className="data w-full text-sm">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Net liq</th>
                  <th>Day P/L</th>
                  <th>Realized</th>
                  <th>Open P/L</th>
                  <th>Positions</th>
                </tr>
              </thead>
              <tbody>
                {[...snapshots].reverse().map((s) => (
                  <tr key={s.date}>
                    <td>{s.date}</td>
                    <td>{money(s.netLiq)}</td>
                    <td className={plClass(s.dayPl)}>{money(s.dayPl, { sign: true })}</td>
                    <td className={plClass(s.realized)}>{money(s.realized, { sign: true })}</td>
                    <td className={plClass(s.openPl)}>{money(s.openPl, { sign: true })}</td>
                    <td>{s.positions.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">No snapshots yet.</p>
        )}
      </section>
    </div>
  );
}

function DayList({ title, rows }: { title: string; rows: DailyRow[] }) {
  return (
    <div className="card p-4">
      <h2 className="mb-2 font-bold text-accent">{title}</h2>
      {rows.length ? (
        <table className="data w-full text-sm">
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.date}>
                <td className="text-muted">
                  {i + 1}. <span className="text-ink">{r.date}</span>
                </td>
                <td className="text-muted">{r.trades} trades</td>
                <td className={`font-semibold ${plClass(r.total)}`}>{money(r.total, { sign: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-muted">None.</p>
      )}
    </div>
  );
}
