"use client";

import { useMemo } from "react";
import type { SimTrade } from "@/lib/allocSim";

/** Pearson correlation of two equal-length series (null when either is flat). */
function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** Correlation of the strategies' daily P/L per contract (a day a strategy doesn't trade counts as 0). */
export function correlationMatrix(trades: SimTrade[], strategies: string[]): (number | null)[][] {
  const days = [...new Set(trades.map((t) => t.closeDate))].sort();
  const idx = new Map(days.map((d, i) => [d, i]));
  const series = new Map(strategies.map((s) => [s, new Array<number>(days.length).fill(0)]));
  for (const t of trades) {
    const row = series.get(t.strategy);
    if (row) row[idx.get(t.closeDate)!] += t.plPerLot;
  }
  return strategies.map((a) => strategies.map((b) => (a === b ? 1 : pearson(series.get(a)!, series.get(b)!))));
}

/** Warm for positive correlation (moves together), cool for negative (offsets), clear near zero. */
const shade = (r: number | null) =>
  r === null ? "transparent" : r >= 0 ? `rgba(230, 103, 103, ${Math.min(1, r) * 0.75})` : `rgba(57, 135, 229, ${Math.min(1, -r) * 0.75})`;

export function CorrelationMatrix({ trades, strategies, label }: { trades: SimTrade[]; strategies: string[]; label: (s: string) => string }) {
  const m = useMemo(() => correlationMatrix(trades, strategies), [trades, strategies]);
  if (strategies.length < 2) return null;
  // Short column heads: the first word or two of each name.
  const head = (s: string) => label(s).split(/\s+/).slice(0, 3).join(" ");
  return (
    <section className="card space-y-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-bold text-accent">Correlation</h3>
        <span className="text-xs text-muted">daily P/L per contract, in the selected range</span>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th />
              {strategies.map((s, j) => (
                <th key={s} className="h-28 w-12 px-0.5 align-bottom font-normal text-ink-2" title={label(s)}>
                  <span className="inline-block w-24 origin-bottom-left translate-x-5 -rotate-45 whitespace-nowrap text-left">{j + 1}. {head(s)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {strategies.map((a, i) => (
              <tr key={a}>
                <td className="max-w-[14rem] truncate whitespace-nowrap pr-2 text-ink-2" title={label(a)}>
                  {i + 1}. {label(a)}
                </td>
                {strategies.map((b, j) => {
                  const r = m[i][j];
                  return (
                    <td
                      key={b}
                      className="num h-9 w-12 border border-page text-center"
                      style={{ background: i === j ? "var(--surface-2)" : shade(r) }}
                      title={`${label(a)} vs ${label(b)}: ${r === null ? "n/a" : r.toFixed(2)}`}
                    >
                      {i === j ? "—" : r === null ? "·" : r.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Pearson correlation of each pair&apos;s daily P/L per contract (days a strategy doesn&apos;t trade count as 0), so sizing doesn&apos;t
        affect it. <span style={{ color: "rgb(230,103,103)" }}>Red</span> = they win and lose on the same days (risk stacks);{" "}
        <span style={{ color: "rgb(57,135,229)" }}>blue</span> = they tend to offset; near 0 = independent.
      </p>
    </section>
  );
}
