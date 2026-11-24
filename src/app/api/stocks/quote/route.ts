import { NextResponse, type NextRequest } from "next/server";
import { cached } from "@/lib/cache";
import { stockQuotes } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

/** Live quote for the ticker being typed into the Stock Trades form. Read-only market data. */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-/]{0,9}$/.test(symbol)) return NextResponse.json({ error: "Bad symbol" }, { status: 400 });
  try {
    // Shared 10 s cache: the form polls this, and several open forms/tabs shouldn't each hit Schwab.
    const r = await cached(`stocks:quote:${symbol}`, 10_000, () => stockQuotes([symbol]));
    if (!r.data) throw new Error(r.error ?? "No quote");
    const q = r.data[symbol] ?? null;
    return NextResponse.json({ quote: q, error: q ? undefined : `No quote for ${symbol}` }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ quote: null, error: (e as Error).message }, { headers: { "Cache-Control": "no-store" } });
  }
}
