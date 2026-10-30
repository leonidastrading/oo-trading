"use client";

import { Bar, BarChart, Cell, ErrorBar, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MonthRow } from "@/lib/allocSim";
import { money } from "./format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const sp = (f: number) => `${f >= 0 ? "+" : "−"}${Math.abs(f).toFixed(1)}%`;

/**
 * Monthly % return bars (P/L ÷ equity at the start of the month), green up / red down, with the average.
 * A thin whisker on each bar spans the month's best and worst running return.
 */
export function MonthlyReturnsChart({ months }: { months: MonthRow[] }) {
  if (months.length < 2) return null;
  const data = months.map((m) => ({
    month: m.month,
    pct: m.pct * 100,
    pl: m.pl,
    hi: m.hiPct * 100,
    lo: m.loPct * 100,
    vix: m.vix,
    // ErrorBar takes [below, above] distances from the bar's end.
    range: [m.pct * 100 - m.loPct * 100, m.hiPct * 100 - m.pct * 100],
  }));
  const avg = data.reduce((s, d) => s + d.pct, 0) / data.length;
  const sorted = [...data].map((d) => d.pct).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const yMin = Math.min(0, Math.floor(Math.min(...data.map((d) => d.lo)) - 0.5));
  const vixes = data.map((d) => d.vix).filter((v): v is number => v !== null);
  const hasVix = vixes.length > 0;
  const vixAvg = hasVix ? vixes.reduce((a, b) => a + b, 0) / vixes.length : 0;
  const yMax = Math.ceil(Math.max(...data.map((d) => d.hi)) + 0.5);
  const up = data.filter((d) => d.pct > 0).length;
  // One tick per January (or every month when the range is short).
  const ticks = data.length > 18 ? data.filter((d) => d.month.endsWith("-01")).map((d) => d.month) : data.map((d) => d.month);

  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-bold text-accent">Monthly return</h3>
        <span className="text-xs text-muted">
          {up} up / {data.length - up} down · avg {sp(avg)} · median {sp(median)}
        </span>
      </div>
      <div className="h-[28rem] w-full md:h-[32rem]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} syncId="monthly" margin={{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="15%">
            <XAxis
              dataKey="month"
              ticks={ticks}
              tickFormatter={(m: string) => (data.length > 18 ? m.slice(0, 4) : MONTHS[Number(m.slice(5)) - 1])}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--axis)" }}
            />
            <YAxis domain={[yMin, yMax]} tickFormatter={(v: number) => `${v.toFixed(0)}%`} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
            <ReferenceLine y={0} stroke="var(--axis)" />
            <ReferenceLine y={avg} stroke="var(--ink-2)" strokeDasharray="4 4" />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--ink-2)" }}
              itemStyle={{ color: "var(--ink)" }}
              labelFormatter={(m) => label(String(m))}
              formatter={(v, _n, item) => [
                `${sp(Number(v))} (${money(item.payload.pl, { sign: true })}) · range ${sp(item.payload.lo)} to ${sp(item.payload.hi)}`,
                "Return",
              ]}
            />
            <Bar dataKey="pct" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.month} fill={d.pct >= 0 ? "var(--gain)" : "var(--loss)"} />
              ))}
              <ErrorBar dataKey="range" width={0} strokeWidth={1.5} stroke="var(--ink-2)" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {hasVix && (
        <>
          <div className="mt-3 flex items-baseline justify-between gap-2">
            <h4 className="text-sm font-bold text-ink-2">Average VIX</h4>
            <span className="text-xs text-muted">avg {vixAvg.toFixed(1)}</span>
          </div>
          <div className="h-40 w-full md:h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} syncId="monthly" margin={{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="15%">
                <XAxis dataKey="month" ticks={ticks} tick={false} tickLine={false} axisLine={{ stroke: "var(--axis)" }} height={4} />
                <YAxis domain={[0, "auto"]} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                <ReferenceLine y={vixAvg} stroke="var(--ink-2)" strokeDasharray="4 4" />
                <Tooltip
                  cursor={{ fill: "var(--surface-2)" }}
                  contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "var(--ink-2)" }}
                  itemStyle={{ color: "var(--ink)" }}
                  labelFormatter={(m) => label(String(m))}
                  formatter={(v) => [v === null || v === undefined ? "—" : Number(v).toFixed(1), "Avg VIX"]}
                />
                <Bar dataKey="vix" fill="var(--link)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      <p className="mt-1 text-xs text-muted">Return = month&apos;s closed-trade P/L ÷ equity at the start of the month. Thin line = the month&apos;s best and worst point. Dashed line = average month.{hasVix && " VIX = each day's average VIX at the log's entries, averaged over the month."}</p>
    </div>
  );
}
