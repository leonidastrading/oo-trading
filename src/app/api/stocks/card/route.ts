import { NextResponse, type NextRequest } from "next/server";
import { fetchCard } from "@/lib/stocks/scout";

export const dynamic = "force-dynamic";

/** Load a Trend Scout card to prefill the Stock Trades form. Read-only. */
export async function GET(req: NextRequest) {
  const r = await fetchCard(req.nextUrl.searchParams.get("id"));
  return NextResponse.json(r, { status: r.ok ? 200 : 422, headers: { "Cache-Control": "no-store" } });
}
