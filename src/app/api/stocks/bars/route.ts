import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { cached } from "@/lib/cache";
import { cachedDailyBars, cachedFiveMinuteBars, type Bar } from "@/lib/schwab/data";
import { schwabGet } from "@/lib/schwab/client";
import { regularSession } from "@/lib/stocks/rules";
import { etParts, isTradingDay } from "@/lib/time";

/** Schwab's daily history leaves out the session in progress: build today's bar from the quote. */
async function todayBar(symbol: string): Promise<Bar | null> {
  const p = etParts();
  if (!isTradingDay(p.date) || p.minutesOfDay < 9 * 60 + 30) return null;
  type Raw = Record<string, { quote?: { openPrice?: number; highPrice?: number; lowPrice?: number; lastPrice?: number } }>;
  const r = await cached(`stocks:daybar:${symbol}`, 60_000, () => schwabGet<Raw>("/marketdata/v1/quotes", { symbols: symbol, fields: "quote" }));
  const q = r.data?.[symbol]?.quote;
  if (!q?.openPrice || !q.lastPrice) return null;
  return {
    time: Date.parse(p.date + "T00:00:00Z") / 1000,
    open: q.openPrice,
    high: Math.max(q.highPrice ?? 0, q.openPrice, q.lastPrice),
    low: Math.min(q.lowPrice || q.openPrice, q.openPrice, q.lastPrice),
    close: q.lastPrice,
  };
}

export const dynamic = "force-dynamic";

/** Price bars for a Stock Trades chart: daily (1 year) or 5-minute (last 5 days). Read-only market data. */
export async function GET(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").toUpperCase();
  const tf = req.nextUrl.searchParams.get("tf") === "5m" ? "5m" : "D";
  if (!/^[A-Z][A-Z0-9.\-/]{0,9}$/.test(symbol)) return NextResponse.json({ error: "Bad symbol" }, { status: 400 });
  const live = regularSession();
  const r = tf === "5m" ? await cachedFiveMinuteBars(symbol, 5, live ? 60_000 : 30 * 60_000) : await cachedDailyBars(symbol, live ? 5 * 60_000 : 6 * 3600_000);
  let bars = r.data ?? [];
  if (tf === "D" && bars.length) {
    const t = await todayBar(symbol).catch(() => null);
    if (t && t.time > bars[bars.length - 1].time) bars = [...bars, t];
    else if (t && t.time === bars[bars.length - 1].time) bars = [...bars.slice(0, -1), t];
  }
  return NextResponse.json({ symbol, tf, bars, error: r.error }, { headers: { "Cache-Control": "no-store" } });
}
