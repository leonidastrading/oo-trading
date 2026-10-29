"use client";

import { useEffect, useState } from "react";
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

const STORE = "optimizer.v1";
interface Saved {
  objective: Objective;
  maxAvg: string;
  maxPeak: string;
  maxDd: string;
  minPl: string;
  maxPct: string;
  maxLots?: string;
  excluded: string[];
}

const pct = (f: number | null | undefined, d = 1) => (f === null || f === undefined || !Number.isFinite(f) ? "—" : `${(f * 100).toFixed(d)}%`);
const n2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(2));
const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));

export function OptimizerPanel({
  trades,
  alloc,
  equity,
  baseline,
  unit = "pct",
  doubled,
  onToggleDouble,
  strategies,
  label,
  onApply,
}: {
  trades: SimTrade[];
  /** Starting point for every run: the uploaded log's settings, never the sliders (which may hold an earlier result). */
  alloc: Record<string, StrategyAlloc>;
  equity: number;
  baseline: SimResult;
  /** "pct": allocations are % of equity; "lots": fixed contracts per trade. */
  unit?: "pct" | "lots";
  /** Strategies whose next trade after a stop-out is doubled (applies to every simulation). */
  doubled: Set<string>;
  onToggleDouble: (s: string) => void;
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
  const [maxLots, setMaxLots] = useState("50");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState<{ runs: number } | null>(null);
  const [restored, setRestored] = useState(false);

  // Remember these inputs on this device (restored after hydration; storage may be blocked).
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as Saved | null;
        if (v) {
          if (OBJECTIVES.some((o) => o.key === v.objective)) setObjective(v.objective);
          setMaxAvg(v.maxAvg ?? "20");
          setMaxPeak(v.maxPeak ?? "");
          setMaxDd(v.maxDd ?? "");
          setMinPl(v.minPl ?? "");
          setMaxPct(v.maxPct ?? "20");
          setMaxLots(v.maxLots ?? "50");
          setExcluded(new Set(v.excluded ?? []));
        }
      } catch {}
      setRestored(true);
    });
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      const v: Saved = { objective, maxAvg, maxPeak, maxDd, minPl, maxPct, maxLots, excluded: [...excluded] };
      localStorage.setItem(STORE, JSON.stringify(v));
    } catch {}
  }, [restored, objective, maxAvg, maxPeak, maxDd, minPl, maxPct, maxLots, excluded]);
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
        maxLots: num(maxLots) ?? 50,
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
        {unit === "lots" ? (
          <label className="space-y-1">
            <span className="block text-xs text-muted">Max lots per strategy</span>
            <input className={field} value={maxLots} onChange={(e) => setMaxLots(e.target.value)} inputMode="numeric" />
          </label>
        ) : (
          <label className="space-y-1">
            <span className="block text-xs text-muted">Max % per strategy</span>
            <input className={field} value={maxPct} onChange={(e) => setMaxPct(e.target.value)} inputMode="decimal" />
          </label>
        )}
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
          {unit === "lots"
            ? "Every run starts from 1 lot of each strategy (per-contract P/L; the log's sizing is ignored). Unchecked strategies stay at 1 lot."
            : "Every run starts from your OO settings on the uploaded log (not from the sliders or an earlier result). Unchecked strategies stay at their OO setting."}{" "}
          “2× after stop” doubles that strategy&apos;s very next trade after an OO stop loss — it applies to the sliders, the reference and the
          optimizer alike.
        </div>
        <div className="flex flex-wrap gap-2">
          {strategies.map((s) => {
            const on = !excluded.has(s);
            return (
              <div key={s} className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${on ? "border-border text-ink" : "border-border/50 text-muted"}`}>
                <label className="flex cursor-pointer items-center gap-1.5">
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
                <label className="flex cursor-pointer items-center gap-1 border-l border-border pl-2 text-loss" title="Double the very next trade after a stop-out">
                  <input type="checkbox" checked={doubled.has(s)} onChange={() => onToggleDouble(s)} />
                  2× after stop
                </label>
              </div>
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
                    <th>{unit === "lots" ? "1 lot each" : "OO settings"}</th>
                    <th>Suggested</th>
                  </tr>
                </thead>
                <tbody>
                  {strategies.map((s) => {
                    const lotsMode = unit === "lots";
                    const a = (lotsMode ? alloc[s]?.fixed : alloc[s]?.pct) ?? 0;
                    const b = (lotsMode ? result.alloc[s]?.fixed : result.alloc[s]?.pct) ?? 0;
                    const fmt = (v: number) => (lotsMode ? `${v} lot${v === 1 ? "" : "s"}` : `${v}%`);
                    return (
                      <tr key={s}>
                        <td className="whitespace-normal">{label(s)}</td>
                        <td>{fmt(a)}</td>
                        <td className={b > a ? "font-semibold text-gain" : b < a ? "font-semibold text-loss" : "text-ink-2"}>{fmt(b)}</td>
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
                    <th>{unit === "lots" ? "1 lot each" : "OO settings"}</th>
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
