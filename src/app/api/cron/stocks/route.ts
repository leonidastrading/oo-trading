import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { cronAuthorized } from "@/lib/cronAuth";
import { reconcile } from "@/lib/stocks/engine";
import { regularSession } from "@/lib/stocks/rules";

export const dynamic = "force-dynamic";

// Stock Trades sync for an external scheduler (cron-job.org), every 5 minutes on weekdays 9:30–16:05 ET:
// fills, stop/target hits, unfilled entries, time exits and missing stops. Same token as the gauge job.
export async function GET(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!regularSession(Date.now() - 5 * 60_000) && !regularSession()) return NextResponse.json({ skipped: "market closed" });
  try {
    return NextResponse.json(await reconcile());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
