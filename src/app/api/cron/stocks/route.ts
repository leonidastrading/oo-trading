import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { cronAuthorized } from "@/lib/cronAuth";
import { reconcile } from "@/lib/stocks/engine";
import { extendedSession } from "@/lib/stocks/rules";

export const dynamic = "force-dynamic";

// Stock Trades sync for an external scheduler (cron-job.org), every 5 minutes on weekdays 7:00–20:05 ET:
// fills, stop/target hits, unfilled entries, time exits and missing stops. Same token as the gauge job.
export async function GET(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Regular and extended hours (7:00–20:05 ET): extended-hours limit entries can fill then too.
  if (!extendedSession(Date.now() - 5 * 60_000) && !extendedSession()) return NextResponse.json({ skipped: "market closed" });
  try {
    return NextResponse.json(await reconcile());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
