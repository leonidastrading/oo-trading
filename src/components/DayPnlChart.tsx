"use client";

import { Area, ComposedChart, CartesianGrid, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DayCurve } from "@/lib/views";
import { money, plClass } from "./format";

const compact = (v: number) =>
  Math.abs(v) >= 1000 ? `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : money(v);
const pctFmt = (v: number, d = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`;
const timeET = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

/** A 1/2/2.5/5 step giving about four gridlines over the span. */
function niceStep(span: number) {
  const raw = span / 4;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
}

/** Day equity P/L from the open, sampled each minute: $ on the right axis, % of the prior close on the left. */
export function DayPnlChart({ curve }: { curve: DayCurve | undefined }) {
  if (!curve || !curve.from) return null;
  const base = curve.base && curve.base > 0 ? curve.base : null;
  const data = [{ t: curve.from, pl: 0, open: 0, closed: 0 }, ...curve.samples.filter((s) => s.t > curve.from)].map((d) => ({
    ...d,
    pct: base ? (d.pl / base) * 100 : 0,
  }));
  const last = data[data.length - 1];
  const lo = Math.min(0, ...data.map((d) => d.pl));
  const hi = Math.max(0, ...data.map((d) => d.pl));
  const step = niceStep(Math.max(hi - lo, 1000));
  const usd: [number, number] = [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
  if (usd[0] === usd[1]) usd[1] += step;
  const ticks: number[] = [];
  for (let v = usd[0]; v <= usd[1] + 1e-9; v += step) ticks.push(v);
  const pctDomain: [number, number] = base ? [(usd[0] / base) * 100, (usd[1] / base) * 100] : usd;
  // Green above zero, red below: the gradient splits where zero falls in the range.
  const zeroAt = usd[1] / (usd[1] - usd[0]);
  const hours: number[] = [];
  for (let t = Math.ceil(curve.from / 3_600_000) * 3_600_000; t <= curve.to; t += 3_600_000) hours.push(t);

  return (
    <section className="card space-y-2 p-4 md:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-accent">Day P/L</h2>
        <span className="text-sm">
          <span className={`font-semibold ${plClass(last.pl)}`}>{money(last.pl, { sign: true })}</span>
          {base && <span className={plClass(last.pl)}> ({pctFmt(last.pct)})</span>}
          <span className="text-muted"> · {curve.samples.length ? `as of ${timeET(last.t)}` : "starts at the open"}</span>
        </span>
      </header>
      <div className="h-56 w-full md:h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 4, left: 4 }}>
            <defs>
              <linearGradient id="dayPlFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset={0} stopColor="var(--gain)" stopOpacity={0.35} />
                <stop offset={zeroAt} stopColor="var(--gain)" stopOpacity={0.05} />
                <stop offset={zeroAt} stopColor="var(--loss)" stopOpacity={0.05} />
                <stop offset={1} stopColor="var(--loss)" stopOpacity={0.35} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--axis)" strokeOpacity={0.3} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[curve.from, curve.to]}
              ticks={hours}
              tickFormatter={timeET}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--axis)" }}
            />
            <YAxis
              yAxisId="pct"
              orientation="left"
              domain={pctDomain}
              ticks={base ? ticks.map((v) => (v / base) * 100) : ticks}
              allowDataOverflow
              tickFormatter={(v: number) => (base ? pctFmt(v) : "")}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <YAxis
              yAxisId="usd"
              orientation="right"
              domain={usd}
              ticks={ticks}
              allowDataOverflow
              tickFormatter={compact}
              tick={{ fill: "var(--muted)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <ReferenceLine yAxisId="usd" y={0} stroke="var(--axis)" />
            <Area yAxisId="usd" type="linear" dataKey="pl" stroke="none" fill="url(#dayPlFill)" baseValue={0} isAnimationActive={false} />
            <Line
              yAxisId="usd"
              type="linear"
              dataKey="pl"
              stroke={last.pl >= 0 ? "var(--gain)" : "var(--loss)"}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line yAxisId="pct" dataKey="pct" stroke="none" dot={false} activeDot={false} isAnimationActive={false} legendType="none" />
            <Tooltip
              content={({ active, payload, label }) => {
                const d = active ? payload?.[0]?.payload : null;
                if (!d) return null;
                return (
                  <div className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs">
                    <div className="text-ink-2">{timeET(Number(label))}</div>
                    <div className={`font-semibold ${plClass(d.pl)}`}>
                      {money(d.pl, { sign: true })}
                      {base ? ` (${pctFmt(d.pct)})` : ""}
                    </div>
                    <div className="text-muted">
                      open {money(d.open, { sign: true })} · closed {money(d.closed, { sign: true })}
                    </div>
                  </div>
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted">Day equity P/L (net liq vs. the prior close), sampled every minute. Left axis: % of the prior close.</p>
    </section>
  );
}
