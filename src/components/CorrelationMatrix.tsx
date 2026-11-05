"use client";

import { useMemo } from "react";
import type { SimResult } from "@/lib/allocSim";

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

/**
 * Correlation of the strategies' daily P/L as sized by the simulator (a day a strategy doesn't trade counts as 0),
 * plus each strategy's correlation with the whole portfolio's daily P/L (last row/column).
 */
export function correlationMatrix(daily: SimResult["daily"], strategies: string[]): (number | null)[][] {
  const zero = new Array<number>(daily.days.length).fill(0);
  const series = strategies.map((s) => daily.pl[s] ?? zero);
  const total = zero.map((_, i) => series.reduce((t, x) => t + x[i], 0));
  const all = [...series, total];
  return all.map((a, i) => all.map((b, j) => (i === j ? 1 : pearson(a, b))));
}

/** Warm for positive correlation (moves together), cool for negative (offsets), clear near zero. */
const shade = (r: number | null) =>
  r === null ? "transparent" : r >= 0 ? `rgba(230, 103, 103, ${Math.min(1, r) * 0.75})` : `rgba(57, 135, 229, ${Math.min(1, -r) * 0.75})`;

export function CorrelationMatrix({ daily, strategies, label }: { daily: SimResult["daily"]; strategies: string[]; label: (s: string) => string }) {
  const m = useMemo(() => correlationMatrix(daily, strategies), [daily, strategies]);
  const names = [...strategies, "Portfolio"];
  const name = (s: string) => (s === "Portfolio" ? "Whole portfolio" : label(s));
  if (strategies.length < 2) return null;
  // Short column heads: the first word or two of each name.
  const head = (s: string) => label(s).split(/\s+/).slice(0, 3).join(" ");
  return (
    <section className="card space-y-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-bold text-accent">Correlation</h3>
        <span className="text-xs text-muted">daily P/L at your allocation settings, in the selected range</span>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th />
              {names.map((s, j) => (
                <th key={s} className="h-28 w-12 px-0.5 align-bottom font-normal text-ink-2" title={name(s)}>
                  <span className="inline-block w-24 origin-bottom-left translate-x-5 -rotate-45 whitespace-nowrap text-left">{s === "Portfolio" ? "Portfolio" : `${j + 1}. ${head(s)}`}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {names.map((a, i) => (
              <tr key={a}>
                <td className={`max-w-[14rem] truncate whitespace-nowrap pr-2 ${a === "Portfolio" ? "font-semibold text-ink" : "text-ink-2"}`} title={name(a)}>
                  {a === "Portfolio" ? "Whole portfolio" : `${i + 1}. ${label(a)}`}
                </td>
                {names.map((b, j) => {
                  const r = m[i][j];
                  return (
                    <td
                      key={b}
                      className="num h-9 w-12 border border-page text-center"
                      style={{ background: i === j ? "var(--surface-2)" : shade(r) }}
                      title={`${name(a)} vs ${name(b)}: ${r === null ? "n/a" : r.toFixed(2)}`}
                    >
                      {i === j ? "—" : r === null ? "·" : (Math.abs(r) < 0.005 ? 0 : r).toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Pearson correlation of each pair&apos;s daily P/L as the simulator sizes it at the current sliders (days a strategy doesn&apos;t trade count as
        0), so it follows allocation changes, VIX ranges and 2× after stop. The last row is each strategy&apos;s correlation with the whole
        portfolio: the higher it is, the more that strategy drives the portfolio&apos;s good and bad days. <span style={{ color: "rgb(230,103,103)" }}>Red</span> = they win and lose on the same days (risk stacks);{" "}
        <span style={{ color: "rgb(57,135,229)" }}>blue</span> = they tend to offset; near 0 = independent.
      </p>
    </section>
  );
}
