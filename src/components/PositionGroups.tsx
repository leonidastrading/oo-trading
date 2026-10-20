"use client";

import type { SpreadGroup } from "@/lib/spreads";
import { expirationLabel } from "@/lib/spreads";
import { money, num, plClass, strike } from "./format";

export function PositionGroups({ groups, today, empty }: { groups: SpreadGroup[]; today: string; empty?: string }) {
  if (!groups.length) return <p className="text-sm text-muted">{empty ?? "No positions."}</p>;
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <article key={g.key} className="card overflow-hidden">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <div className="font-semibold text-link">
                {g.underlying} {g.label}
              </div>
              <div className="text-xs text-muted">
                {g.expiration ? `${expirationLabel(g.expiration, today)} · ${g.expiration} · ${g.dte}DTE` : "No expiration"} ·{" "}
                {g.positions.length} leg{g.positions.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="ml-auto flex gap-4 text-right">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted">P/L open</div>
                <div className={`num font-semibold ${plClass(g.plOpen)}`}>{money(g.plOpen, { sign: true })}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted">P/L day</div>
                <div className={`num font-semibold ${plClass(g.plDay)}`}>{money(g.plDay, { sign: true })}</div>
              </div>
            </div>
          </header>
          <div className="overflow-x-auto">
            <table className="data w-full text-sm">
              <thead>
                <tr>
                  <th>Leg</th>
                  <th>Qty</th>
                  <th>Avg</th>
                  <th>Mark</th>
                  <th>P/L open</th>
                  <th>P/L day</th>
                </tr>
              </thead>
              <tbody>
                {g.positions.map((p) => (
                  <tr key={p.symbol}>
                    <td>
                      {p.strike !== null ? (
                        <>
                          <span className="num">{strike(p.strike)}</span>{" "}
                          <span className={p.putCall === "P" ? "text-ink-2" : "text-ink-2"}>{p.putCall === "P" ? "Put" : "Call"}</span>
                        </>
                      ) : (
                        p.symbol
                      )}
                    </td>
                    <td className={p.qty < 0 ? "text-loss" : "text-gain"}>{p.qty > 0 ? `+${p.qty}` : `−${Math.abs(p.qty)}`}</td>
                    <td>{num(p.avgPrice)}</td>
                    <td>{num(p.mark)}</td>
                    <td className={plClass(p.plOpen)}>{money(p.plOpen, { sign: true })}</td>
                    <td className={plClass(p.plDay)}>{money(p.plDay, { sign: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ))}
    </div>
  );
}
