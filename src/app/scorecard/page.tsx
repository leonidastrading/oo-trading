"use client";

import { Fragment, useMemo, useState } from "react";
import { money, num } from "@/components/format";
import { Banner, StatusBar, type StatusMeta } from "@/components/StatusBar";
import { UploadTrades } from "@/components/UploadTrades";
import { usePoll } from "@/components/usePoll";
import { formatDateTimeET, formatTimeET, lastSessionDate } from "@/lib/time";
import { ASSUMPTIONS, type Aggregate, type Dist, type Light, type Scorecard, type ScoreTrade } from "@/lib/scorecard";

type Data = Scorecard & {
  meta: StatusMeta;
  fetchedAt: number | null;
  sources: {
    schwabFills: string | null;
    backtestTrades: number;
    backtestCoverageEnd: string | null;
    backtestUploadedAt: number | null;
    autoRefreshedAt: number | null;
    accountLast4: string | null;
  };
};

const LIGHTS: Record<Light, { icon: string; cls: string; label: string }> = {
  green: { icon: "●", cls: "text-gain", label: "OK" },
  yellow: { icon: "▲", cls: "text-warn", label: "Watch" },
  red: { icon: "■", cls: "text-loss", label: "Alert" },
  few: { icon: "○", cls: "text-muted", label: "Too few trades" },
  none: { icon: "–", cls: "text-muted", label: "No data" },
};

function Lamp({ light, title }: { light: Light; title?: string }) {
  const l = LIGHTS[light];
  return (
    <span className={`inline-flex items-center gap-1 ${l.cls}`} title={title ? `${title}: ${l.label}` : l.label}>
      <span aria-hidden>{l.icon}</span>
      <span className="text-xs">{l.label}</span>
    </span>
  );
}

/** $/contract slippage: positive = live worse (red), negative = better (green). */
function Slip({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <span className="text-muted">—</span>;
  const cls = v > 0.005 ? "text-loss" : v < -0.005 ? "text-gain" : "text-ink-2";
  return <span className={cls}>{`${v > 0 ? "+" : v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`}</span>;
}

function DistCell({ d }: { d: Dist }) {
  if (!d.n) return <span className="text-muted">—</span>;
  return (
    <span className="whitespace-nowrap">
      <Slip v={d.mean} /> <span className="text-muted">·</span> <Slip v={d.median} /> <span className="text-muted">·</span> <Slip v={d.worst5} />
      <span className="ml-1 text-xs text-muted">n={d.n}</span>
    </span>
  );
}

/** Dollar cost where + = live worse (cost), − = live better (saved). */
function Cost({ v }: { v: number }) {
  const cls = v > 0.5 ? "text-loss" : v < -0.5 ? "text-gain" : "text-ink-2";
  return <span className={cls}>{`${v > 0.5 ? "+" : v < -0.5 ? "−" : ""}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`}</span>;
}

const pct = (v: number | null, digits = 0) => (v === null ? "—" : `${(v * 100).toFixed(digits)}%`);
const perShare = (v: number | null | undefined) => (v === null || v === undefined ? "—" : num(v));

const CATEGORY: Record<string, string> = { expired: "Expired", profit: "Profit target", time: "Time exit", stop: "Stop loss", other: "Other" };
const STATUS: Record<ScoreTrade["status"], { label: string; cls: string }> = {
  matched: { label: "Matched", cls: "text-ink-2" },
  extra: { label: "Extra (live only)", cls: "text-warn" },
  missed: { label: "Missed (backtest only)", cls: "text-warn" },
  awaiting: { label: "Awaiting backtest", cls: "text-muted" },
};

export default function ScorecardPage() {
  const { data, error, loading, refresh } = usePoll<Data>("/api/scorecard");
  const [periodKey, setPeriodKey] = useState<"mtd" | "inception">("mtd");
  const [strategy, setStrategy] = useState("All");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showUpload, setShowUpload] = useState(false);
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const period = data?.periods[periodKey];
  const book = period?.book;
  const from = periodKey === "mtd" ? data?.monthStart : data?.inception;

  const rows = useMemo(
    () => (data?.trades ?? []).filter((t) => (!from || t.date >= from) && (strategy === "All" || t.strategy === strategy)),
    [data, from, strategy],
  );
  const strategyNames = useMemo(() => ["All", ...new Set((data?.trades ?? []).map((t) => t.strategy))], [data]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Fills &amp; Health Scorecard</h1>
        <div className="flex rounded-lg border border-border text-sm" role="group" aria-label="Period">
          {(["mtd", "inception"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setPeriodKey(k)}
              aria-pressed={periodKey === k}
              className={`px-3 py-1.5 ${periodKey === k ? "bg-surface-2 text-ink" : "text-muted"}`}
            >
              {k === "mtd" ? "Month to date" : "Since inception"}
            </button>
          ))}
        </div>
      </div>

      <StatusBar
        meta={data?.meta ?? null}
        fetchedAt={data?.fetchedAt ?? null}
        loading={loading}
        clientError={error}
        onRefresh={refresh}
      />

      <Banner tone="info">
        Read-only report. The book went live {data?.inception ?? "2026-10-16"}, so samples are still small; stop-rate and P/L-gap
        lights wait for {10}+ trades per strategy.
      </Banner>
      {data && data.firstLiveDay && data.firstLiveDay > data.inception && (
        <Banner tone="info">
          Schwab shows no fills before {data.firstLiveDay} in account ••{data.sources.accountLast4} (the only account on this login), so backtest entries before
          then aren&apos;t counted as missed. If those days traded elsewhere they can&apos;t be scored here.
        </Banner>
      )}
      {data && (() => {
        const coverage = data.sources.backtestCoverageEnd;
        const lastSession = lastSessionDate(data.asOf);
        const stale = !coverage || coverage < lastSession;
        const weekOld = !coverage || Date.parse(lastSession) - Date.parse(coverage) >= 7 * 86_400_000;
        return (
          <div className={`rounded-lg border px-3 py-2 text-sm ${stale ? (weekOld ? "border-loss/40 bg-loss/10" : "border-warn/40 bg-warn/10") : "border-border bg-surface-2"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={stale ? (weekOld ? "text-loss" : "text-warn") : "text-ink-2"}>
                {stale ? (weekOld ? "■" : "▲") : "●"} Backtest log covers through <strong>{coverage ?? "—"}</strong>
                {stale ? ` — last session was ${lastSession}; trades after ${coverage ?? "—"} show as “Awaiting backtest”.` : " — up to date."}
              </span>
              <span className="text-xs text-muted">
                {data.sources.backtestUploadedAt ? `Last upload ${formatDateTimeET(data.sources.backtestUploadedAt)}.` : ""}{" "}
                {data.sources.autoRefreshedAt
                  ? `Auto-refreshed from OO ${formatDateTimeET(data.sources.autoRefreshedAt)}.`
                  : "Upload a fresh OO portfolio trade log at least weekly."}
              </span>
              <button onClick={() => setShowUpload((v) => !v)} className="ml-auto rounded-lg border border-border px-3 py-1 text-ink hover:bg-surface-2">
                {showUpload ? "Hide upload" : "Upload trade log"}
              </button>
            </div>
            {showUpload && (
              <div className="mt-2">
                <UploadTrades compact onDone={refresh} />
              </div>
            )}
          </div>
        );
      })()}

      {book && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="text-sm text-ink-2">Slippage cost ({periodKey === "mtd" ? "MTD" : "since inception"})</div>
            <div className="mt-1 text-2xl font-bold">
              <Cost v={book.slippageCost} />
              <span className="ml-1 text-xs font-normal text-muted">{book.slippageCost < -0.5 ? "saved" : "+ = cost"}</span>
            </div>
            <div className="mt-1 text-sm text-ink-2">
              {book.slippagePctOfBt === null || book.btPl <= 0
                ? `backtest P/L ${money(book.btPl, { sign: true })}`
                : `${book.slippagePctOfBt.toFixed(1)}% of backtest P/L`}
            </div>
          </div>
          {(
            [
              ["Slippage", book.lights.slippage, book.flaggedFills ? `${book.flaggedFills} flagged fill(s)` : `entry avg ${book.entry.mean === null ? "—" : `${book.entry.mean > 0 ? "+" : book.entry.mean < 0 ? "−" : ""}$${Math.abs(book.entry.mean).toFixed(2)}`}/ct (+ = live worse)`],
              ["Fees", book.lights.fees, book.feePerSide === null ? "—" : `$${book.feePerSide.toFixed(2)} vs $${ASSUMPTIONS.feePerSide.toFixed(2)}/side · ${book.feeExcess >= 0 ? "+" : "−"}$${Math.abs(Math.round(book.feeExcess)).toLocaleString("en-US")}`],
              [
                "Stop rate (last 20)",
                book.lights.stopRate,
                period.qualifyingForStops.length
                  ? `${pct(book.stopRateRolling20)} vs ${pct(book.expectedStopRate)} expected (${period.qualifyingForStops.join(", ")})`
                  : "needs 10+ trades in a strategy",
              ],
              ["Missed / extra", book.lights.missedExtra, `${book.missed} missed · ${book.extra} extra`],
              ["Live vs backtest P/L", book.lights.gap, book.gapPct === null ? "—" : `${book.gapPct > 0 ? "+" : ""}${book.gapPct.toFixed(1)}%`],
            ] as const
          ).map(([label, light, sub]) => (
            <div key={label} className="rounded-2xl border border-border bg-surface p-4">
              <div className="text-sm text-ink-2">{label}</div>
              <div className="mt-1 text-xl font-bold">
                <Lamp light={light} title={label} />
              </div>
              <div className="mt-1 text-sm text-ink-2">{sub}</div>
            </div>
          ))}
        </section>
      )}

      {period && (
        <section>
          <h2 className="mb-1 text-lg font-bold text-accent">By strategy</h2>
          <p className="mb-2 text-xs text-muted">
            Slippage in $/contract as mean · median · worst 5%. <strong>+ = live worse</strong> than backtest, − = better. Stop-rate and P/L
            lights need {10}+ trades in the strategy.
          </p>
          <div className="card overflow-x-auto">
            <table className="data w-full text-sm">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Trades</th>
                  <th>Entry slip (+ worse)</th>
                  <th>Normal exit slip (+ worse)</th>
                  <th>Stop slip (+ worse)</th>
                  <th>Slip cost (+ = cost)</th>
                  <th>Stop rate (20)</th>
                  <th title="All closed live trades">Live $/ct</th>
                  <th>Expected $/ct</th>
                  <th title="Same-day matched trades only">Matched: live / bt $/ct</th>
                  <th>P/L gap</th>
                  <th>Missed / extra</th>
                  <th>Fees $/side vs ${ASSUMPTIONS.feePerSide.toFixed(2)}</th>
                  <th>Fee excess</th>
                  <th>Slip</th>
                  <th>Fees</th>
                  <th>Stops</th>
                  <th>Entries</th>
                  <th>Gap</th>
                </tr>
              </thead>
              <tbody>
                {[...period.strategies, period.book].map((a: Aggregate) => (
                  <tr key={a.name} className={a.name === "Book" ? "font-semibold" : undefined}>
                    <td>
                      <button className={a.name === "Book" ? "" : "text-link underline-offset-2 hover:underline"} onClick={() => setStrategy(a.name === "Book" ? "All" : a.name)}>
                        {a.name}
                      </button>
                    </td>
                    <td>
                      {a.liveTrades}
                      <span className="text-xs text-muted"> / {a.closedTrades} closed</span>
                    </td>
                    <td><DistCell d={a.entry} /></td>
                    <td><DistCell d={a.normalExit} /></td>
                    <td><DistCell d={a.stop} /></td>
                    <td>
                      <Cost v={a.slippageCost} />
                      {a.slippagePctOfBt !== null && <span className="text-xs text-muted"> {a.slippagePctOfBt.toFixed(1)}%</span>}
                    </td>
                    <td>
                      {pct(a.stopRateRolling20)}{" "}
                      <span className="text-xs text-muted">
                        vs {pct(a.expectedStopRate)}
                        {a.stopWindow ? ` · ${a.stopWindowStops}/${a.stopWindow}` : ""}
                      </span>
                    </td>
                    <td>{money(a.livePerCt, { cents: true, sign: true })}</td>
                    <td className="text-ink-2">{money(a.expectedPerCt, { sign: true })}</td>
                    <td>
                      {money(a.liveMatchedPerCt, { cents: true, sign: true })}{" "}
                      <span className="text-muted">/ {money(a.btPerCt, { cents: true, sign: true })}</span>
                    </td>
                    <td>{a.gapPct === null ? "—" : `${a.gapPct > 0 ? "+" : ""}${a.gapPct.toFixed(1)}%`}</td>
                    <td>
                      {a.missed} / {a.extra}
                    </td>
                    <td className={a.feePerSide !== null && a.feePerSide > ASSUMPTIONS.feePerSide + 0.005 ? "text-loss" : "text-ink-2"}>
                      {a.feePerSide === null ? "—" : `$${a.feePerSide.toFixed(2)}`}
                    </td>
                    <td>{a.contractSides ? <Cost v={a.feeExcess} /> : <span className="text-muted">—</span>}</td>
                    <td><Lamp light={a.lights.slippage} title="Slippage" /></td>
                    <td><Lamp light={a.lights.fees} title="Fees" /></td>
                    <td><Lamp light={a.lights.stopRate} title="Stop rate" /></td>
                    <td><Lamp light={a.lights.missedExtra} title="Missed/extra" /></td>
                    <td><Lamp light={a.lights.gap} title="P/L gap" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && (
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold text-accent">Trades</h2>
            <label className="text-sm text-ink-2">
              Strategy{" "}
              <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="ml-1 rounded-lg border border-border bg-surface-2 px-2 py-1 text-ink">
                {strategyNames.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </div>
          {rows.length ? (
            <div className="card overflow-x-auto">
              <table className="data w-full text-sm">
                <thead>
                  <tr>
                    <th>Date / entry</th>
                    <th>Strategy</th>
                    <th>Status</th>
                    <th>Entry live / bt</th>
                    <th>Entry slip $/ct (+ worse)</th>
                    <th>Exit</th>
                    <th>Exit live / bt</th>
                    <th>Exit slip $/ct (+ worse)</th>
                    <th>Fees $/side</th>
                    <th>P/L $/ct live / bt</th>
                    <th>Diff (+ worse)</th>
                    <th>Exit fills</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <Fragment key={t.id}>
                    <tr>
                      <td>
                        {t.date} <span className="text-muted">{t.entryTime.slice(0, 5)}</span>
                      </td>
                      <td title={t.rawStrategy ?? undefined}>
                        {t.strategy}
                        {/dip/i.test(t.rawStrategy ?? "") && <span className="text-xs text-muted"> · Dip add-on</span>}
                        {t.strategyInferred && <span className="text-xs text-muted"> (inferred)</span>}
                      </td>
                      <td className={STATUS[t.status].cls}>
                        {t.live?.status === "open" ? "Open · " : ""}
                        {STATUS[t.status].label}
                      </td>
                      <td>
                        {perShare(t.live?.credit)} <span className="text-muted">/ {perShare(t.bt?.credit)}</span>
                      </td>
                      <td><Slip v={t.entrySlip === null ? null : t.entrySlip * 100} /></td>
                      <td>
                        {t.category ? CATEGORY[t.category] : t.bt && !t.live ? CATEGORY[t.bt.kind] : "—"}
                        {t.categoryInferred && <span className="text-xs text-muted"> (inferred)</span>}
                      </td>
                      <td>
                        {perShare(t.live?.debit)} <span className="text-muted">/ {perShare(t.bt?.debit)}</span>
                      </td>
                      <td><Slip v={t.exitSlip === null ? null : t.exitSlip * 100} /></td>
                      <td className={t.feePerSide !== null && t.feePerSide > ASSUMPTIONS.feePerSide + 0.005 ? "text-loss" : "text-ink-2"}>
                        {t.feePerSide === null ? "—" : `$${t.feePerSide.toFixed(2)}`}
                      </td>
                      <td>
                        {money(t.live?.plPerCt, { cents: true, sign: true })}{" "}
                        <span className="text-muted">/ {money(t.bt?.plPerCt, { cents: true, sign: true })}</span>
                      </td>
                      <td><Slip v={t.plDiffPerCt === null ? null : -t.plDiffPerCt} /></td>
                      <td>
                        {t.live?.exits.length ? (
                          <button onClick={() => toggle(t.id)} className="text-link" aria-expanded={open.has(t.id)}>
                            {open.has(t.id) ? "▾" : "▸"} {t.live.exits.length}
                          </button>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="whitespace-normal text-xs text-warn">{t.flags.join(" · ")}</td>
                    </tr>
                    {open.has(t.id) && t.live && (
                      <tr>
                        <td colSpan={13} className="bg-surface-2">
                          <div className="text-xs text-ink-2">
                            Entry order {t.live.orderId}: {t.live.legs.map((l) => `${l.qty > 0 ? "+" : "−"}${Math.abs(l.qty)} ${l.strike}${l.putCall} @ ${l.price.toFixed(2)}`).join(" · ")}
                          </div>
                          <table className="mt-1 text-xs">
                            <tbody>
                              {t.live.exits.map((x, i) => (
                                <tr key={i}>
                                  <td className="pr-4 text-left">{x.via === "settlement" ? "Settlement" : formatTimeET(x.time)}</td>
                                  <td className="pr-4 text-left">
                                    {x.openSign < 0 ? "Buy" : "Sell"} {x.qty} {x.strike}
                                    {x.putCall}
                                  </td>
                                  <td className="pr-4">@ {x.price.toFixed(2)}</td>
                                  <td className="pr-4 text-muted">{x.via === "order" ? `order ${x.orderId}` : "expired"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div className="mt-1 text-xs text-muted">
                            Closed {t.live.exits.reduce((s, x) => s + x.qty, 0)} of {t.live.legs.reduce((s, l) => s + Math.abs(l.qty), 0)} contracts
                            {t.live.debit !== null ? ` · net closing debit ${t.live.debit.toFixed(2)}/share per unit (${t.live.units} units)` : ""}
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">No trades in this period.</p>
          )}
        </section>
      )}

      <section className="card space-y-1 p-4 text-xs text-ink-2">
        <div className="font-semibold text-ink">How this is measured</div>
        <p>
          Assumptions: entry ${ASSUMPTIONS.entry.toFixed(2)}, normal exit ${ASSUMPTIONS.exit.toFixed(2)}, stop ${ASSUMPTIONS.stop.toFixed(2)} per share
          (×100 per contract); fees ${ASSUMPTIONS.feePerSide.toFixed(2)} per contract per side.
        </p>
        <p>
          Backtest prices already include the assumed slippage (OO Premium is the mid credit minus $0.05), so slippage here is live vs
          backtest price: $0 means “exactly as assumed”. Lights: green ≤ assumption, yellow ≤ 1.5×, red above that or any flagged fill.
        </p>
        <p>
          Live trades = Schwab opening orders (all legs of one order). Each closing order is credited to the entry whose open legs it
          matches (expand “Exit fills” to check); expirations use Schwab&apos;s posted settlement. Matching = same day, same structure
          (types, sides, ratios, DTE), nearest entry time within 15 min, then closest strikes and contract count. Backtest closing
          debit is derived from P/L and fees. Live trades without a same-day backtest twin get an inferred strategy (structure, usual
          entry time and credit range from the backtest history) so they count toward stop rate and live P/L, but not slippage. Live
          fees are Schwab&apos;s reported fees. Exit type comes from the backtest; when only the
          live trade was closed by an order it is inferred (loss → stop).
        </p>
      </section>
    </div>
  );
}
