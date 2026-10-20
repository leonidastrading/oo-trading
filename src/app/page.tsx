"use client";

import Link from "next/link";
import { BestClosePanel } from "@/components/BestClosePanel";
import { money, num, signed } from "@/components/format";
import { PositionGroups } from "@/components/PositionGroups";
import { StatusBar } from "@/components/StatusBar";
import { Tile, toneOf } from "@/components/Tile";
import { usePoll } from "@/components/usePoll";
import { ExpiryChart } from "@/components/ExpiryChart";
import type { LiveData } from "@/lib/views";

export default function LivePage() {
  const { data, error, loading, refresh } = usePoll<LiveData>("/api/live");
  const today = data?.meta.date ?? "";
  const spx = data?.spx;
  const todays = data?.groups.filter((g) => g.isToday) ?? [];
  const others = data?.groups.filter((g) => !g.isToday) ?? [];
  const spxExpiry = data?.expiring.find((e) => e.underlying === "SPX");
  const otherExpiry = data?.expiring.filter((e) => e.underlying !== "SPX") ?? [];

  return (
    <div className="space-y-5">
      <StatusBar meta={data?.meta ?? null} fetchedAt={data?.fetchedAt ?? null} loading={loading} clientError={error} onRefresh={refresh} />

      {data && !data.meta.token.connected && (
        <div className="card p-4 text-sm">
          Schwab isn&apos;t connected.{" "}
          <Link href="/settings" className="font-semibold text-link underline">
            Connect in Settings
          </Link>
        </div>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={`Net liq ••${data?.account?.last4 ?? ""}`} value={money(data?.account?.netLiq)} />
        <Tile label="Day P/L" value={money(data?.account?.dayPl, { sign: true })} tone={toneOf(data?.account?.dayPl)} />
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
        <Tile label="Buying power" value={money(data?.account?.buyingPower)} />
      </section>

      {spxExpiry ? (
        <BestClosePanel data={spxExpiry} />
      ) : (
        data?.account && <p className="card p-4 text-sm text-muted">No SPX/SPXW legs expiring today.</p>
      )}

      {otherExpiry.map((e) => (
        <section key={e.key} className="card p-4">
          <h2 className="mb-2 font-semibold text-accent">{e.underlying} expiring today</h2>
          <ExpiryChart analysis={e.analysis} underlying={e.underlying} />
        </section>
      ))}

      <section>
        <h2 className="mb-2 text-lg font-bold text-accent">Expiring today</h2>
        <PositionGroups groups={todays} today={today} empty="Nothing expires today." />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-bold text-accent">Other positions</h2>
        <p className="mb-2 text-xs text-muted">Not included in the expiry curve — current mark P/L only.</p>
        <PositionGroups groups={others} today={today} empty="No other open positions." />
      </section>
    </div>
  );
}
