"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GaugeData } from "@/app/api/gauge/route";
import { REFERENCE, TOOLTIP, WING_BANDS } from "@/lib/gauge";
import { usePoll } from "./usePoll";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const f2 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));
const f3 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(3));
const CHIP = {
  green: "bg-gain/20 text-gain",
  amber: "bg-warn/20 text-warn",
  red: "bg-loss/20 text-loss",
} as const;
/** Month cell shade: blue below 1.0 (sellers paid), red above. */
const monthShade = (v: number) =>
  v < 1 ? `rgba(57, 135, 229, ${Math.min(0.55, (1 - v) * 1.4)})` : `rgba(230, 103, 103, ${Math.min(0.6, (v - 1) * 1.6)})`;

function Ref({ y, label }: { y: number; label: string }) {
  return <ReferenceLine y={y} stroke="var(--ink-2)" strokeDasharray="3 4" strokeOpacity={0.6} label={{ value: label, position: "right", fill: "var(--muted)", fontSize: 10 }} />;
}

export function GaugePanel() {
  const { data } = usePoll<GaugeData>("/api/gauge");
  if (!data) return null;
  const t = data.today;
  const years = [...new Set(Object.keys(data.months).map((m) => m.slice(0, 4)))].sort().reverse();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthNow = data.months[thisMonth];

  return (
    <section className="card space-y-4 p-4 md:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-accent" title={TOOLTIP}>
          0DTE premium gauge <span className="cursor-help text-sm text-muted">ⓘ</span>
        </h2>
        <span className="text-xs text-muted">10:00 ATM SPXW straddle vs |4:00 close − strike|</span>
      </header>
      <p className="text-xs text-muted">{TOOLTIP}</p>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
        <div className="rounded-xl bg-surface-2 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Today</div>
          {t && t.status !== "skipped" && t.status !== "error" ? (
            <>
              <div className="mt-1 text-2xl font-bold">
                {f2(t.straddle)} <span className="text-sm font-normal text-ink-2">pts</span>
              </div>
              <div className="text-sm text-ink-2">
                {f2(t.straddle_pct)}% of SPX · K {t.K}
              </div>
              {t.status === "closed" && (
                <div className="text-sm">
                  move {f2(t.move)} → ratio <span className={`font-semibold ${t.ratio! < 1 ? "text-gain" : "text-loss"}`}>{f2(t.ratio)}</span>
                </div>
              )}
            </>
          ) : (
            <div className="mt-1 text-sm text-ink-2">{t ? `${t.status}: ${t.reason ?? ""}` : "Snapshot at 10:00 ET"}</div>
          )}
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">20-day mean</div>
          {data.mean20 ? (
            <div className="mt-1 text-2xl font-bold">{f3(data.mean20.mean)}</div>
          ) : (
            <div className="mt-1 text-sm text-ink-2">needs 15 days · have {data.validDays}</div>
          )}
          <div className="text-xs text-muted">median {REFERENCE.d20.median} · p95 {REFERENCE.d20.p95}</div>
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">60-day mean</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-2xl font-bold">{f3(data.mean60?.mean ?? data.chip.value)}</span>
            <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${CHIP[data.chip.status]}`}>{data.chip.status}</span>
          </div>
          <div className="text-xs text-muted">
            {data.mean60 ? `${data.mean60.days} days` : `last carried-over reading · live from 40 days (have ${data.validDays})`}
          </div>
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">This month</div>
          <div className="mt-1 text-2xl font-bold">{f3(monthNow?.mean)}</div>
          <div className="text-xs text-muted">{monthNow?.days ? `${monthNow.days} live days` : "no live days yet"}</div>
        </div>
      </div>

      <div>
        <div className="mb-1 text-sm font-semibold text-ink-2">60-day mean of the ratio</div>
        <div className="h-48 w-full md:h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.series} margin={{ top: 8, right: 48, bottom: 0, left: 4 }}>
              <CartesianGrid stroke="var(--axis)" strokeOpacity={0.25} vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "var(--axis)" }} minTickGap={30} />
              <YAxis domain={[0.8, 1.2]} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
              <Ref y={REFERENCE.d60.p5} label="p5" />
              <Ref y={REFERENCE.d60.median} label="median" />
              <Ref y={REFERENCE.d60.p95} label="p95" />
              <Ref y={REFERENCE.d60.p99} label="p99" />
              <Tooltip
                contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "var(--ink-2)" }}
                formatter={(v, _n, item) => [Number(v).toFixed(3), item.payload.seed ? "60-day mean (history)" : "60-day mean"]}
              />
              <Line type="monotone" dataKey="value" stroke="var(--spot)" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div className="mb-1 text-sm font-semibold text-ink-2">Monthly mean ratio</div>
        <table className="data w-full text-xs">
          <thead>
            <tr>
              <th>Year</th>
              {MONTHS.map((m) => (
                <th key={m}>{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y}>
                <td>{y}</td>
                {MONTHS.map((_, i) => {
                  const m = data.months[`${y}-${String(i + 1).padStart(2, "0")}`];
                  return (
                    <td key={i} className="num" style={{ background: m ? monthShade(m.mean) : undefined }} title={m?.days ? `${m.days} live days` : m ? "history" : undefined}>
                      {m ? m.mean.toFixed(2) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl bg-surface-2 p-3 text-sm">
        <span className="font-semibold text-ink-2">10-delta put wing</span>{" "}
        {data.wing ? (
          <>
            — 60-day premium kept <span className="num font-semibold">{data.wing.kept.toFixed(2)}</span> ({data.wing.days} days)
          </>
        ) : (
          <span className="text-muted">— builds from the daily snapshots</span>
        )}
        <div className="text-xs text-muted">
          History May 2022 – Nov 2026: p5 {WING_BANDS.p5} · p25 {WING_BANDS.p25} · median {WING_BANDS.median} · p75 {WING_BANDS.p75} · p95{" "}
          {WING_BANDS.p95}; below zero {Math.round(WING_BANDS.belowZero * 100)}% of the time. Nov 6, 2026: −0.55. Much noisier than the ratio —
          context only.
        </div>
      </div>

      <p className="text-xs text-muted">
        Chip on the 60-day mean: green below {REFERENCE.d60p75} (its 75th percentile), amber {REFERENCE.d60p75}–{REFERENCE.d60.p95}, red above{" "}
        {REFERENCE.d60.p95} or when the last three month-end readings are all above 1.0. This gauge did not track the book&apos;s monthly
        P/L in 2023–26 (rank correlation ≈ 0): it&apos;s a structural alarm for the whole 0DTE market, not a timing signal.
        {data.meta.errors.length > 0 && <span className="block text-loss">{data.meta.errors.join(" · ")}</span>}
      </p>
    </section>
  );
}
