"use client";

import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MonthRow } from "@/lib/allocSim";
import { money } from "./format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const sp = (f: number) => `${f >= 0 ? "+" : "−"}${Math.abs(f).toFixed(1)}%`;

/** Monthly % return bars (P/L ÷ equity at the start of the month), green up / red down, with the average. */
export function MonthlyReturnsChart({ months }: { months: MonthRow[] }) {
  if (months.length < 2) return null;
  const data = months.map((m) => ({ month: m.month, pct: m.pct * 100, pl: m.pl }));
  const avg = data.reduce((s, d) => s + d.pct, 0) / data.length;
  const sorted = [...data].map((d) => d.pct).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
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
      <div className="h-56 w-full md:h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="15%">
            <XAxis
              dataKey="month"
              ticks={ticks}
              tickFormatter={(m: string) => (data.length > 18 ? m.slice(0, 4) : MONTHS[Number(m.slice(5)) - 1])}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--axis)" }}
            />
            <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
            <ReferenceLine y={0} stroke="var(--axis)" />
            <ReferenceLine y={avg} stroke="var(--ink-2)" strokeDasharray="4 4" />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--ink-2)" }}
              itemStyle={{ color: "var(--ink)" }}
              labelFormatter={(m) => label(String(m))}
              formatter={(v, _n, item) => [`${sp(Number(v))} (${money(item.payload.pl, { sign: true })})`, "Return"]}
            />
            <Bar dataKey="pct" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.month} fill={d.pct >= 0 ? "var(--gain)" : "var(--loss)"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-xs text-muted">Return = month&apos;s closed-trade P/L ÷ equity at the start of the month. Dashed line = average month.</p>
    </div>
  );
}
