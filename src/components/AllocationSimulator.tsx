"use client";

import { useEffect, useMemo, useState } from "react";
import { Area, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { impliedAllocations, portfolioAlloc, simulate, toSimTrades, type StrategyAlloc } from "@/lib/allocSim";
import type { OOTrade } from "@/lib/ooCsv";
import { addDays, todayET } from "@/lib/time";
import { money, plClass } from "./format";
import { OptimizerPanel } from "./OptimizerPanel";

const RANGES = [
  { label: "All", from: () => "" },
  { label: "YTD", from: () => `${todayET().slice(0, 4)}-01-01` },
  { label: "1Y", from: () => addDays(todayET(), -365) },
  { label: "6M", from: () => addDays(todayET(), -182) },
] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STORE = "allocSim.v1";

const p1 = (f: number | null | undefined, d = 1) => (f === null || f === undefined || !Number.isFinite(f) ? "—" : `${(f * 100).toFixed(d)}%`);
const sp = (f: number | null | undefined, d = 1) =>
  f === null || f === undefined || !Number.isFinite(f) ? "—" : `${f >= 0 ? "+" : "−"}${Math.abs(f * 100).toFixed(d)}%`;
const n2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(2));
const shortName = (s: string) => s.replace(/^[!\s]+/, "").replace(/^SPX\s+/, "");
const compact = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}k`);

interface Saved {
  equity: number;
  range: number;
  alloc: Record<string, StrategyAlloc>;
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-bold leading-tight md:text-xl ${tone ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

export function AllocationSimulator({ trades, colorOf }: { trades: OOTrade[]; colorOf: (s: string) => string }) {
  const strategies = useMemo(() => [...new Set(trades.map((t) => t.strategy.trim()))].sort(), [trades]);
  // Your Schwab Port 2026 settings where the strategy is known; otherwise the sizing read from the log.
  const defaults = useMemo(() => {
    const implied = impliedAllocations(trades);
    return Object.fromEntries(strategies.map((s) => [s, portfolioAlloc(s) ?? implied[s] ?? { pct: 1 }]));
  }, [trades, strategies]);
  const [equity, setEquity] = useState(1_000_000);
  const [range, setRange] = useState(0);
  const [alloc, setAlloc] = useState<Record<string, StrategyAlloc>>({});

  // Restore this device's last settings after hydration.
  useEffect(() => {
    void Promise.resolve().then(() => {
      const s = load();
      if (!s) return;
      setEquity(s.equity > 0 ? s.equity : 1_000_000);
      setRange(s.range >= 0 && s.range < RANGES.length ? s.range : 0);
      setAlloc(s.alloc ?? {});
    });
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ equity, range, alloc } satisfies Saved));
    } catch {}
  }, [equity, range, alloc]);

  const effective = useMemo(() => {
    const out: Record<string, StrategyAlloc> = {};
    for (const s of strategies) out[s] = alloc[s] ?? defaults[s] ?? { pct: 1 };
    return out;
  }, [strategies, alloc, defaults]);

  const simTrades = useMemo(() => {
    const from = RANGES[range].from();
    return toSimTrades(trades.filter((t) => t.dateOpened >= from));
  }, [trades, range]);
  const sim = useMemo(() => simulate(simTrades, effective, equity), [simTrades, effective, equity]);
  // Reference run on the uploaded log at the OO settings (independent of the sliders).
  const baselineSim = useMemo(() => simulate(simTrades, defaults, equity), [simTrades, defaults, equity]);
  const [showOpt, setShowOpt] = useState(false);
  // The backtest's own starting funds (first trade's funds at close minus its P/L), to compare with OO 1:1.
  const ooStart = useMemo(() => {
    const first = [...trades].filter((t) => t.fundsAtClose !== null && t.source).sort((a, b) => `${a.dateClosed}${a.timeClosed}`.localeCompare(`${b.dateClosed}${b.timeClosed}`))[0];
    return first ? Math.round((first.fundsAtClose! - first.pl) / 1000) * 1000 : null;
  }, [trades]);

  const set = (s: string, patch: Partial<StrategyAlloc>) => setAlloc((a) => ({ ...a, [s]: { ...effective[s], ...patch } }));
  const ddFloor = Math.min(-0.005, ...sim.equity.map((e) => e.dd));
  const byName = new Map(sim.strategies.map((r) => [r.strategy, r]));
  const years = [...new Set(sim.months.map((m) => m.month.slice(0, 4)))].sort().reverse();
  const monthMap = new Map(sim.months.map((m) => [m.month, m]));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-accent">Allocation simulator</h2>
          <p className="text-xs text-muted">
            Re-sizes every backtest trade from each strategy&apos;s allocation (% of current equity per trade, sized on OO&apos;s margin per contract),
            compounding as trades close. Sliders start at your Schwab Port 2026 settings in Option Omega.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-ink-2">Starting equity</span>
            <input
              type="number"
              min={1000}
              step={10000}
              value={equity}
              onChange={(e) => setEquity(Math.max(1000, Number(e.target.value) || 0))}
              className="w-32 rounded-lg border border-border bg-surface px-2 py-1 text-ink"
            />
          </label>
          {ooStart && ooStart !== equity && (
            <button onClick={() => setEquity(ooStart)} className="text-xs text-link underline" title="Start where the OO backtest started, to compare 1:1">
              Use OO&apos;s {money(ooStart)}
            </button>
          )}
          <div className="flex rounded-lg border border-border" role="group" aria-label="Date range">
            {RANGES.map((r, i) => (
              <button key={r.label} onClick={() => setRange(i)} aria-pressed={i === range} className={`px-2.5 py-1 ${i === range ? "bg-surface-2 text-ink" : "text-muted"}`}>
                {r.label}
              </button>
            ))}
          </div>
          <button onClick={() => setShowOpt((v) => !v)} aria-expanded={showOpt} className="rounded-lg border border-accent/60 px-3 py-1 text-accent hover:bg-surface-2">
            {showOpt ? "Hide optimizer" : "Optimize…"}
          </button>
          <button onClick={() => setAlloc({})} className="rounded-lg border border-border px-3 py-1 text-ink-2 hover:bg-surface-2">
            Reset to my OO settings
          </button>
        </div>
      </div>


      {showOpt && (
        <OptimizerPanel
          key={`${range}|${equity}|${trades.length}`}
          trades={simTrades}
          alloc={defaults}
          equity={equity}
          baseline={baselineSim}
          strategies={strategies}
          label={shortName}
          onApply={(a) => setAlloc(a)}
        />
      )}

      {sim.equity.length > 1 && (
        <div className="card h-96 p-3 md:h-[28rem]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={sim.equity} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--axis)" }} minTickGap={40} />
              <YAxis yAxisId="eq" tickFormatter={compact} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={56} domain={["auto", "auto"]} />
              {/* Drawdown on its own axis, zero a quarter of the way up so the red spikes hang along the bottom. */}
              <YAxis
                yAxisId="dd"
                orientation="right"
                tickFormatter={(v: number) => (v < 0 ? `${(v * 100).toFixed(1)}%` : "")}
                tick={{ fill: "var(--loss)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={44}
                domain={[ddFloor, -ddFloor * 3]}
                ticks={[ddFloor, ddFloor / 2, 0]}
              />
              <ReferenceLine yAxisId="dd" y={0} stroke="var(--axis)" strokeDasharray="2 3" />
              <Tooltip
                contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "var(--ink-2)" }}
                itemStyle={{ color: "var(--ink)" }}
                formatter={(v, name) => (name === "dd" ? [sp(Number(v), 2), "Drawdown"] : [money(Number(v)), "Equity"])}
              />
              <Area yAxisId="dd" type="linear" dataKey="dd" stroke="var(--loss)" strokeWidth={1} fill="var(--loss)" fillOpacity={0.35} isAnimationActive={false} />
              <Area yAxisId="eq" type="monotone" dataKey="equity" stroke="var(--spot)" strokeWidth={2} fill="var(--spot)" fillOpacity={0.12} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="P/L" value={money(sim.pl, { sign: true })} sub={`${sp(sim.start ? sim.pl / sim.start : null)} · ends ${money(sim.end)}`} tone={plClass(sim.pl)} />
        <Stat label="CAGR" value={p1(sim.cagr)} sub={sim.firstDate ? `${sim.firstDate} → ${sim.lastDate}` : undefined} />
        <Stat label="Max drawdown (realized)" value={p1(sim.maxDdPct, 2)} sub={money(sim.maxDd)} tone="text-loss" />
        <Stat label="MAR" value={n2(sim.mar)} />
        <Stat label="Sharpe / Sortino" value={`${n2(sim.sharpe)} / ${n2(sim.sortino)}`} />
        <Stat label="Avg days to new high" value={sim.avgDaysToRecover === null ? "—" : sim.avgDaysToRecover.toFixed(1)} sub="after a drawdown" />
        <Stat label="Win rate" value={p1(sim.winPct)} sub={`${sim.trades.toLocaleString()} trades`} />
        <Stat label="Profit factor" value={n2(sim.profitFactor)} />
        <Stat label="Reward / risk" value={n2(sim.riskReward)} sub="avg win ÷ avg loss" />
        <Stat label="Premium capture" value={p1(sim.captureRate)} />
        <Stat label="Account peak" value={money(sim.peak)} />
        <Stat label="Margin used" value={`${p1(sim.avgMarginUtil)} avg`} sub={`${p1(sim.maxMarginUtil)} max day`} />
      </div>

      <div className="card overflow-x-auto">
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Strategy</th>
              <th className="min-w-[12rem]">Allocation / trade</th>
              <th>Max ct</th>
              <th>Trades</th>
              <th>% trades</th>
              <th>Avg size</th>
              <th>P/L</th>
              <th>Contribution</th>
              <th>Win %</th>
              <th>PF</th>
              <th>R/R</th>
              <th>Max DD $</th>
              <th>Max DD %</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => {
              const a = effective[s];
              const r = byName.get(s);
              // 0–20% covers normal sizing; a capped add-on (100% × 1 contract) gets the full 0–100%.
              const max = (defaults[s]?.pct ?? 0) > 20 ? 100 : 20;
              return (
                <tr key={s} className={a.pct > 0 ? undefined : "opacity-50"}>
                  <td className="min-w-[12rem] whitespace-normal">
                    <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: colorOf(s) }} />
                    <span title={s}>{shortName(s)}</span>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={max}
                        step={0.05}
                        value={Math.min(a.pct, max)}
                        onChange={(e) => set(s, { pct: Number(e.target.value) })}
                        aria-label={`${shortName(s)} allocation`}
                        className="w-28 accent-[var(--accent)]"
                      />
                      <input
                        type="number"
                        min={0}
                        step={0.05}
                        value={a.pct}
                        max={100}
                        onChange={(e) => set(s, { pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
                        className="w-16 rounded border border-border bg-surface px-1 py-0.5 text-right text-ink"
                      />
                      <span className="text-muted">%</span>
                    </div>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      placeholder="—"
                      value={a.maxContracts ?? ""}
                      onChange={(e) => set(s, { maxContracts: e.target.value === "" ? undefined : Math.max(0, Math.round(Number(e.target.value))) })}
                      className="w-14 rounded border border-border bg-surface px-1 py-0.5 text-right text-ink"
                      aria-label={`${shortName(s)} max contracts`}
                    />
                  </td>
                  <td>{r?.trades ?? 0}</td>
                  <td>{p1(r?.tradeShare)}</td>
                  <td>{r ? r.avgContracts.toFixed(1) : "—"}</td>
                  <td className={plClass(r?.pl)}>{money(r?.pl ?? 0, { sign: true })}</td>
                  <td>{p1(r?.contribution)}</td>
                  <td>{p1(r?.winPct)}</td>
                  <td>{n2(r?.profitFactor)}</td>
                  <td>{n2(r?.riskReward)}</td>
                  <td className="text-loss">{r ? money(r.maxDd) : "—"}</td>
                  <td className="text-loss">{p1(r?.maxDdPct, 2)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border font-semibold">
              <td>Total</td>
              <td>
                {strategies
                  .filter((s) => !(effective[s].maxContracts && effective[s].pct >= 100))
                  .reduce((t, s) => t + effective[s].pct, 0)
                  .toFixed(2)}
                % <span className="text-xs font-normal text-muted">per-trade allocations{strategies.some((s) => effective[s].maxContracts && effective[s].pct >= 100) ? " (+ add-on)" : ""}</span>
              </td>
              <td />
              <td>{sim.trades.toLocaleString()}</td>
              <td>{sim.trades ? "100%" : "—"}</td>
              <td>{sim.trades ? (sim.strategies.reduce((t, r) => t + r.avgContracts * r.trades, 0) / sim.trades).toFixed(1) : "—"}</td>
              <td className={plClass(sim.pl)}>{money(sim.pl, { sign: true })}</td>
              <td>{sim.trades ? "100%" : "—"}</td>
              <td>{p1(sim.winPct)}</td>
              <td>{n2(sim.profitFactor)}</td>
              <td>{n2(sim.riskReward)}</td>
              <td className="text-loss" title="Whole account">{money(sim.maxDd)}</td>
              <td className="text-loss" title="Whole account">{p1(sim.maxDdPct, 2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div>
        <h3 className="mb-2 font-bold text-accent">Monthly P/L</h3>
        <div className="card overflow-x-auto">
          <table className="data w-full text-sm">
            <thead>
              <tr>
                <th>Year</th>
                {MONTHS.map((m) => (
                  <th key={m}>{m}</th>
                ))}
                <th>Year</th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => {
                const ms = sim.months.filter((m) => m.month.startsWith(y));
                const total = ms.reduce((s, m) => s + m.pl, 0);
                const startEq = (() => {
                  const first = ms[0];
                  return first ? first.pl / (first.pct || Infinity) : null;
                })();
                return (
                  <tr key={y}>
                    <td className="font-semibold">{y}</td>
                    {MONTHS.map((_, i) => {
                      const m = monthMap.get(`${y}-${String(i + 1).padStart(2, "0")}`);
                      return (
                        <td key={i} className={m ? plClass(m.pl) : "text-muted"}>
                          {m ? (
                            <>
                              <span className="whitespace-nowrap">{compactSigned(m.pl)}</span>
                              <span className="block text-xs opacity-80">{sp(m.pct)}</span>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      );
                    })}
                    <td className={`font-semibold ${plClass(total)}`}>
                      <span className="whitespace-nowrap">{compactSigned(total)}</span>
                      <span className="block text-xs opacity-80">{startEq ? sp(total / startEq) : ""}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          Monthly % is of equity at the start of the month. Drawdowns are on realized (closed-trade) equity. Sharpe/Sortino use daily returns over
          weekdays, annualized ×√252, 0% risk-free (OO subtracts a T-bill rate, so its Sharpe/Sortino read a little lower).
          Sizing rounds down to whole contracts and add-ons are fixed at 1 contract, so a different starting equity changes the mix — use OO&apos;s
          starting equity to match its report. Margin used = each day&apos;s peak margin held ÷ that morning&apos;s equity. Risk per contract is
          OO&apos;s Margin Req. when the log has it, else the structure&apos;s max loss from its legs.
        </p>
      </div>
    </section>
  );
}

function compactSigned(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1000 ? `$${(a / 1000).toFixed(1)}k` : `$${Math.round(a)}`;
  return `${v < 0 ? "−" : "+"}${s}`;
}
