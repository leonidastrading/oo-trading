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

export function BestClosePanel({ data }: { data: ExpiryData }) {
  const a = data.analysis;
  const zone = a.profitZone;
  const inZone = zone && (zone.lower === null || a.spot >= zone.lower) && (zone.upper === null || a.spot <= zone.upper);
  const underlying = data.underlying;
  const singleBestRow = a.table.filter((r) => r.isBest).length === 1;

  if (data.settled) {
    return (
      <section className="card space-y-1 p-4 md:p-5">
        <h2 className="text-lg font-bold text-accent">Today&apos;s {underlying} expirations</h2>
        <p className="text-xl font-bold md:text-2xl">
          Settled at <span className="num">{num(a.spot)}</span> · final P/L{" "}
          <span className={plClass(a.pnlAtSpot)}>{money(a.pnlAtSpot, { sign: true })}</span>
        </p>
        <p className="text-xs text-muted">
          Cash-settled at the 4:00 PM close. Schwab posts the settlement overnight (~1:45 AM ET).
        </p>
      </section>
    );
  }

  return (
    <section className="card space-y-4 p-4 md:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-accent">Best {underlying} close</h2>
        <span className="text-xs text-muted">at 4:00 PM settlement; today&apos;s expirations only</span>
      </header>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
        <Stat
          label="Best close"
          value={
            a.best.atEdge ? (
              <span>
                {a.best.price > a.spot ? "↑ " : "↓ "}
                {strike(a.best.price)}
                {a.best.price > a.spot ? "+" : "−"}
              </span>
            ) : (
              priceRange(a.best.range, a.best.price)
            )
          }
          sub={
            <>
              <span className={plClass(a.best.pnl)}>{money(a.best.pnl, { sign: true })}</span>
              {a.best.atEdge && (
                <span className="block">keeps {a.best.price > a.spot ? "rising above" : "rising below"} the ±3% range</span>
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
              "No profitable settlement within ±3%"
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
          label="Worst case (±3%)"
          value={<span className={plClass(a.worst.pnl)}>{money(a.worst.pnl, { sign: true })}</span>}
          sub={
            <>
              at {a.worst.range ? `${strike(a.worst.range.low)}–${strike(a.worst.range.high)}` : strike(a.worst.price)}
              {a.worst.atEdge ? " (edge of range — may extend further)" : ""}
            </>
          }
        />
      </div>

      <ExpiryChart analysis={a} underlying={underlying} />

      <details className="group" open>
        <summary className="cursor-pointer text-sm text-ink-2">P/L at expiration, 5-pt steps (±50)</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="data w-full text-sm">
            <thead>
              <tr>
                <th>{underlying} close</th>
                <th>P/L at expiry</th>
                <th>vs now</th>
              </tr>
            </thead>
            <tbody>
              {a.table.map((r) => (
                <tr
                  key={r.price}
                  className={r.isCurrent ? "bg-spot/15" : r.isBest ? "bg-gain/15" : undefined}
                  aria-current={r.isCurrent ? "true" : undefined}
                >
                  <td className="num">
                    {strike(r.price)}
                    {r.isCurrent && <span className="ml-2 text-xs text-spot">● now</span>}
                    {r.isBest && singleBestRow && <span className="ml-2 text-xs text-gain">★ best</span>}
                  </td>
                  <td className={plClass(r.pnl)}>{money(r.pnl, { sign: true })}</td>
                  <td className="text-muted">{r.price - Math.round(a.spot / 5) * 5 >= 0 ? "+" : ""}{r.price - Math.round(a.spot / 5) * 5}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="text-xs text-muted">
        Cash-settled payoff using Schwab average cost: net {a.netCost >= 0 ? "debit" : "credit"} {money(Math.abs(a.netCost))}.
      </p>
    </section>
  );
}
