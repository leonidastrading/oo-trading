import { NextResponse } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { cached } from "@/lib/cache";
import { cachedQuotes } from "@/lib/schwab/data";
import { accountValue, loadTrades, tradingAccount } from "@/lib/stocks/engine";
import { normSymbol, sectorMap, sp500Breadth, type Breadth } from "@/lib/stocks/market";
import { portfolioStats, type PortfolioStats, type PositionIn } from "@/lib/stocks/portfolio";
import { regularSession } from "@/lib/stocks/rules";

export const dynamic = "force-dynamic";

export interface PortfolioData {
  stats: PortfolioStats;
  accountValue: number | null;
  breadth: Breadth | null;
  notes: string[];
}

/** Portfolio stats for the open stock positions: long/short, sectors, and breadth (holdings and S&P 500). Read-only. */
export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const notes: string[] = [];
  const open = (await loadTrades()).filter((t) => (t.status === "open" || t.status === "closing") && t.entryPrice);
  const tickers = [...new Set(open.map((t) => t.ticker))].sort();
  const live = regularSession();
  const [quotes, sectors, breadth, acct] = await Promise.all([
    tickers.length ? cachedQuotes(tickers, live ? 60_000 : 15 * 60_000) : Promise.resolve({ data: {}, error: null }),
    sectorMap().catch((e: Error) => ({ data: null, error: e.message })),
    sp500Breadth(live ? 5 * 60_000 : 60 * 60_000).catch((e: Error) => ({ data: null, error: e.message })),
    tradingAccount()
      .then((a) => cached("stocks:account-value", 15 * 60_000, () => accountValue(a)))
      .then((r) => r.data ?? null)
      .catch(() => null),
  ]);
  if (quotes.error) notes.push(`Quotes: ${quotes.error}`);
  if (!sectors.data) notes.push(`Sectors unavailable${sectors.error ? ` (${sectors.error})` : ""}`);
  if (!breadth.data) notes.push(`S&P 500 breadth unavailable${breadth.error ? ` (${breadth.error})` : ""}`);
  const q = (quotes.data ?? {}) as Record<string, { last: number | null; changePct: number | null }>;
  const positions: PositionIn[] = open.map((t) => {
    const dry = t.mode === "dry";
    const addOn = t.add?.status === "filled" ? (dry ? t.add.shadowShares : t.add.liveShares) : 0;
    const shares = (dry ? t.shadowShares : t.shares) + addOn;
    const px = q[t.ticker]?.last ?? t.entryPrice!;
    const idx = sectors.data?.map[normSymbol(t.ticker)];
    return { ticker: t.ticker, long: t.direction === "long", value: shares * px, dayPct: q[t.ticker]?.changePct ?? null, sector: idx === undefined ? "" : (sectors.data?.sectors[idx] ?? "") };
  });
  const body: PortfolioData = { stats: portfolioStats(positions), accountValue: acct, breadth: breadth.data ?? null, notes };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
