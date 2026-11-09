import { requireKv } from "@/lib/apiGuard";
import { NextResponse, type NextRequest } from "next/server";
import { cronAuthorized } from "@/lib/cronAuth";
import { getLiveData } from "@/lib/views";

export const dynamic = "force-dynamic";

// Day P/L curve sampler for an external scheduler (cron-job.org), every minute on weekdays 9:30–16:15 ET.
// Loading the live data records the minute's sample (only while the market is open); the Live page does the
// same whenever it is open, so this just keeps the curve going with no page open. Read-only; no orders.
export async function GET(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const d = await getLiveData();
  const last = d.dayCurve.samples.at(-1) ?? null;
  return NextResponse.json({ phase: d.meta.phase, samples: d.dayCurve.samples.length, last, errors: d.meta.errors });
}
