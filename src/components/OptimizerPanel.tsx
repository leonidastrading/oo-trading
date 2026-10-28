"use client";

import { useState } from "react";
import { optimize, type Objective, type OptimizeResult, type SimResult, type SimTrade, type StrategyAlloc } from "@/lib/allocSim";
import { money } from "./format";

const OBJECTIVES: { key: Objective; label: string }[] = [
  { key: "pl", label: "Max P/L" },
  { key: "cagr", label: "Max CAGR" },
  { key: "mar", label: "Max MAR" },
  { key: "sharpe", label: "Max Sharpe" },
  { key: "sortino", label: "Max Sortino" },
  { key: "dd", label: "Smallest drawdown" },
];

const pct = (f: number | null | undefined, d = 1) => (f === null || f === undefined || !Number.isFinite(f) ? "—" : `${(f * 100).toFixed(d)}%`);
const n2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(2));
const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));

export function OptimizerPanel({
  trades,
  alloc,
  equity,
  baseline,
  strategies,
  label,
  onApply,
}: {
  trades: SimTrade[];
  /** Starting point for every run: the uploaded log's settings, never the sliders (which may hold an earlier result). */
  alloc: Record<string, StrategyAlloc>;
  equity: number;
  baseline: SimResult;
  strategies: string[];
  label: (s: string) => string;
  onApply: (a: Record<string, StrategyAlloc>) => void;
}) {
  const [objective, setObjective] = useState<Objective>("mar");
  const [maxAvg, setMaxAvg] = useState("20");
  const [maxPeak, setMaxPeak] = useState("");
  const [maxDd, setMaxDd] = useState("");
  const [minPl, setMinPl] = useState("");
  const [maxPct, setMaxPct] = useState("20");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<{ runs: number } | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);

  async function run() {
    setResult(null);
    setRunning({ runs: 0 });
    const r = await optimize(
      trades,
      alloc,
      equity,
      {
        objective,
        include: strategies.filter((s) => !excluded.has(s)),
        maxAvgMargin: num(maxAvg) === null ? null : num(maxAvg)! / 100,
        maxPeakMargin: num(maxPeak) === null ? null : num(maxPeak)! / 100,
        maxDrawdown: num(maxDd) === null ? null : num(maxDd)! / 100,
        minPl: objective === "dd" ? (num(minPl) ?? baseline.pl) : null,
        maxPct: num(maxPct) ?? 20,
      },
      (runs) => setRunning({ runs }),
    );
    setRunning(null);
    setResult(r);
  }

  const rows: [string, (r: SimResult) => string][] = [
    ["P/L", (r) => money(r.pl, { sign: true })],
    ["CAGR", (r) => pct(r.cagr)],
    ["Max DD", (r) => pct(r.maxDdPct, 2)],
    ["MAR", (r) => n2(r.mar)],
    ["Sharpe", (r) => n2(r.sharpe)],
    ["Sortino", (r) => n2(r.sortino)],
    ["Avg margin", (r) => pct(r.avgMarginUtil)],
    ["Peak-day margin", (r) => pct(r.maxMarginUtil)],
  ];
  const field = "w-20 rounded border border-border bg-surface px-1.5 py-1 text-right text-ink";

  return (
    <div className="card space-y-4 p-4">
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="space-y-1">
          <span className="block text-xs text-muted">Optimize for</span>
          <select value={objective} onChange={(e) => setObjective(e.target.value as Objective)} className="rounded border border-border bg-surface px-2 py-1 text-ink">
            {OBJECTIVES.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted">Max avg margin used %</span>
          <input className={field} value={maxAvg} onChange={(e) => setMaxAvg(e.target.value)} placeholder="none" inputMode="decimal" />
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted">Max peak-day margin %</span>
          <input className={field} value={maxPeak} onChange={(e) => setMaxPeak(e.target.value)} placeholder="none" inputMode="decimal" />
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted">Max drawdown %</span>
          <input className={field} value={maxDd} onChange={(e) => setMaxDd(e.target.value)} placeholder="none" inputMode="decimal" />
        </label>
        {objective === "dd" && (
          <label className="space-y-1">
            <span className="block text-xs text-muted">Keep P/L at least $</span>
            <input className={`${field} w-28`} value={minPl} onChange={(e) => setMinPl(e.target.value)} placeholder={String(Math.round(baseline.pl))} inputMode="decimal" />
          </label>
        )}
        <label className="space-y-1">
          <span className="block text-xs text-muted">Max % per strategy</span>
          <input className={field} value={maxPct} onChange={(e) => setMaxPct(e.target.value)} inputMode="decimal" />
        </label>
        <button
          onClick={run}
          disabled={!!running}
          className="rounded-lg bg-accent px-4 py-1.5 font-semibold text-page disabled:opacity-60"
        >
          {running ? `Optimizing… ${running.runs} runs` : "Run optimization"}
        </button>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted">
          Every run starts from your OO settings on the uploaded log (not from the sliders or an earlier result). Unchecked strategies stay at
          their OO setting.
        </div>
        <div className="flex flex-wrap gap-2">
          {strategies.map((s) => {
            const on = !excluded.has(s);
            return (
              <label key={s} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${on ? "border-border text-ink" : "border-border/50 text-muted"}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setExcluded((x) => {
                      const n = new Set(x);
                      if (n.has(s)) n.delete(s);
                      else n.add(s);
                      return n;
                    })
                  }
                />
                {label(s)}
              </label>
            );
          })}
        </div>
      </div>

      {result && (
        <div className="space-y-3">
          {!result.feasible && (
            <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">
              No allocation met every limit — loosen the margin or drawdown limits and try again.
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-x-auto">
              <table className="data w-full text-sm">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>OO settings</th>
                    <th>Suggested</th>
                  </tr>
                </thead>
                <tbody>
                  {strategies.map((s) => {
                    const a = alloc[s]?.pct ?? 0;
                    const b = result.alloc[s]?.pct ?? 0;
                    return (
                      <tr key={s}>
                        <td className="whitespace-normal">{label(s)}</td>
                        <td>{a}%</td>
                        <td className={b > a ? "font-semibold text-gain" : b < a ? "font-semibold text-loss" : "text-ink-2"}>{b}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto">
              <table className="data w-full text-sm">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>OO settings</th>
                    <th>Suggested</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([k, f]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{f(baseline)}</td>
                      <td className="font-semibold">{f(result.result)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => onApply(result.alloc)} disabled={!result.feasible} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-page disabled:opacity-50">
              Apply to sliders
            </button>
            <button onClick={() => setResult(null)} className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2">
              Discard
            </button>
            <span className="text-xs text-muted">
              {result.runs} simulations. Tuned on this backtest window, so expect some overfitting — sanity-check before changing live sizing.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
