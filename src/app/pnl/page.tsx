"use client";

import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { money, plClass } from "@/components/format";
import { Tile, toneOf } from "@/components/Tile";
import { usePoll } from "@/components/usePoll";
import type { PnlData } from "@/app/api/pnl/route";

const signedPct = (f: number | null | undefined) =>
  f === null || f === undefined || !Number.isFinite(f) ? "—" : `${f >= 0 ? "+" : "−"}${Math.abs(f * 100).toFixed(2)}%`;

const weekLabel = (monday: string, end: string) => {
  const fmt = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${fmt(monday)} – ${fmt(end)}`;
};

const compact = (v: number) =>
  Math.abs(v) >= 1000 ? `${v < 0 ? "−" : ""}$${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : money(v);

export default function PnlPage() {
  const { data, error, loading, refresh } = usePoll<PnlData>("/api/pnl");
  const weeks = data?.weeks ?? [];
  const current = weeks.find((w) => w.current);
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  const totalPl = weeks.reduce((s, w) => s + w.pl, 0);
  const totalPct = first && first.startEquity > 0 ? totalPl / first.startEquity : null;
  const hasTransfers = weeks.some((w) => w.transfers !== 0);
  const anyEstimated = weeks.some((w) => w.estimated);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink/60 pb-3">
        <h1 className="text-2xl font-bold">P/L by week{data?.account ? ` · ••${data.account}` : ""}</h1>
        <button onClick={refresh} className="rounded-lg border border-border px-3 py-1 text-sm text-ink hover:bg-surface-2">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {(error || data?.meta.errors.length) && (
        <p className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error ?? data?.meta.errors.join(" · ")}</p>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Total equity" value={money(data?.netLiq ?? last?.endEquity)} sub="Schwab net liquidation" />
        <Tile
          label="This week"
          value={money(current?.pl, { sign: true })}
          tone={toneOf(current?.pl)}
          sub={current ? signedPct(current.plPct) : "no trading yet"}
        />
        <Tile
          label={first ? `Since ${weekLabel(first.week, first.week).split(" – ")[0]}` : "Since start"}
          value={money(weeks.length ? totalPl : null, { sign: true })}
          tone={toneOf(totalPl)}
          sub={signedPct(totalPct)}
        />
        <Tile
          label="Weeks up / down"
          value={`${weeks.filter((w) => w.pl > 0).length} / ${weeks.filter((w) => w.pl < 0).length}`}
          sub={weeks.length ? `best ${money(Math.max(...weeks.map((w) => w.pl)), { sign: true })}` : undefined}
        />
      </section>

      {weeks.length > 0 && (
        <section className="card p-4 md:p-5">
          <h2 className="mb-2 text-lg font-bold text-accent">Weekly P/L</h2>
          <div className="h-56 w-full md:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weeks} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
                <XAxis
                  dataKey="week"
                  tickFormatter={(w: string) => weekLabel(w, w).split(" – ")[0]}
                  tick={{ fill: "var(--muted)", fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--axis)" }}
                />
                <YAxis tickFormatter={compact} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
                <ReferenceLine y={0} stroke="var(--axis)" />
                <Tooltip
                  cursor={{ fill: "var(--surface-2)" }}
                  contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: "var(--ink-2)" }}
                  labelFormatter={(w) => {
                    const r = weeks.find((x) => x.week === w);
                    return r ? `Week of ${weekLabel(r.week, r.end)}` : String(w);
                  }}
                  formatter={(v, _n, item) => [`${money(Number(v), { sign: true })} (${signedPct(item.payload.plPct)})`, "P/L"]}
                />
                <Bar dataKey="pl" radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false}>
                  {weeks.map((w) => (
                    <Cell key={w.week} fill={w.pl >= 0 ? "var(--gain)" : "var(--loss)"} fillOpacity={w.current ? 0.55 : 1} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className="card overflow-x-auto">
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Week</th>
              <th>Start equity</th>
              <th>End equity</th>
              {hasTransfers && <th>Deposits / withdrawals</th>}
              <th>P/L $</th>
              <th>P/L %</th>
            </tr>
          </thead>
          <tbody>
            {[...weeks].reverse().map((w) => (
              <tr key={w.week}>
                <td className="whitespace-nowrap">
                  {weekLabel(w.week, w.end)}
                  {w.current && <span className="ml-2 text-xs text-spot">● this week</span>}
                  {w.estimated && <span className="ml-1 text-xs text-muted">*</span>}
                </td>
                <td className="num">{money(w.startEquity)}</td>
                <td className="num">{money(w.endEquity)}</td>
                {hasTransfers && <td className="num">{w.transfers ? money(w.transfers, { sign: true }) : "—"}</td>}
                <td className={plClass(w.pl)}>{money(w.pl, { sign: true })}</td>
                <td className={plClass(w.pl)}>{signedPct(w.plPct)}</td>
              </tr>
            ))}
            {weeks.length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted">
                  {data ? "No account history yet." : "Loading…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      <p className="text-xs text-muted">
        Equity is Schwab net liquidation at each week&apos;s last close (live for the current week). P/L = change in equity minus deposits and
        withdrawals; % is of the start-of-week equity.
        {anyEstimated && " * Some closes before the daily 4:30 PM snapshots began are back-filled from realized trade P/L."}
      </p>
    </div>
  );
}
