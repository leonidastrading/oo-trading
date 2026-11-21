import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { cachedDailyBars, cachedFiveMinuteBars } from "@/lib/schwab/data";
import { regularSession } from "@/lib/stocks/rules";

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
  return NextResponse.json({ symbol, tf, bars: r.data ?? [], error: r.error }, { headers: { "Cache-Control": "no-store" } });
}
