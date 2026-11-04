"use client";

import type { ExpiryChart as ExpiryData } from "@/lib/views";
import { ExpiryChart } from "./ExpiryChart";
import { money, num, plClass, priceRange, strike } from "./format";

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-3 md:p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-bold leading-tight md:text-3xl ${tone ?? ""}`}>{value}</div>
      {sub && <div className="mt-1 text-sm text-ink-2">{sub}</div>}
    </div>
  );
}

function distance(spot: number, lower: number | null, upper: number | null): string[] {
  const out: string[] = [];
  if (lower !== null) {
    const d = Math.round((spot - lower) * 10) / 10;
    out.push(d >= 0 ? `${d} pts above lower breakeven` : `${-d} pts below lower breakeven`);
  }
  if (upper !== null) {
    const d = Math.round((upper - spot) * 10) / 10;
    out.push(d >= 0 ? `${d} pts below upper breakeven` : `${-d} pts above upper breakeven`);
  }
  return out;
}

export function BestClosePanel({
  data,
  when = "today",
  margin = null,
  netLiq = null,
}: {
  data: ExpiryData;
  when?: string;
  margin?: { amount: number; pct: number; schwabPct: number | null } | null;
  netLiq?: number | null;
}) {
  const a = data.analysis;
  const zone = a.profitZone;
  const inZone = zone && (zone.lower === null || a.spot >= zone.lower) && (zone.upper === null || a.spot <= zone.upper);
  const underlying = data.underlying;

  return (
    <section className="card space-y-4 p-4 md:p-5">
      {data.settled ? (
        <header className="space-y-1">
          <h2 className="text-lg font-bold text-accent">Today&apos;s {underlying} expirations</h2>
          <p className="text-xl font-bold md:text-2xl">
            Settled at <span className="num">{num(a.spot)}</span> · final P/L{" "}
            <span className={plClass(a.pnlAtSpot)}>{money(a.pnlAtSpot, { sign: true })}</span>
          </p>
        </header>
      ) : (
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold text-accent">Best {underlying} close</h2>
          <span className="text-xs text-muted">
            at 4:00 PM settlement; {when === "today" ? "today\u2019s" : `${when}\u2019s`} expirations only
          </span>
        </header>
      )}

      {!data.settled && (
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
        <Stat
          label="Best close"
          value={
            a.best.atEdge ? (
              <span>
                {a.best.edge === "above" ? "↑ " : "↓ "}
                {strike(a.best.price)}
                {a.best.edge === "above" ? "+" : "−"}
              </span>
            ) : a.best.range && a.best.edge === "above" ? (
              `≥ ${strike(a.best.range.low)}`
            ) : a.best.range && a.best.edge === "below" ? (
              `≤ ${strike(a.best.range.high)}`
            ) : (
              priceRange(a.best.range, a.best.price)
            )
          }
          sub={
            <>
              <span className={`block text-xl font-bold md:text-2xl ${plClass(a.best.pnl)}`}>
                {money(a.best.pnl, { sign: true })}
                {netLiq ? (
                  <span className="ml-1 text-base font-semibold md:text-lg" title="Best-close P/L as a % of account net liq">
                    ({a.best.pnl >= 0 ? "+" : "−"}
                    {Math.abs((a.best.pnl / netLiq) * 100).toFixed(2)}%)
                  </span>
                ) : null}
              </span>
              {!a.best.atEdge && a.best.range && a.best.edge && (
                <span className="block">
                  max anywhere {a.best.edge === "above" ? `at or above ${strike(a.best.range.low)}` : `at or below ${strike(a.best.range.high)}`}
                </span>
              )}
              {a.best.atEdge && (
                <span className="block">keeps rising {a.best.edge === "above" ? "above" : "below"} the strikes</span>
              )}
              {margin && (
                <span className="block text-ink-2" title="Max loss at expiry of the open positions ÷ net liq (how Option Omega counts margin)">
                  margin used <span className="num font-semibold text-ink">{margin.pct.toFixed(1)}%</span> ({money(margin.amount)})
                  {margin.schwabPct !== null && <span className="block text-xs text-muted">Schwab requirement {margin.schwabPct.toFixed(1)}%</span>}
                </span>
              )}
              {a.best.atEdge && a.spotZone && (
                <span className="block">
                  flat <span className={plClass(a.spotZone.pnl)}>{money(a.spotZone.pnl, { sign: true })}</span> at{" "}
                  {strike(a.spotZone.range.low)}–{strike(a.spotZone.range.high)}
                </span>
              )}
            </>
          }
        />
        <Stat
          label="Profit zone"
          value={
            zone ? (
              <span>
                {zone.lower !== null && zone.upper !== null
                  ? `${strike(Math.round(zone.lower))}–${strike(Math.round(zone.upper))}`
                  : zone.lower !== null
                    ? `above ${strike(Math.round(zone.lower))}`
                    : zone.upper !== null
                      ? `below ${strike(Math.round(zone.upper))}`
                      : "whole range"}
              </span>
            ) : (
              <span className="text-loss">None</span>
            )
          }
          sub={
            zone ? (
              <>
                <span className={inZone ? "text-gain" : "text-loss"}>{inZone ? "✓ In zone" : "✕ Outside zone"}</span>
                {distance(a.spot, zone.lower, zone.upper).map((t) => (
                  <span key={t} className="block">
                    {underlying} is {t}
                  </span>
                ))}
              </>
            ) : (
              "No profitable settlement"
            )
          }
        />
        <Stat
          label={`P/L if ${underlying} closed now`}
          value={<span className={plClass(a.pnlAtSpot)}>{money(a.pnlAtSpot, { sign: true })}</span>}
          sub={
            <>
              at {strike(Math.round(a.spot * 100) / 100)} · mark-to-market{" "}
              <span className={plClass(data.markPl)}>{money(data.markPl, { sign: true })}</span>
            </>
          }
        />
        <Stat
          label="Worst case"
          value={<span className={plClass(a.worst.pnl)}>{money(a.worst.pnl, { sign: true })}</span>}
          sub={
            <>
              {a.worst.range && a.worst.edge === "below"
                ? `at or below ${strike(a.worst.range.high)} (max loss)`
                : a.worst.range && a.worst.edge === "above"
                  ? `at or above ${strike(a.worst.range.low)} (max loss)`
                  : `at ${a.worst.range ? `${strike(a.worst.range.low)}–${strike(a.worst.range.high)}` : strike(a.worst.price)}`}
              {a.worst.atEdge ? " (keeps falling beyond the strikes)" : ""}
            </>
          }
        />
      </div>
      )}

      <ExpiryChart analysis={a} underlying={underlying} />
    </section>
  );
}
