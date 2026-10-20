"use client";

import { useId, useMemo, useState } from "react";
import {
  Area,
  ComposedChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CloseAnalysis } from "@/lib/options";
import { money, strike } from "./format";

const WINDOWS = [
  { label: "±50", pts: 50 },
  { label: "±100", pts: 100 },
  { label: "±3%", pts: Infinity },
];

const compact = (v: number) =>
  Math.abs(v) >= 1000 ? `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : money(v);

export function ExpiryChart({ analysis, underlying }: { analysis: CloseAnalysis; underlying: string }) {
  const [win, setWin] = useState(1);
  const gid = useId().replace(/:/g, "");
  const { spot, best, breakevens } = analysis;

  const data = useMemo(() => {
    const w = WINDOWS[win].pts;
    const center = best.pnl > 0 ? (spot + (best.range ? (best.range.low + best.range.high) / 2 : best.price)) / 2 : spot;
    return analysis.curve.filter((p) => !Number.isFinite(w) || Math.abs(p.price - center) <= w);
  }, [analysis, win, spot, best]);

  const max = Math.max(...data.map((d) => d.pnl), 0);
  const min = Math.min(...data.map((d) => d.pnl), 0);
  const zero = max === min ? 0.5 : max / (max - min);
  const first = data[0]?.price ?? 0;
  const last = data[data.length - 1]?.price ?? 0;
  const tickStep = last - first <= 120 ? 10 : last - first <= 250 ? 25 : 50;
  const ticks: number[] = [];
  for (let t = Math.ceil(first / tickStep) * tickStep; t <= last; t += tickStep) ticks.push(t);
  const inView = (x: number) => data.length > 0 && x >= data[0].price && x <= data[data.length - 1].price;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs text-muted">P/L at expiration vs {underlying} settlement</p>
        <div className="flex rounded-lg border border-border text-xs" role="group" aria-label="Price window">
          {WINDOWS.map((w, i) => (
            <button
              key={w.label}
              onClick={() => setWin(i)}
              className={`px-2.5 py-1 ${i === win ? "bg-surface-2 text-ink" : "text-muted"}`}
              aria-pressed={i === win}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <div className="h-64 w-full md:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 16, right: 12, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={0} stopColor="var(--gain)" stopOpacity={0.35} />
                <stop offset={zero} stopColor="var(--gain)" stopOpacity={0.08} />
                <stop offset={zero} stopColor="var(--loss)" stopOpacity={0.08} />
                <stop offset={1} stopColor="var(--loss)" stopOpacity={0.35} />
              </linearGradient>
              <linearGradient id={`stroke-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset={zero} stopColor="var(--gain)" />
                <stop offset={zero} stopColor="var(--loss)" />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="price"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--axis)" }}
              ticks={ticks}
            />
            <YAxis
              tickFormatter={compact}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <ReferenceLine y={0} stroke="var(--axis)" />
            {best.pnl > 0 && best.range && inView(best.range.low) && (
              <ReferenceArea x1={best.range.low} x2={best.range.high} fill="var(--gain)" fillOpacity={0.12} />
            )}
            <Area
              type="linear"
              dataKey="pnl"
              stroke={`url(#stroke-${gid})`}
              strokeWidth={2}
              fill={`url(#fill-${gid})`}
              isAnimationActive={false}
              activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
            />
            {inView(spot) && (
              <ReferenceLine
                x={spot}
                stroke="var(--spot)"
                strokeWidth={2}
                label={{ value: `${underlying} ${strike(Math.round(spot * 100) / 100)}`, position: "top", fill: "var(--spot)", fontSize: 11 }}
              />
            )}
            {best.pnl > 0 && !best.range && inView(best.price) && (
              <ReferenceDot
                x={best.price}
                y={best.pnl}
                r={5}
                fill="var(--gain)"
                stroke="var(--surface)"
                strokeWidth={2}
                label={{ value: `Max ${strike(best.price)}`, position: "top", fill: "var(--ink-2)", fontSize: 11 }}
              />
            )}
            {breakevens.filter(inView).map((b) => (
              <ReferenceDot key={b} x={b} y={0} r={4} fill="var(--page)" stroke="var(--ink-2)" strokeWidth={2} />
            ))}
            <Tooltip
              cursor={{ stroke: "var(--muted)", strokeDasharray: "3 3" }}
              contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "var(--ink-2)" }}
              labelFormatter={(v) => `${underlying} ${v}`}
              formatter={(v) => [money(Number(v)), "P/L at expiry"]}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-xs text-muted">
        <span className="text-spot">│</span> current price · ○ breakeven
        {best.pnl > 0 ? (best.range ? " · shaded = max-profit range" : " · ● max profit") : ""}
      </p>
    </div>
  );
}
