import { NextResponse, type NextRequest } from "next/server";
import { stockQuotes } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

/** Live quote for the ticker being typed into the Stock Trades form. Read-only market data. */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-/]{0,9}$/.test(symbol)) return NextResponse.json({ error: "Bad symbol" }, { status: 400 });
  try {
    const q = (await stockQuotes([symbol]))[symbol] ?? null;
    return NextResponse.json({ quote: q, error: q ? undefined : `No quote for ${symbol}` }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ quote: null, error: (e as Error).message }, { headers: { "Cache-Control": "no-store" } });
  }
}
