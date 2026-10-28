import { requireKv } from "@/lib/apiGuard";
import { NextResponse } from "next/server";
import { cachedDailyBars, type Bar } from "@/lib/schwab/data";
import { marketSession } from "@/lib/time";

export const dynamic = "force-dynamic";

export interface SpxDailyData {
  bars: Bar[];
  error: string | null;
}

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const phase = marketSession().phase;
  const res = await cachedDailyBars("$SPX", phase === "open" || phase === "final" ? 5 * 60_000 : 6 * 3600_000);
  const body: SpxDailyData = { bars: res.data ?? [], error: res.error ?? null };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
