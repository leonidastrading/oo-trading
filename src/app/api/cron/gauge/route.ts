import { requireKv } from "@/lib/apiGuard";
import { NextResponse, type NextRequest } from "next/server";
import { captureClose, captureDue, captureOpen } from "@/lib/gaugeCapture";

export const dynamic = "force-dynamic";

// 0DTE premium gauge captures, for an external scheduler (e.g. cron-job.org) at 10:00:00 and 16:01 ET on
// weekdays. Auth: `Authorization: Bearer <token>` (or `?key=<token>` for schedulers without headers), where the
// token is GAUGE_CRON_TOKEN (its own token, so CRON_SECRET needn't be shared) or CRON_SECRET.
// ?step=open|close forces a step; without it, whichever is due runs. Read-only market data; no orders.
export async function GET(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const tokens = [process.env.GAUGE_CRON_TOKEN, process.env.CRON_SECRET].filter((t): t is string => !!t);
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/, "").trim() ?? req.nextUrl.searchParams.get("key");
  if (!given || !tokens.includes(given)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const step = req.nextUrl.searchParams.get("step");
  try {
    if (step === "open") return NextResponse.json({ step, row: await captureOpen() });
    if (step === "close") return NextResponse.json({ step, row: await captureClose() });
    return NextResponse.json(await captureDue(Date.now(), { overwrite: true }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
