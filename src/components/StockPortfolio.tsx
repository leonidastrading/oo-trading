"use client";

import { useEffect, useState } from "react";
import type { PortfolioData } from "@/app/api/stocks/portfolio/route";
import { money } from "@/components/format";
import { usePref } from "@/components/usePref";

// Chart fills (checked for colour-blind separation on the dark surface): long / advancing = blue,
// short / declining = orange, unchanged = neutral grey. Text stays in the normal text colours.
const LONG = "#3987e5";
const SHORT = "#e0843b";
const FLAT = "#6b6b66";

const pct = (v: number, d = 1) => `${v.toFixed(d)}%`;
const Swatch = ({ c }: { c: string }) => <span aria-hidden className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-baseline" style={{ background: c }} />;

/** Donut of the long vs short share of invested money, with the figures written out beside it. */
function LongShortPie({ long, short, longCount, shortCount, accountValue }: { long: number; short: number; longCount: number; shortCount: number; accountValue: number | null }) {
  const total = long + short;
  const R = 54;
  const C = 2 * Math.PI * R;
  const gap = long > 0 && short > 0 ? 3 : 0; // surface gap between the two arcs
  const longLen = total ? Math.max((long / total) * C - gap, 0) : 0;
  const shortLen = total ? Math.max((short / total) * C - gap, 0) : 0;
  const share = (v: number) => (total ? (v / total) * 100 : 0);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 140 140" className="h-36 w-36 shrink-0" role="img" aria-label={`Long ${pct(share(long))}, short ${pct(share(short))} of invested money`}>
        <g transform="rotate(-90 70 70)" fill="none" strokeWidth="22">
          <circle cx="70" cy="70" r={R} stroke={LONG} strokeDasharray={`${longLen} ${C - longLen}`}>
            <title>{`Long ${money(long)} (${pct(share(long))})`}</title>
          </circle>
          <circle cx="70" cy="70" r={R} stroke={SHORT} strokeDasharray={`${shortLen} ${C - shortLen}`} strokeDashoffset={-(longLen + gap)}>
            <title>{`Short ${money(short)} (${pct(share(short))})`}</title>
          </circle>
        </g>
        <text x="70" y="66" textAnchor="middle" className="fill-[var(--muted)]" fontSize="10">
          invested
        </text>
        <text x="70" y="82" textAnchor="middle" className="fill-[var(--ink)]" fontSize="13" fontWeight="700">
          {money(total)}
        </text>
      </svg>
      <div className="space-y-1.5 text-sm">
        <div>
          <Swatch c={LONG} />
          Long <b>{pct(share(long))}</b> · {money(long)} · {longCount} position{longCount === 1 ? "" : "s"}
        </div>
        <div>
          <Swatch c={SHORT} />
          Short <b>{pct(share(short))}</b> · {money(short)} · {shortCount} position{shortCount === 1 ? "" : "s"}
        </div>
        <div className="text-xs text-ink-2">
          Net {long >= short ? "long" : "short"} {money(Math.abs(long - short))}
          {accountValue ? ` (${pct((Math.abs(long - short) / accountValue) * 100)} of the account)` : ""}
        </div>
        {accountValue && (
          <div className="text-xs text-ink-2">
            Gross {money(total)} = {pct((total / accountValue) * 100)} of the account ({money(accountValue)})
          </div>
        )}
      </div>
    </div>
  );
}

/** Advancers | unchanged | decliners as one bar, with the counts written under it. */
function BreadthBar({ title, up, flat, down, note }: { title: string; up: number; flat: number; down: number; note?: string }) {
  const total = up + flat + down;
  const seg = (n: number, c: string, label: string, first: boolean, last: boolean) =>
    n > 0 ? (
      <div
        title={`${label}: ${n} (${pct((n / total) * 100)})`}
        style={{ flexGrow: n, background: c }}
        className={`h-3 min-w-[3px] basis-0 ${first ? "rounded-l" : ""} ${last ? "rounded-r" : ""}`}
      />
    ) : null;
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-ink">{title}</div>
      {total ? (
        <>
          <div className="flex gap-0.5">
            {seg(up, LONG, "Advancing", true, flat + down === 0)}
            {seg(flat, FLAT, "Unchanged", up === 0, down === 0)}
            {seg(down, SHORT, "Declining", up + flat === 0, true)}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-2">
            <span>
              <Swatch c={LONG} />▲ {up} advancing ({pct((up / total) * 100, 0)})
            </span>
            {flat > 0 && (
              <span>
                <Swatch c={FLAT} />
                {flat} unchanged
              </span>
            )}
            <span>
              <Swatch c={SHORT} />▼ {down} declining ({pct((down / total) * 100, 0)})
            </span>
          </div>
        </>
      ) : (
        <div className="text-xs text-muted">No data</div>
      )}
      {note && <div className="text-xs text-muted">{note}</div>}
    </div>
  );
}

/** Portfolio stats for the open stock positions. Refreshes every 2 minutes. */
export function StockPortfolio() {
  const [d, setD] = useState<PortfolioData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = usePref<boolean>("stocks.collapsed.portfolio", false, (v) => typeof v === "boolean");
  useEffect(() => {
    if (collapsed) return;
    let off = false;
    const load = () =>
      fetch("/api/stocks/portfolio", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: PortfolioData) => {
          if (off) return;
          setD(j);
          setErr(null);
        })
        .catch(() => !off && setErr("Couldn't load the portfolio stats"));
    void load();
    const every = setInterval(load, 120_000);
    return () => {
      off = true;
      clearInterval(every);
    };
  }, [collapsed]);
  const s = d?.stats;
  const maxSector = s ? Math.max(...s.sectors.map((r) => r.total), 1) : 1;
  return (
    <section className="card space-y-4 p-4">
      <h2 className="font-bold text-accent">
        Portfolio stats
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="ml-2 rounded-md border border-border px-2 py-0.5 align-middle text-xs font-normal text-ink-2"
        >
          {collapsed ? "▸ Show" : "▾ Hide"}
        </button>
      </h2>
      {!collapsed && err && <div className="text-xs text-loss">{err}</div>}
      {!collapsed && !s && !err && <div className="text-sm text-muted">Loading…</div>}
      {!collapsed && s && s.positions === 0 && <div className="text-sm text-muted">No open positions.</div>}
      {!collapsed && s && s.positions > 0 && (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted">Long vs short (share of invested money)</div>
              <LongShortPie long={s.long} short={s.short} longCount={s.longCount} shortCount={s.shortCount} accountValue={d!.accountValue} />
            </div>
            <div className="space-y-4">
              <div className="text-xs uppercase tracking-wide text-muted">Today&apos;s advancers and decliners</div>
              <BreadthBar
                title={`My holdings (${s.advancers + s.decliners + s.unchanged} stocks)`}
                up={s.advancers}
                flat={s.unchanged}
                down={s.decliners}
                note={`Moving my way today: ${s.inFavour} (longs up, shorts down) · against me: ${s.against}`}
              />
              {d!.breadth ? (
                <BreadthBar
                  title={`S&P 500 (${d!.breadth.counted} stocks)`}
                  up={d!.breadth.advancers}
                  flat={d!.breadth.unchanged}
                  down={d!.breadth.decliners}
                  note={`Delayed prices · as of ${new Date(d!.breadth.at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })} ET`}
                />
              ) : (
                <div className="text-xs text-muted">S&amp;P 500 advancers / decliners aren&apos;t available right now.</div>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted">Sector allocation</div>
            <div className="overflow-x-auto">
              <table className="data w-full text-sm">
                <thead>
                  <tr>
                    <th>Sector</th>
                    <th>Positions</th>
                    <th>% of invested</th>
                    {d!.accountValue && <th>% of account</th>}
                    <th>Long</th>
                    <th>Short</th>
                    <th>Short share</th>
                    <th className="min-w-40 text-left">
                      <Swatch c={LONG} />
                      long <span className="ml-2" />
                      <Swatch c={SHORT} />
                      short
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.sectors.map((r) => (
                    <tr key={r.sector}>
                      <td className="font-semibold">{r.sector}</td>
                      <td className="num">{r.positions}</td>
                      <td className="num font-semibold">{pct(r.pctOfInvested)}</td>
                      {d!.accountValue && <td className="num">{pct((r.total / d!.accountValue) * 100)}</td>}
                      <td className="num">{r.long ? money(r.long) : "—"}</td>
                      <td className="num">{r.short ? money(r.short) : "—"}</td>
                      <td className="num">{pct(r.shortPct, 0)}</td>
                      <td>
                        <div className="flex gap-0.5" style={{ width: `${Math.max((r.total / maxSector) * 100, 2)}%` }} title={`${r.sector}: ${pct(r.pctOfInvested)} of invested · ${pct(100 - r.shortPct, 0)} long, ${pct(r.shortPct, 0)} short`}>
                          {r.long > 0 && <div className={`h-3 min-w-[3px] basis-0 rounded-l ${r.short > 0 ? "" : "rounded-r"}`} style={{ flexGrow: r.long, background: LONG }} />}
                          {r.short > 0 && <div className={`h-3 min-w-[3px] basis-0 rounded-r ${r.long > 0 ? "" : "rounded-l"}`} style={{ flexGrow: r.short, background: SHORT }} />}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">
              Sizes use the latest price; dry-run positions count at their shadow size. &quot;% of invested&quot; adds long and short together. Sectors are Nasdaq&apos;s
              classification; ETFs and anything it doesn&apos;t list fall under &quot;ETF / not classified&quot;.
            </p>
          </div>
          {d!.notes.length > 0 && <div className="text-xs text-warn">{d!.notes.join(" · ")}</div>}
        </>
      )}
    </section>
  );
}
