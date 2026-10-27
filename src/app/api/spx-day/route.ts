import { requireKv } from "@/lib/apiGuard";
import { NextResponse } from "next/server";
import { cachedFills, cachedMinuteBars, type Bar } from "@/lib/schwab/data";
import { groupClosesByOrder, realizedOn } from "@/lib/realized";
import { classifySpread } from "@/lib/spreads";
import { lastSessionDate, marketSession } from "@/lib/time";

export const dynamic = "force-dynamic";

export interface EntryMarker {
  orderId: string;
  /** Epoch seconds of the first fill. */
  time: number;
  label: string;
  contracts: number;
  /** Net price per share: + credit received, − debit paid. */
  price: number;
}

export interface ExitMarker {
  orderId: string;
  time: number;
  label: string;
  contracts: number;
  /** Order ids of today's entries this exit closes (by matching symbols). */
  closes: string[];
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

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const now = Date.now();
  const phase = marketSession(now).phase;
  const live = phase === "open" || phase === "final";
  const date = lastSessionDate(now);
  const [bars, fills] = await Promise.all([
    cachedMinuteBars("$SPX", date, live ? 60_000 : 6 * 3600_000),
    cachedFills(date, live ? 60_000 : 30 * 60_000),
  ]);

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
    });
  }
  entries.sort((a, b) => a.time - b.time);

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
        contracts: legs.map((l) => Math.abs(l.qty)).reduce(gcd),
        realized: o.unknownBasis ? null : o.realized,
      };
    })
    .sort((a, b) => a.time - b.time);

  const body: SpxDayData = {
    meta: { pollMs: live ? 60_000 : null, errors: [bars.error, fills.error].filter((e): e is string => !!e) },
    date,
    bars: bars.data ?? [],
    entries,
    exits,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
