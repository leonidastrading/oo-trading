"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ClosedPoint } from "@/lib/views";
import { money, plClass } from "./format";

const compact = (v: number) =>
  Math.abs(v) >= 1000 ? `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : money(v);

const timeET = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

export function ClosedPnlChart({ points }: { points: ClosedPoint[] }) {
  if (points.length === 0) return null;
  const total = points[points.length - 1].cum;
  const winners = points.filter((p) => p.realized > 0).length;
  const data = [{ i: 0, cum: 0, time: 0, label: "Start", realized: 0, expired: false }, ...points.map((p, i) => ({ ...p, i: i + 1 }))];

  return (
    <section className="card space-y-2 p-4 md:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-accent">Closed P/L today</h2>
        <span className="text-sm">
          <span className={plClass(total)}>{money(total, { sign: true })}</span>
          <span className="text-muted">
            {" "}
            · {points.length} trade{points.length === 1 ? "" : "s"} · {winners} up / {points.length - winners} down
          </span>
        </span>
      </header>
      <div className="h-56 w-full md:h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="var(--axis)" strokeOpacity={0.3} vertical={false} />
            <XAxis
              dataKey="i"
              type="number"
              domain={[0, data.length - 1]}
              ticks={data.map((d) => d.i)}
              tickFormatter={(i: number) => (i === 0 ? "" : data[i].expired ? "settle" : timeET(data[i].time))}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--axis)" }}
            />
            <YAxis tickFormatter={compact} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
            <ReferenceLine y={0} stroke="var(--axis)" />
            <Line
              type="linear"
              dataKey="cum"
              stroke="var(--spot)"
              strokeWidth={2}
              isAnimationActive={false}
              dot={(props: { cx?: number; cy?: number; index?: number }) => {
                const d = data[props.index ?? 0];
                return (
                  <circle
                    key={props.index}
                    cx={props.cx}
                    cy={props.cy}
                    r={d.i === 0 ? 0 : 4}
                    fill={d.realized >= 0 ? "var(--gain)" : "var(--loss)"}
                    stroke="var(--surface)"
                    strokeWidth={1.5}
                  />
                );
              }}
            />
            <Tooltip
              contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--ink-2)" }}
              itemStyle={{ color: "var(--ink)" }}
              labelFormatter={(i) => {
                const d = data[Number(i)];
                return d.i === 0 ? "Start" : `${d.expired ? "4:00 PM settlement" : timeET(d.time)} · ${d.label} ${money(d.realized, { sign: true })}`;
              }}
              formatter={(v) => [money(Number(v), { sign: true }), "Cumulative"]}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted">
        Each dot is one closed trade (Schwab order), net of fees; today&apos;s expirations land at the 4:00 PM settlement.{" "}
        <span className="text-gain">●</span> winner <span className="text-loss">●</span> loser
      </p>
    </section>
  );
}
