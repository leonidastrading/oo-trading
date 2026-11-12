"use client";

import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { optimizeBoosts, simulate, type Objective, type SimResult, type SimTrade, type StrategyAlloc, type StreakBoost } from "@/lib/allocSim";
import { money, plClass } from "./format";

const STORE = "allocSim.streakBoost.v1";
const AFTER = [1, 2, 3, 4, 5, 6] as const;
const MULTS = [2, 3, 4] as const;

interface Setting extends StreakBoost {
  on: boolean;
}
const DEFAULT: Setting = { on: false, kind: "stop", after: 2, mult: 2 };
const OBJECTIVES: { key: Objective; label: string }[] = [
  { key: "pl", label: "Net P/L" },
  { key: "cagr", label: "CAGR" },
  { key: "mar", label: "MAR" },
  { key: "sharpe", label: "Sharpe" },
  { key: "sortino", label: "Sortino" },
  { key: "dd", label: "Smallest drawdown (keep P/L)" },
];
type Triggers = "stop" | "loss" | "both";

const p1 = (f: number | null | undefined) => (f === null || f === undefined || !Number.isFinite(f) ? "—" : `${(f * 100).toFixed(1)}%`);
const n2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(2));
const compact = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}k`);
const dateLabel = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

/**
 * What-if: size a strategy up 2×/3×/4× after N stop-outs (or losses) in a row, until its next winner.
 * Re-runs the simulator with those rules on top of the current allocations and compares the result.
 */
export function StreakSizing({
  trades,
  alloc,
  equity,
  current,
  strategies,
  label,
}: {
  trades: SimTrade[];
  alloc: Record<string, StrategyAlloc>;
  equity: number;
  current: SimResult;
  strategies: string[];
  label: (s: string) => string;
}) {
  const [settings, setSettings] = useState<Record<string, Setting>>({});
  const [all, setAll] = useState<Omit<Setting, "on">>({ kind: "stop", after: 2, mult: 2 });
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = localStorage.getItem(STORE);
        if (raw) setSettings(JSON.parse(raw));
      } catch {}
    });
  }, []);
  const save = (next: Record<string, Setting>) => {
    setSettings(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {}
  };
  const get = (s: string): Setting => ({ ...DEFAULT, ...settings[s] });
  const set = (s: string, patch: Partial<Setting>) => save({ ...settings, [s]: { ...get(s), ...patch } });
  // Optimizer: best rule per strategy for the objective (allocations unchanged).
  const [objective, setObjective] = useState<Objective>("mar");
  const [triggers, setTriggers] = useState<Triggers>("both");
  const [ddLimit, setDdLimit] = useState("");
  const [peakCap, setPeakCap] = useState("35");
  const [avgCap, setAvgCap] = useState("");
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const v = JSON.parse(localStorage.getItem(STORE + ".opt") ?? "null");
        if (v) {
          if (typeof v.peakCap === "string") setPeakCap(v.peakCap);
          if (typeof v.avgCap === "string") setAvgCap(v.avgCap);
          if (typeof v.ddLimit === "string") setDdLimit(v.ddLimit);
        }
      } catch {}
    });
  }, []);
  const keepOpt = (patch: Record<string, string>) => {
    try {
      localStorage.setItem(STORE + ".opt", JSON.stringify({ peakCap, avgCap, ddLimit, ...patch }));
    } catch {}
  };
  const frac = (v: string) => (v.trim() && Number(v) > 0 ? Number(v) / 100 : null);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [optMsg, setOptMsg] = useState<string | null>(null);
  const [undo, setUndo] = useState<Record<string, Setting> | null>(null);
  const runOptimizer = async () => {
    const limit = Number(ddLimit);
    const before = settings;
    setOptMsg(null);
    setRunning({ done: 0, total: 1 });
    // Start from the current rules, so a second run refines the first.
    const startAlloc: Record<string, StrategyAlloc> = {};
    for (const [k, a] of Object.entries(alloc)) {
      const g = { ...DEFAULT, ...settings[k] };
      startAlloc[k] = g.on ? { ...a, boost: { kind: g.kind, after: g.after, mult: g.mult } } : { ...a, boost: undefined };
    }
    const r = await optimizeBoosts(
      trades,
      startAlloc,
      equity,
      {
        objective,
        kinds: triggers === "both" ? ["stop", "loss"] : [triggers],
        include: strategies.filter((s) => alloc[s]),
        maxDrawdown: ddLimit.trim() && limit > 0 ? limit / 100 : null,
        maxPeakMargin: frac(peakCap),
        maxAvgMargin: frac(avgCap),
        minPl: objective === "dd" ? current.pl : null,
      },
      (done, total) => setRunning({ done, total }),
    );
    const next: Record<string, Setting> = { ...settings };
    for (const [k, b] of Object.entries(r.boosts)) next[k] = b ? { ...b, on: true } : { ...get(k), on: false };
    save(next);
    setUndo(before);
    setRunning(null);
    const on = Object.values(r.boosts).filter(Boolean).length;
    setOptMsg(
      r.feasible
        ? `Best for ${OBJECTIVES.find((o) => o.key === objective)!.label}: ${on ? `${on} strateg${on === 1 ? "y" : "ies"} sized up` : "no streak rule beats normal sizing"} (${r.runs.toLocaleString()} runs).`
        : "No combination met the limits; showing the closest one.",
    );
  };
  const applyAll = (on: boolean) => save(Object.fromEntries(strategies.map((s) => [s, { ...all, on }])));

  const boostedAlloc = useMemo(() => {
    const out: Record<string, StrategyAlloc> = {};
    for (const [s, a] of Object.entries(alloc)) {
      const b = { ...DEFAULT, ...settings[s] };
      out[s] = b.on ? { ...a, boost: { kind: b.kind, after: b.after, mult: b.mult } } : a;
    }
    return out;
  }, [alloc, settings]);
  const anyOn = strategies.some((s) => get(s).on);
  const boosted = useMemo(() => simulate(trades, boostedAlloc, equity), [trades, boostedAlloc, equity]);

  const chart = useMemo(() => {
    const m = new Map<string, { date: string; current?: number; boosted?: number }>();
    for (const e of current.equity) m.set(e.date, { ...(m.get(e.date) ?? { date: e.date }), current: e.equity });
    for (const e of boosted.equity) m.set(e.date, { ...(m.get(e.date) ?? { date: e.date }), boosted: e.equity });
    const rows = [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
    // Carry each line across days only the other one traded.
    const out: { date: string; current: number; boosted: number }[] = [];
    for (const r of rows) {
      const prev = out[out.length - 1];
      out.push({ date: r.date, current: r.current ?? prev?.current ?? current.start, boosted: r.boosted ?? prev?.boosted ?? boosted.start });
    }
    return out;
  }, [current, boosted]);

  const byCur = new Map(current.strategies.map((r) => [r.strategy, r]));
  const byBoost = new Map(boosted.strategies.map((r) => [r.strategy, r]));
  const stats: { label: string; cur: string; boo: string; better: boolean | null }[] = [
    { label: "Net P/L", cur: money(current.pl), boo: money(boosted.pl), better: boosted.pl > current.pl },
    { label: "CAGR", cur: p1(current.cagr), boo: p1(boosted.cagr), better: (boosted.cagr ?? 0) > (current.cagr ?? 0) },
    { label: "Max drawdown", cur: p1(current.maxDdPct), boo: p1(boosted.maxDdPct), better: boosted.maxDdPct > current.maxDdPct },
    { label: "Max drawdown $", cur: money(current.maxDd), boo: money(boosted.maxDd), better: boosted.maxDd > current.maxDd },
    { label: "MAR", cur: n2(current.mar), boo: n2(boosted.mar), better: (boosted.mar ?? 0) > (current.mar ?? 0) },
    { label: "Sharpe", cur: n2(current.sharpe), boo: n2(boosted.sharpe), better: (boosted.sharpe ?? 0) > (current.sharpe ?? 0) },
    { label: "Sortino", cur: n2(current.sortino), boo: n2(boosted.sortino), better: (boosted.sortino ?? 0) > (current.sortino ?? 0) },
    { label: "Max margin day", cur: p1(current.maxMarginUtil), boo: p1(boosted.maxMarginUtil), better: boosted.maxMarginUtil < current.maxMarginUtil },
    { label: "Avg margin", cur: p1(current.avgMarginUtil), boo: p1(boosted.avgMarginUtil), better: boosted.avgMarginUtil < current.avgMarginUtil },
    { label: "Trades sized up", cur: "—", boo: boosted.boosted.toLocaleString(), better: null },
  ];
  const sel = "rounded-md border border-border bg-surface-2 px-1.5 py-1 text-sm";

  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-bold text-accent">Size up after a streak</h3>
        <span className="text-xs text-muted">what-if on top of the allocations above · each strategy on its own streaks</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-2">All strategies:</span>
        <select className={sel} value={all.kind} onChange={(e) => setAll({ ...all, kind: e.target.value as Setting["kind"] })} aria-label="Trigger for all">
          <option value="stop">stop-outs</option>
          <option value="loss">losses</option>
        </select>
        <span className="text-ink-2">after</span>
        <select className={sel} value={all.after} onChange={(e) => setAll({ ...all, after: Number(e.target.value) })} aria-label="After how many for all">
          {AFTER.map((n) => (
            <option key={n} value={n}>
              {n} in a row
            </option>
          ))}
        </select>
        <span className="text-ink-2">→</span>
        <select className={sel} value={all.mult} onChange={(e) => setAll({ ...all, mult: Number(e.target.value) })} aria-label="Size for all">
          {MULTS.map((m) => (
            <option key={m} value={m}>
              {m}× size
            </option>
          ))}
        </select>
        <button className="rounded-lg border border-border px-3 py-1 hover:bg-surface-2" onClick={() => applyAll(true)}>
          Apply to all
        </button>
        <button className="rounded-lg border border-border px-3 py-1 text-ink-2 hover:bg-surface-2" onClick={() => applyAll(false)}>
          Turn all off
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 p-2 text-sm">
        <span className="font-semibold text-ink-2">Optimize for</span>
        <select className={sel} value={objective} onChange={(e) => setObjective(e.target.value as Objective)} aria-label="Objective">
          {OBJECTIVES.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-ink-2">using</span>
        <select className={sel} value={triggers} onChange={(e) => setTriggers(e.target.value as Triggers)} aria-label="Triggers to try">
          <option value="both">stops or losses</option>
          <option value="stop">stop-outs only</option>
          <option value="loss">losses only</option>
        </select>
        <label className="flex items-center gap-1 text-ink-2">
          max DD
          <input
            className={`${sel} w-16`}
            inputMode="decimal"
            placeholder="none"
            value={ddLimit}
            onChange={(e) => {
              const v = e.target.value.replace(/[^\d.]/g, "");
              setDdLimit(v);
              keepOpt({ ddLimit: v });
            }}
            aria-label="Max drawdown limit in percent"
          />
          %
        </label>
        <label className="flex items-center gap-1 text-ink-2" title="Margin in use on the busiest day, as a share of the account">
          max margin
          <input
            className={`${sel} w-16`}
            inputMode="decimal"
            placeholder="none"
            value={peakCap}
            onChange={(e) => {
              const v = e.target.value.replace(/[^\d.]/g, "");
              setPeakCap(v);
              keepOpt({ peakCap: v });
            }}
            aria-label="Max margin on the busiest day in percent"
          />
          %
        </label>
        <label className="flex items-center gap-1 text-ink-2" title="Average day's peak margin, as a share of the account">
          avg margin
          <input
            className={`${sel} w-16`}
            inputMode="decimal"
            placeholder="none"
            value={avgCap}
            onChange={(e) => {
              const v = e.target.value.replace(/[^\d.]/g, "");
              setAvgCap(v);
              keepOpt({ avgCap: v });
            }}
            aria-label="Max average margin in percent"
          />
          %
        </label>
        <button
          className="rounded-lg bg-accent px-3 py-1 font-semibold text-page disabled:opacity-50"
          onClick={() => void runOptimizer()}
          disabled={!!running}
        >
          {running ? `Optimizing… ${Math.round((running.done / Math.max(running.total, 1)) * 100)}%` : "Optimize"}
        </button>
        {undo && !running && (
          <button
            className="rounded-lg border border-border px-3 py-1 text-ink-2 hover:bg-surface"
            onClick={() => {
              save(undo);
              setUndo(null);
              setOptMsg(null);
            }}
          >
            Undo
          </button>
        )}
        {optMsg && <span className="text-xs text-ink-2">{optMsg}</span>}
      </div>

      <div className="overflow-x-auto">
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>On</th>
              <th>After</th>
              <th>Size</th>
              <th>P/L now</th>
              <th>P/L sized up</th>
              <th>Change</th>
              <th>Max DD now → sized up</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => {
              const g = get(s);
              const c = byCur.get(s);
              const b = byBoost.get(s);
              const d = (b?.pl ?? 0) - (c?.pl ?? 0);
              return (
                <tr key={s} className={g.on ? "" : "opacity-60"}>
                  <td className="whitespace-normal" title={s}>
                    {label(s)}
                  </td>
                  <td>
                    <input type="checkbox" checked={g.on} onChange={(e) => set(s, { on: e.target.checked })} aria-label={`Size up ${label(s)}`} />
                  </td>
                  <td className="whitespace-nowrap">
                    <select className={sel} value={g.after} onChange={(e) => set(s, { after: Number(e.target.value) })} aria-label="After how many">
                      {AFTER.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>{" "}
                    <select className={sel} value={g.kind} onChange={(e) => set(s, { kind: e.target.value as Setting["kind"] })} aria-label="Trigger">
                      <option value="stop">stops</option>
                      <option value="loss">losses</option>
                    </select>
                  </td>
                  <td>
                    <select className={sel} value={g.mult} onChange={(e) => set(s, { mult: Number(e.target.value) })} aria-label="Size">
                      {MULTS.map((m) => (
                        <option key={m} value={m}>
                          {m}×
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={`num ${plClass(c?.pl ?? 0)}`}>{money(c?.pl ?? 0)}</td>
                  <td className={`num ${plClass(b?.pl ?? 0)}`}>{g.on ? money(b?.pl ?? 0) : "—"}</td>
                  <td className={`num font-semibold ${plClass(d)}`}>{g.on ? money(d, { sign: true }) : "—"}</td>
                  <td className="num whitespace-nowrap">
                    {money(c?.maxDd ?? 0)}
                    {g.on && (
                      <>
                        {" → "}
                        <span className={(b?.maxDd ?? 0) < (c?.maxDd ?? 0) ? "text-loss" : "text-gain"}>{money(b?.maxDd ?? 0)}</span>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {anyOn ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {stats.map((x) => (
              <div key={x.label} className="rounded-xl bg-surface-2 p-3">
                <div className="text-xs text-muted">{x.label}</div>
                <div className={`mt-0.5 text-lg font-bold leading-tight ${x.better === null ? "" : x.better ? "text-gain" : "text-loss"}`}>{x.boo}</div>
                <div className="text-xs text-ink-2">now {x.cur}</div>
              </div>
            ))}
          </div>
          <div className="h-64 w-full md:h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                <CartesianGrid stroke="var(--axis)" strokeOpacity={0.25} vertical={false} />
                <XAxis dataKey="date" tickFormatter={dateLabel} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--axis)" }} minTickGap={40} />
                <YAxis tickFormatter={compact} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={56} domain={["auto", "auto"]} />
                <Tooltip
                  contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "var(--ink-2)" }}
                  formatter={(v, n) => [money(Number(v)), n === "boosted" ? "Sized up" : "Now"]}
                />
                <Legend formatter={(v) => (v === "boosted" ? "Sized up after streaks" : "Current allocations")} wrapperStyle={{ fontSize: 12 }} />
                <Line dataKey="current" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                <Line dataKey="boosted" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted">Turn a strategy on (or use Apply to all) to see the new equity curve and stats.</p>
      )}

      <p className="text-xs text-muted">
        Per strategy: once it has N stop-outs (or N losses) in a row, each of its next trades is sized 2×/3×/4× its normal size, until one of
        them is a winner (P/L ≥ 0); then it goes back to normal size. With &quot;stops&quot;, a loss that wasn&apos;t a stop-out doesn&apos;t
        break or extend the streak. Streaks count closed trades only, so a trade opened while the previous one is still open isn&apos;t sized
        on it. Margin isn&apos;t limited: sized-up trades always fill. Optimize tries, for each strategy in turn, off or every
        trigger × 1–6 in a row × 2–4× (keeping the other strategies&apos; rules), repeating until nothing improves; allocations stay as
        they are. &quot;Smallest drawdown&quot; keeps net P/L at least today&apos;s. Max margin caps the busiest day&apos;s margin (all open
        trades&apos; worst-case risk vs. that morning&apos;s equity) and avg margin the average day&apos;s; leave a box empty for no limit.
      </p>
    </section>
  );
}
