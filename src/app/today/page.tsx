"use client";

import { money, num, openPositionsLabel, plClass, strike } from "@/components/format";
import { PositionGroups } from "@/components/PositionGroups";
import { StatusBar } from "@/components/StatusBar";
import { Tile, toneOf } from "@/components/Tile";
import { usePoll } from "@/components/usePoll";
import { formatTimeET } from "@/lib/time";
import type { TodayData } from "@/lib/views";

const legText = (l: { strike: number | null; putCall: string | null; symbol: string }) =>
  l.strike !== null ? `${strike(l.strike)}${l.putCall}` : l.symbol;

export default function TodayPage() {
  const { data, error, loading, refresh } = usePoll<TodayData>("/api/today");
  const dateLabel = data
    ? new Date(data.sessionDate + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "";

  return (
    <div className="space-y-5">
      <h1 className="border-b border-ink/60 pb-3 text-2xl font-bold">{dateLabel || "Today"}</h1>
      <StatusBar meta={data?.meta ?? null} fetchedAt={data?.fetchedAt ?? null} loading={loading} clientError={error} onRefresh={refresh} />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Open P/L"
          value={money(data?.openPl, { sign: true })}
          tone={toneOf(data?.openPl)}
          sub={data?.fetchedAt ? openPositionsLabel(data.entries, data.groups) : undefined}
        />
        <Tile
          label="Closed P/L"
          value={money(data?.realized, { sign: true })}
          tone={toneOf(data?.realized)}
          sub={
            data?.closed.some((o) => o.pending)
              ? `incl. ${money(
                  data.closed.filter((o) => o.pending).reduce((s, o) => s + o.realized, 0),
                  { sign: true },
                )} expired`
              : data?.unknownBasis
                ? `${data.unknownBasis} close(s) without basis excluded`
                : undefined
          }
        />
        <Tile label="Total" value={money(data?.total, { sign: true })} tone={toneOf(data?.total)} sub="closed + open" />
        <Tile label="Account day P/L" value={money(data?.dayPl, { sign: true })} tone={toneOf(data?.dayPl)} sub="net liq change" />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-bold text-accent">Open</h2>
        <PositionGroups groups={data?.groups ?? []} today={data?.meta.date ?? ""} empty="No open positions." />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-bold text-accent">Closed</h2>
        {data?.closed.length ? (
          <div className="card overflow-x-auto">
            <table className="data w-full text-sm">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Realized P/L</th>
                </tr>
              </thead>
              <tbody>
                {data.closed.map((o) => (
                  <tr key={o.orderId}>
                    <td className="whitespace-normal">
                      <span className="text-link">
                        {o.underlying}{" "}
                        {o.pending
                          ? `${o.legs.length} leg${o.legs.length === 1 ? "" : "s"} expired`
                          : o.legs.map((l) => `${l.fill.qty > 0 ? "+" : "−"}${l.closedQty} ${legText(l.fill)}`).join(" / ")}
                      </span>
                      <span className="block text-xs text-muted">
                        {o.pending
                          ? `Expired · settled at ${num(o.pending.settle)}`
                          : formatTimeET(o.time)}
                      </span>
                    </td>
                    <td className={o.unknownBasis ? "text-muted" : plClass(o.realized)}>
                      {money(o.realized, { sign: true })}
                      {o.unknownBasis && <span className="block text-xs">partial: opened &gt;10d ago</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">No closing trades today.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-bold text-accent">Fills</h2>
        {data?.fills.length ? (
          <div className="card overflow-x-auto">
            <table className="data w-full text-sm">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Leg</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Fees</th>
                  <th>Cash</th>
                </tr>
              </thead>
              <tbody>
                {data.fills.map((f) => (
                  <tr key={f.id}>
                    <td className="text-ink-2">{formatTimeET(f.time)}</td>
                    <td>
                      {f.underlying} {legText(f)}
                    </td>
                    <td className="text-ink-2">
                      {f.qty > 0 ? "Buy" : "Sell"} {f.effect === "OPENING" ? "to open" : f.effect === "CLOSING" ? "to close" : ""}
                    </td>
                    <td>{Math.abs(f.qty)}</td>
                    <td>{num(f.price)}</td>
                    <td className="text-muted">{num(f.fees)}</td>
                    <td className={plClass(f.cash)}>{money(f.cash, { cents: true, sign: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">No fills today.</p>
        )}
      </section>
    </div>
  );
}
