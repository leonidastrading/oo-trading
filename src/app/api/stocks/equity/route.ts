import { NextResponse } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { equitySamples } from "@/lib/stocks/engine";
import { todayET } from "@/lib/time";

export const dynamic = "force-dynamic";

/** Today's open-P/L samples (one a minute in the regular session) for the intraday equity curve. Read-only. */
export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const date = todayET();
  return NextResponse.json({ date, samples: await equitySamples(date) }, { headers: { "Cache-Control": "no-store" } });
}
