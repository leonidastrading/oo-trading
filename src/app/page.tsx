"use client";

import { useState } from "react";
import type { ExpiryChart as ExpiryData } from "@/lib/views";
import Link from "next/link";
import { Arrangeable } from "@/components/Arrangeable";
import { BestClosePanel } from "@/components/BestClosePanel";
import { ClosedPnlChart } from "@/components/ClosedPnlChart";
import { SpxDayChart, type BestCloseLine } from "@/components/SpxDayChart";
import { money, num, openPositionsLabel, plClass, signed } from "@/components/format";
import { GaugePanel } from "@/components/GaugePanel";
import { PositionGroups } from "@/components/PositionGroups";
import { StatusBar } from "@/components/StatusBar";
import { Tile, toneOf } from "@/components/Tile";
import { usePoll } from "@/components/usePoll";
import { ExpiryChart } from "@/components/ExpiryChart";
import type { LiveData } from "@/lib/views";
import { expirationLabel, type SpreadGroup } from "@/lib/spreads";

/** The best-close price as the panel shows it: the plateau edge when the max runs to a side, else the peak. */
function bestCloseLine(e: ExpiryData | undefined): BestCloseLine | null {
  if (!e) return null;
  const b = e.analysis.best;
  const price = !b.atEdge && b.range && b.edge === "above" ? b.range.low : !b.atEdge && b.range && b.edge === "below" ? b.range.high : b.price;
  // A flat best zone with both ends in range (an iron condor's body): show both edges.
  const high = !b.atEdge && b.range && b.edge === null && b.range.high > b.range.low ? b.range.high : undefined;
  return { price, pnl: b.pnl, high };
}

/**
 * Open P/L as a % of what the open entries were put on for: the credit received (so 100% = keep it all)
 * or the debit paid. Each entry's net premium counts at its size.
 */
function openPct(open: number | null | undefined, groups: SpreadGroup[] | undefined): number | null {
  if (open === null || open === undefined || !groups?.length) return null;
  // Options only: cash-like holdings (money-market funds) would swamp the premium base.
  const options = groups.filter((g) => g.positions.every((p) => p.assetType === "OPTION"));
  const basis = options.reduce((s, g) => s + Math.abs(g.positions.reduce((t, p) => t + p.qty * p.avgPrice * 100, 0)), 0);
  const pl = options.reduce((s, g) => s + g.plOpen, 0);
  return basis > 0 ? (pl / basis) * 100 : null;
}
/**
 * Margin in use as a share of net liq, measured like Option Omega's Margin Req.: each expiration's
 * worst case at expiry (an iron condor counts its wider side once). Schwab's maintenance requirement,
 * which charges more for some structures, is shown alongside.
 */
function marginUsed(a: LiveData["account"] | undefined): { amount: number; pct: number; schwabPct: number | null } | null {
  if (!a || !a.netLiq) return null;
  const amount = a.marginEst ?? a.maintenance;
  if (amount === null || amount === undefined) return null;
  return { amount, pct: (amount / a.netLiq) * 100, schwabPct: a.maintenance !== null ? (a.maintenance / a.netLiq) * 100 : null };
}
const signedPct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

export default function LivePage() {
  const { data, error, loading, refresh } = usePoll<LiveData>("/api/live");
  const [arranging, setArranging] = useState(false);
  const today = data?.meta.date ?? "";
  const spx = data?.spx;
  // The focused expiration: today until the 16:15 close, then the next trading day's.
  const expiryDate = data?.expiryDate ?? today;
  const focus = (g: SpreadGroup) => (data?.expiryDate ? g.expiration === data.expiryDate : g.isToday);
  const todays = data?.groups.filter(focus) ?? [];
  const others = data?.groups.filter((g) => !focus(g)) ?? [];
  const expiryWord = !today || expiryDate === today ? "today" : expirationLabel(expiryDate, today).replace("Tomorrow", "tomorrow");
  const spxExpiry = data?.expiring.find((e) => e.underlying === "SPX");
  const otherExpiry = data?.expiring.filter((e) => e.underlying !== "SPX") ?? [];

  // Panels the viewer can reorder (Rearrange); StatusBar and the connect notice stay on top.
  const tilesPanel = (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile
        label={
          <>
            Open P/L
            {openPct(data?.pl?.open, data?.groups) !== null && (
              <span className={`ml-1.5 font-semibold ${plClass(data?.pl?.open ?? 0)}`}>({signedPct(openPct(data?.pl?.open, data?.groups)!)})</span>
            )}
          </>
        }
        value={money(data?.pl?.open, { sign: true })}
        tone={toneOf(data?.pl?.open)}
        sub={data?.pl ? openPositionsLabel(data.pl.entries, data.groups) : undefined}
      />
      <Tile
        label="Closed P/L"
        value={money(data?.pl?.closed, { sign: true })}
        tone={toneOf(data?.pl?.closed)}
        sub={
          data?.pl ? (
            <>
              {`${data.pl.closedPositions} position${data.pl.closedPositions === 1 ? "" : "s"} · ${data.pl.closedLegs} leg${data.pl.closedLegs === 1 ? "" : "s"}`}
              {data.pl.unknownBasis ? ` · ${data.pl.unknownBasis} w/o basis excluded` : ""}
            </>
          ) : undefined
        }
      />
      <Tile
        label="SPX"
        value={num(spx?.last)}
        sub={
          spx ? (
            <span className={spx.change && spx.change < 0 ? "text-loss" : "text-gain"}>
              {signed(spx.change)} ({signed(spx.changePct)}%)
            </span>
          ) : undefined
        }
      />
      <Tile
        label="Fees"
        value={data?.pl ? money(-data.pl.fees, { cents: true }) : "—"}
        tone={data?.pl?.fees ? "loss" : null}
        sub={data?.pl ? `${data.pl.contracts.toLocaleString("en-US")} contracts × $${data.pl.feeRate.toFixed(2)}` : undefined}
      />
    </section>
  );
  const expiryPanel = (
    <div className="space-y-5">
      {spxExpiry ? (
        <BestClosePanel data={spxExpiry} when={expiryWord} margin={marginUsed(data?.account)} netLiq={data?.account?.netLiq ?? null} />
      ) : (
        data?.account && <p className="card p-4 text-sm text-muted">No SPX/SPXW legs expiring today.</p>
      )}

      {otherExpiry.map((e) => (
        <section key={e.key} className="card p-4">
          <h2 className="mb-2 font-semibold text-accent">{e.underlying} expiring today</h2>
          {e.settled && (
            <p className="mb-2 text-sm">
              Settled at <span className="num">{num(e.spot)}</span> · final P/L{" "}
              <span className={plClass(e.analysis.pnlAtSpot)}>{money(e.analysis.pnlAtSpot, { sign: true })}</span>
            </p>
          )}
          <ExpiryChart analysis={e.analysis} underlying={e.underlying} />
        </section>
      ))}
    </div>
  );
  const expiringPanel = (
    <section>
      <h2 className="mb-2 text-lg font-bold text-accent">Expiring {expiryWord}</h2>
      <PositionGroups
        groups={todays}
        today={today}
        empty={expiryWord === "today" && data?.pl?.expiredPending ? "Expired — valued at settlement in Closed P/L." : `Nothing expires ${expiryWord}.`}
      />
    </section>
  );
  const otherPanel = (
    <section>
      <h2 className="mb-1 text-lg font-bold text-accent">Other positions</h2>
      <p className="mb-2 text-xs text-muted">Not included in the expiry curve — current mark P/L only.</p>
      <PositionGroups groups={others} today={today} empty="No other open positions." />
    </section>
  );

  return (
    <div className="space-y-5">
      <StatusBar
        meta={data?.meta ?? null}
        fetchedAt={data?.fetchedAt ?? null}
        loading={loading}
        clientError={error}
        onRefresh={refresh}
        actions={
          <button
            onClick={() => setArranging((v) => !v)}
            aria-pressed={arranging}
            className={`rounded-lg border px-3 py-1.5 text-sm ${arranging ? "border-accent bg-accent text-page" : "border-border text-ink hover:bg-surface-2"}`}
          >
            {arranging ? "Done" : "Rearrange"}
          </button>
        }
      />

      {data && !data.meta.token.connected && (
        <div className="card p-4 text-sm">
          Schwab isn&apos;t connected.{" "}
          <Link href="/settings" className="font-semibold text-link underline">
            Connect in Settings
          </Link>
        </div>
      )}

      <Arrangeable
        storageKey="live.layout.v1"
        editing={arranging}
        panels={[
          { id: "tiles", label: "P/L, SPX & fees", node: tilesPanel },
          { id: "expiry", label: "Best SPX close / expiry chart", node: expiryPanel },
          { id: "closed", label: "Closed P/L today", node: <ClosedPnlChart points={data?.closedCurve ?? []} /> },
          { id: "spx", label: "SPX chart", node: <SpxDayChart best={bestCloseLine(spxExpiry)} spot={spx} /> },
          { id: "expiring", label: "Expiring today", node: expiringPanel },
          { id: "other", label: "Other positions", node: otherPanel },
          { id: "gauge", label: "0DTE premium gauge", node: <GaugePanel /> },
        ]}
      />
    </div>
  );
}
