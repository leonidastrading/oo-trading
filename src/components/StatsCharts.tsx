"use client";

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DailyRow } from "@/lib/stats";
import { money } from "./format";

const compact = (v: number) =>
  Math.abs(v) >= 1000 ? `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : money(v);

const axis = { tick: { fill: "var(--muted)", fontSize: 11 }, tickLine: false } as const;
const tooltipStyle = {
  contentStyle: { background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "var(--ink-2)" },
};

export function EquityChart({ rows }: { rows: DailyRow[] }) {
  return (
    <div className="h-60 md:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="date" {...axis} axisLine={{ stroke: "var(--axis)" }} minTickGap={40} />
          <YAxis {...axis} axisLine={false} tickFormatter={compact} width={56} />
          <Tooltip {...tooltipStyle} formatter={(v) => [money(Number(v), { sign: true }), "Cumulative P/L"]} />
          <Line type="monotone" dataKey="cumulative" stroke="var(--spot)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DrawdownChart({ rows }: { rows: DailyRow[] }) {
  return (
    <div className="h-44 md:h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="date" {...axis} axisLine={{ stroke: "var(--axis)" }} minTickGap={40} />
          <YAxis {...axis} axisLine={false} tickFormatter={compact} width={56} />
          <Tooltip {...tooltipStyle} formatter={(v) => [money(Number(v)), "Drawdown from peak"]} />
          <Area type="monotone" dataKey="drawdown" stroke="var(--loss)" strokeWidth={2} fill="var(--loss)" fillOpacity={0.2} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Month blocks with Mon–Fri columns; diverging gain/loss color around a neutral gray. */
export function CalendarHeatmap({ rows }: { rows: DailyRow[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!rows.length) return null;
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const abs = rows.map((r) => Math.abs(r.total)).sort((a, b) => a - b);
  const scale = abs[Math.floor(abs.length * 0.95)] || abs[abs.length - 1] || 1;
  const color = (v: number) => {
    const t = Math.min(1, Math.abs(v) / scale);
    const pct = Math.round(25 + 75 * t);
    return `color-mix(in oklab, ${v >= 0 ? "var(--gain)" : "var(--loss)"} ${pct}%, #383835)`;
  };

  const months: string[] = [];
  const first = rows[0].date.slice(0, 7);
  const last = rows[rows.length - 1].date.slice(0, 7);
  for (let [y, m] = first.split("-").map(Number); `${y}-${String(m).padStart(2, "0")}` <= last; m === 12 ? (y++, (m = 1)) : m++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-4">
        {months.reverse().map((ym) => {
          const [y, m] = ym.split("-").map(Number);
          const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
          const cells: ({ date: string; day: number } | null)[] = [];
          for (let d = 1; d <= days; d++) {
            const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
            if (wd === 0 || wd === 6) continue;
            if (!cells.length) for (let i = 1; i < wd; i++) cells.push(null);
            cells.push({ date: `${ym}-${String(d).padStart(2, "0")}`, day: d });
          }
          const monthTotal = rows.filter((r) => r.date.startsWith(ym)).reduce((s, r) => s + r.total, 0);
          return (
            <div key={ym}>
              <div className="mb-1 flex justify-between gap-2 text-xs">
                <span className="text-ink-2">
                  {MONTHS[m - 1]} {y}
                </span>
                <span className={monthTotal > 0 ? "text-gain" : monthTotal < 0 ? "text-loss" : "text-muted"}>
                  {money(monthTotal, { sign: true })}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-[2px]">
                {cells.map((c, i) => {
                  if (!c) return <div key={`b${i}`} className="h-7 w-9" />;
                  const r = byDate.get(c.date);
                  return (
                    <button
                      type="button"
                      onClick={() => setSelected(c.date)}
                      aria-label={r ? `${c.date} ${money(r.total, { sign: true })}` : `${c.date} no trades`}
                      key={c.date}
                      title={r ? `${c.date}: ${money(r.total, { sign: true })} (${r.trades} trades)` : `${c.date}: no trades`}
                      className="flex h-7 w-9 items-start justify-start rounded-[4px] p-0.5 text-[9px] leading-none"
                      style={{ background: r ? color(r.total) : "var(--surface-2)", color: r ? "#f0efec" : "var(--muted)" }}
                    >
                      {c.day}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <span>Loss</span>
        {[-1, -0.5, -0.15, 0.15, 0.5, 1].map((t) => (
          <span key={t} className="h-3 w-5 rounded-sm" style={{ background: color(t * scale) }} />
        ))}
        <span>Gain</span>
        <span className="ml-2">(tap or hover a day)</span>
      </div>
      {selected && (
        <p className="mt-2 text-sm" role="status">
          {selected}:{" "}
          {byDate.get(selected) ? (
            <>
              <span className={byDate.get(selected)!.total >= 0 ? "text-gain" : "text-loss"}>
                {money(byDate.get(selected)!.total, { sign: true })}
              </span>{" "}
              <span className="text-muted">
                ({byDate.get(selected)!.trades} trades ·{" "}
                {Object.entries(byDate.get(selected)!.byStrategy)
                  .map(([k, v]) => `${k} ${money(v, { sign: true })}`)
                  .join(" · ")}
                )
              </span>
            </>
          ) : (
            <span className="text-muted">no trades</span>
          )}
        </p>
      )}
    </div>
  );
}
