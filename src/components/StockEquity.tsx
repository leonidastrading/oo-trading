"use client";

import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money } from "@/components/format";
import { usePref } from "@/components/usePref";
import { dailyClosedCurve, type EquitySample, type Mode, type Trade } from "@/lib/stocks/rules";

const LINE = "#3987e5"; // one series per chart: the same blue as "long" in Portfolio stats
const compact = (v: number) => (Math.abs(v) >= 1000 ? `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 100_000 ? 0 : 1)}k` : money(v));
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
const tip = { background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 };
const axisTick = { fill: "var(--muted)", fontSize: 11 };

/** Open P/L through today's session (sampled once a minute), and the running total of closed trades by day. */
export function StockEquity({ trades, mode }: { trades: Trade[]; mode: Mode }) {
  const [samples, setSamples] = useState<EquitySample[] | null>(null);
  const [collapsed, setCollapsed] = usePref<boolean>("stocks.collapsed.equity", false, (v) => typeof v === "boolean");
  useEffect(() => {
    if (collapsed) return;
    let off = false;
    const load = () =>
      fetch("/api/stocks/equity", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { samples?: EquitySample[] }) => !off && setSamples(j.samples ?? []))
        .catch(() => !off && setSamples((s) => s ?? []));
    void load();
    const every = setInterval(load, 60_000);
    return () => {
      off = true;
      clearInterval(every);
    };
  }, [collapsed]);
  const daily = dailyClosedCurve(trades, mode);
  const lastS = samples?.length ? samples[samples.length - 1] : null;
  const firstS = samples?.length ? samples[0] : null;
  const lastD = daily.length ? daily[daily.length - 1] : null;
  const closedN = daily.reduce((a, d) => a + d.trades, 0);
  return (
    <section className="card space-y-4 p-4">
      <h2 className="font-bold text-accent">
        Equity curves
        <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} className="ml-2 rounded-md border border-border px-2 py-0.5 align-middle text-xs font-normal text-ink-2">
          {collapsed ? "▸ Show" : "▾ Hide"}
        </button>
      </h2>
      {!collapsed && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-ink-2">Today: open P/L of open positions</div>
            {lastS && firstS && (
              <div className="text-xs text-ink-2">
                Now <b className="text-ink">{money(lastS.pl, { sign: true })}</b> on {lastS.n} positions · change since {hhmm(firstS.t)} ET:{" "}
                <b className="text-ink">{money(lastS.pl - firstS.pl, { sign: true })}</b>
              </div>
            )}
            {samples === null ? (
              <div className="text-sm text-muted">Loading…</div>
            ) : samples.length < 2 ? (
              <div className="text-sm text-muted">Not enough readings yet today. One is taken each minute between 9:30 and 16:00 ET while there are open positions.</div>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={samples} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="var(--axis)" strokeOpacity={0.25} vertical={false} />
                    <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={hhmm} tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--axis)" }} minTickGap={40} />
                    <YAxis tickFormatter={compact} tick={axisTick} tickLine={false} axisLine={false} width={56} domain={["auto", "auto"]} />
                    <ReferenceLine y={0} stroke="var(--axis)" />
                    <Tooltip
                      contentStyle={tip}
                      labelFormatter={(t) => `${hhmm(Number(t))} ET`}
                      formatter={(v, _n, item) => [`${money(Number(v), { sign: true })} · ${(item.payload as EquitySample).n} positions`, "Open P/L"]}
                    />
                    <Line dataKey="pl" stroke={LINE} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="text-xs text-muted">
              Total unrealized P/L of the filled positions, read once a minute in the regular session (dry-run positions at shadow size). A position opened or closed during the day
              moves the line by its own P/L.
            </p>
          </div>
          <div className="space-y-1">
            <div className="text-sm font-semibold text-ink-2">By day: running P/L of closed trades ({mode === "dry" ? "dry run, shadow size" : "live"})</div>
            {lastD && (
              <div className="text-xs text-ink-2">
                Total <b className="text-ink">{money(lastD.total, { sign: true })}</b> over {closedN} closed trade{closedN === 1 ? "" : "s"} · last day ({lastD.date}):{" "}
                <b className="text-ink">{money(lastD.day, { sign: true })}</b>
              </div>
            )}
            {daily.length === 0 ? (
              <div className="text-sm text-muted">No closed trades yet. The line starts with the first trade that closes.</div>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={[{ date: "Start", day: 0, total: 0, trades: 0 }, ...daily]} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="var(--axis)" strokeOpacity={0.25} vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => (d === "Start" ? d : d.slice(5))} tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--axis)" }} minTickGap={24} />
                    <YAxis tickFormatter={compact} tick={axisTick} tickLine={false} axisLine={false} width={56} domain={["auto", "auto"]} />
                    <ReferenceLine y={0} stroke="var(--axis)" />
                    <Tooltip
                      contentStyle={tip}
                      formatter={(v, _n, item) => {
                        const p = item.payload as { day: number; trades: number };
                        return [`${money(Number(v), { sign: true })} · that day ${money(p.day, { sign: true })} on ${p.trades} trade${p.trades === 1 ? "" : "s"}`, "Running total"];
                      }}
                    />
                    <Line dataKey="total" stroke={LINE} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="text-xs text-muted">Each point is one day: the P/L of every trade closed that day (ET), added to the days before it.</p>
          </div>
        </div>
      )}
    </section>
  );
}
