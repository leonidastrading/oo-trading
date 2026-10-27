import { requireKv } from "@/lib/apiGuard";
import { NextResponse } from "next/server";
import { cachedFills, cachedMinuteBars, type Bar } from "@/lib/schwab/data";
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

export interface SpxDayData {
  meta: { pollMs: number | null; errors: string[] };
  date: string;
  bars: Bar[];
  entries: EntryMarker[];
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
  for (const [orderId, fs] of byOrder) {
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

  const body: SpxDayData = {
    meta: { pollMs: live ? 60_000 : null, errors: [bars.error, fills.error].filter((e): e is string => !!e) },
    date,
    bars: bars.data ?? [],
    entries,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
