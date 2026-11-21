"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Trade } from "@/lib/stocks/rules";
import { money } from "./format";

const compact = (v: number) => (Math.abs(v) >= 1000 ? `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(1)}k` : money(v));

/** Running total after each closed trade: shadow P/L ($, left) and R (right); actual P/L in the tooltip. */
export function StockPnlChart({ trades }: { trades: Trade[] }) {
  const closed = trades.filter((t) => t.status === "closed" && typeof t.pl === "number").sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  if (!closed.length) return null;
  const data: { n: number; shadow: number; r: number; pl: number; label: string }[] = [{ n: 0, shadow: 0, r: 0, pl: 0, label: "Start" }];
  for (const t of closed) {
    const prev = data[data.length - 1];
    data.push({
      n: data.length,
      shadow: Math.round(prev.shadow + (t.shadowPl ?? 0)),
      r: Math.round((prev.r + (t.r ?? 0)) * 100) / 100,
      pl: Math.round((prev.pl + (t.pl ?? 0)) * 100) / 100,
      label: `${t.ticker} ${t.exitReason ?? ""}`,
    });
  }
  return (
    <div>
      <div className="mb-1 text-sm font-semibold text-ink-2">P/L after each closed trade</div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="var(--axis)" strokeOpacity={0.25} vertical={false} />
            <XAxis dataKey="n" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--axis)" }} allowDecimals={false} />
            <YAxis yAxisId="usd" tickFormatter={compact} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
            <YAxis yAxisId="r" orientation="right" tickFormatter={(v: number) => `${v}R`} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
            <ReferenceLine yAxisId="usd" y={0} stroke="var(--axis)" />
            <Tooltip
              contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              labelFormatter={(n) => (Number(n) === 0 ? "Start" : `Trade ${n}: ${data[Number(n)]?.label ?? ""}`)}
              formatter={(v, name, item) =>
                name === "shadow"
                  ? [`${money(Number(v), { sign: true })} (actual ${money(item.payload.pl, { sign: true, cents: true })})`, "Shadow P/L"]
                  : [`${Number(v).toFixed(2)}R`, "Total R"]
              }
            />
            <Line yAxisId="usd" dataKey="shadow" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            <Line yAxisId="r" dataKey="r" stroke="var(--spot)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted">Solid: running shadow P/L ($, left). Dashed: running total R (right).</p>
    </div>
  );
}
