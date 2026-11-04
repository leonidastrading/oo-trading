import { requireKv } from "@/lib/apiGuard";
import { NextResponse } from "next/server";
import { cachedFills, cachedMinuteBars, cachedQuotes, type Bar } from "@/lib/schwab/data";
import { uniqueEntries } from "@/lib/allocSim";
import { cached } from "@/lib/cache";
import { KEYS, kv } from "@/lib/kv";
import type { OOTrade } from "@/lib/ooCsv";
import { groupClosesByOrder, realizedOn } from "@/lib/realized";
import {
  buildLiveTrades,
  buildProfiles,
  deserializeProfiles,
  inferStrategy,
  OO_TIME_EXITS,
  scheduledExits,
  serializeProfiles,
  toBacktest,
  type BacktestTrade,
  type SerializedProfiles,
} from "@/lib/scorecard";
import { classifySpread, daysBetween } from "@/lib/spreads";
import { closedMaxAge, etMidnightUtc, lastSessionDate, marketSession } from "@/lib/time";

export const dynamic = "force-dynamic";

export interface EntryMarker {
  orderId: string;
  /** Epoch seconds of the first fill. */
  time: number;
  label: string;
  contracts: number;
  /** Net price per share: + credit received, − debit paid. */
  price: number;
  /** Days from entry to the (latest) expiration: 0 = same-day. */
  dte: number;
  /** Book strategy from its structure (strategyRules.ts), else inferred from the OO backtests (null if unsure). */
  strategy: string | null;
}

export interface ExitMarker {
  orderId: string;
  time: number;
  label: string;
  contracts: number;
  dte: number | null;
  /** Order ids of today's entries this exit closes (by matching symbols). */
  closes: string[];
  /**
   * Stop-out: a losing close that isn't the entry strategy's scheduled exit (its OO time exit, within 2 min).
   * Falls back to "a loss before 3:45 PM" when the strategy can't be told.
   */
  stop: boolean;
  /** Realized P/L of the closing order, net of fees (null if the opening fill is outside the lookback). */
  realized: number | null;
}

export interface SpxDayData {
  meta: { pollMs: number | null; errors: string[] };
  date: string;
  bars: Bar[];
  entries: EntryMarker[];
  exits: ExitMarker[];
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const withClosingBar = (bars: Bar[], close: Bar | null) => (close ? [...bars, close] : bars);

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const now = Date.now();
  const phase = marketSession(now).phase;
  const live = phase === "open" || phase === "final";
  const date = lastSessionDate(now);
  const [bars, fills] = await Promise.all([
    cachedMinuteBars("$SPX", date, live ? 60_000 : closedMaxAge(now, 6 * 3600_000)),
    cachedFills(date, live ? 60_000 : closedMaxAge(now, 30 * 60_000)),
  ]);

  // Schwab's minute history ends with the 15:59 bar; after the bell, add the 16:00 close (the index's
  // official close, from the quote) as its own bar.
  const bellMs = etMidnightUtc(date).getTime() + 16 * 3600_000;
  let closeBar: Bar | null = null;
  if (now > bellMs + 60_000 && (bars.data?.at(-1)?.time ?? Infinity) * 1000 < bellMs) {
    const q = (await cachedQuotes(["$SPX"], live ? 15_000 : closedMaxAge(now, 30 * 60_000))).data?.["$SPX"];
    if (q && typeof q.last === "number" && (q.time ?? 0) >= etMidnightUtc(date).getTime()) {
      const prev = bars.data!.at(-1)!.close;
      closeBar = { time: bellMs / 1000, open: prev, high: Math.max(prev, q.last), low: Math.min(prev, q.last), close: q.last };
    }
  }

  const byOrder = new Map<string, NonNullable<typeof fills.data>>();
  for (const f of fills.data ?? []) {
    if (f.bookDate !== date || f.settlement || f.effect === "CLOSING" || f.underlying !== "SPX") continue;
    byOrder.set(f.orderId, [...(byOrder.get(f.orderId) ?? []), f]);
  }
  const entries: EntryMarker[] = [];
  const entrySymbols = new Map<string, Set<string>>();
  for (const [orderId, fs] of byOrder) {
    entrySymbols.set(orderId, new Set(fs.map((f) => f.symbol)));
    // Net quantity per symbol, then the order's unit size (e.g. 13 for a 13-lot IC, 6 for a 6:12:6 BWB).
    const legs = new Map<string, { putCall: "P" | "C" | null; strike: number | null; qty: number; cash: number }>();
    for (const f of fs) {
      const l = legs.get(f.symbol) ?? { putCall: f.putCall, strike: f.strike, qty: 0, cash: 0 };
      l.qty += f.qty;
      l.cash += -f.qty * f.price;
      legs.set(f.symbol, l);
    }
    const ls = [...legs.values()].filter((l) => l.qty !== 0);
    if (!ls.length) continue;
    const unit = ls.map((l) => Math.abs(l.qty)).reduce(gcd);
    entries.push({
      orderId,
      time: Math.floor(Math.min(...fs.map((f) => f.time)) / 1000),
      label: classifySpread(ls),
      contracts: unit,
      price: Math.round((ls.reduce((s, l) => s + l.cash, 0) / unit) * 100) / 100,
      dte: daysBetween(date, fs.map((f) => f.expiration ?? date).sort().at(-1) ?? date),
      strategy: null,
    });
  }
  entries.sort((a, b) => a.time - b.time);

  // Which strategy each entry is, and when that strategy is scheduled to exit (learned from the OO backtests).
  const model = await cached<{ profiles: SerializedProfiles; schedule: [string, number][] }>("oo:stopmodel:v1", 6 * 3600_000, async () => {
    const oo = uniqueEntries(Object.values(await kv().hgetall<OOTrade>(KEYS.ooTrades)));
    const bt = oo.map(toBacktest).filter((b): b is BacktestTrade => b !== null);
    return { profiles: serializeProfiles(buildProfiles(bt)), schedule: [...scheduledExits(bt)] };
  });
  const profiles = deserializeProfiles(model.data?.profiles ?? []);
  const schedule = new Map([...(model.data?.schedule ?? []), ...Object.entries(OO_TIME_EXITS)]);
  const liveTrades = new Map(buildLiveTrades(fills.data ?? [], date).map((l) => [l.orderId, l]));
  for (const e of entries) {
    const l = liveTrades.get(e.orderId);
    e.strategy = l ? inferStrategy(l, profiles) : null;
    // A book iron condor with both shorts on one strike is still an iron condor.
    if (e.label === "Iron butterfly" && e.strategy && /IC$/.test(e.strategy)) e.label = "Iron condor";
  }
  // The Dip Add-On is a 1-lot copy of the $8 IC; when it comes in as its own order, name it.
  const icOrders = entries.filter((e) => e.strategy === "$8 IC");
  if (icOrders.length > 1) for (const e of icOrders) if (e.contracts === 1) e.strategy = "Dip";
  const etMin = (sec: number) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(sec * 1000));
    return Number(p.find((x) => x.type === "hour")?.value) * 60 + Number(p.find((x) => x.type === "minute")?.value);
  };
  const isStop = (time: number, realized: number | null, closes: string[]) => {
    if ((realized ?? 0) >= 0) return false;
    const m = etMin(time);
    const known = closes.map((id) => entries.find((e) => e.orderId === id)?.strategy).filter((s): s is string => !!s);
    if (!known.length) return m < 15 * 60 + 45;
    return !known.some((s) => schedule.has(s) && m >= schedule.get(s)! && m <= schedule.get(s)! + 2);
  };

  // Closing orders placed during the session (stops / early exits); expirations settle at 4:00 and are not shown.
  const closes = realizedOn(fills.data ?? [], date).filter((c) => !c.fill.settlement && c.fill.underlying === "SPX");
  const exits: ExitMarker[] = groupClosesByOrder(closes)
    .map((o) => {
      // Partial fills of one leg arrive separately: net them per symbol first.
      const bySym = new Map<string, { putCall: "P" | "C" | null; strike: number | null; qty: number }>();
      for (const l of o.legs) {
        const v = bySym.get(l.fill.symbol) ?? { putCall: l.fill.putCall, strike: l.fill.strike, qty: 0 };
        v.qty += -Math.sign(l.fill.qty) * l.closedQty;
        bySym.set(l.fill.symbol, v);
      }
      const legs = [...bySym.values()];
      // Name it after the entry it closes (e.g. a stop that buys back an IC's short strikes is "Iron condor").
      const opened = entries.filter((e) => [...bySym.keys()].every((sym) => entrySymbols.get(e.orderId)?.has(sym)));
      const labels = [...new Set(opened.map((e) => e.label))];
      return {
        orderId: o.orderId,
        time: Math.floor(o.time / 1000),
        label: labels.length ? labels.join(" / ") : classifySpread(legs),
        closes: opened.map((e) => e.orderId),
        stop: false,
        dte: opened.length ? Math.max(...opened.map((e) => e.dte)) : null,
        contracts: legs.map((l) => Math.abs(l.qty)).reduce(gcd),
        realized: o.unknownBasis ? null : o.realized,
      };
    })
    .sort((a, b) => a.time - b.time);
  // Which entry each closing order actually closed, from the scorecard's per-order exit matching
  // (symbols alone can't tell apart entries that share strikes, e.g. three identical BWBs).
  const closedBy = new Map<string, string[]>();
  for (const l of liveTrades.values()) {
    for (const f of l.exits) {
      if (f.via !== "order") continue;
      const ids = closedBy.get(f.orderId) ?? [];
      if (!ids.includes(l.orderId)) ids.push(l.orderId);
      closedBy.set(f.orderId, ids);
    }
  }
  for (const x of exits) {
    const ids = closedBy.get(x.orderId);
    if (ids?.length) {
      x.closes = ids;
      const labels = [...new Set(ids.map((id) => entries.find((e) => e.orderId === id)?.label).filter((v): v is string => !!v))];
      if (labels.length) x.label = labels.join(" / ");
    }
    x.stop = isStop(x.time, x.realized, x.closes);
  }

  const body: SpxDayData = {
    meta: { pollMs: live ? 60_000 : null, errors: [bars.error, fills.error].filter((e): e is string => !!e) },
    date,
    bars: withClosingBar(bars.data ?? [], closeBar),
    entries,
    exits,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
