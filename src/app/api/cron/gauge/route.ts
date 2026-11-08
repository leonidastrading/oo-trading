import { requireKv } from "@/lib/apiGuard";
import { NextResponse, type NextRequest } from "next/server";
import { captureClose, captureDue, captureOpen } from "@/lib/gaugeCapture";

export const dynamic = "force-dynamic";

// 0DTE premium gauge captures, for an external scheduler (e.g. cron-job.org) at 10:00:00 and 16:01 ET on
// weekdays. Auth: `Authorization: Bearer $CRON_SECRET` (or `?key=$CRON_SECRET` for schedulers without headers).
// ?step=open|close forces a step; without it, whichever is due runs. Read-only market data; no orders.
export async function GET(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? req.nextUrl.searchParams.get("key");
  if (!secret || given !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const step = req.nextUrl.searchParams.get("step");
  try {
    if (step === "open") return NextResponse.json({ step, row: await captureOpen() });
    if (step === "close") return NextResponse.json({ step, row: await captureClose() });
    return NextResponse.json(await captureDue(Date.now(), { overwrite: true }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
