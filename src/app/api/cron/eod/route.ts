import { requireKv } from "@/lib/apiGuard";
import { NextResponse, type NextRequest } from "next/server";
import { hasSnapshot, takeEodSnapshot } from "@/lib/eod";
import { etParts, isTradingDay } from "@/lib/time";

export const dynamic = "force-dynamic";

// Vercel Cron (see vercel.json) calls this with `Authorization: Bearer $CRON_SECRET`.
// Two UTC schedules cover EDT and EST; we only act between 16:15 and 18:00 ET, once per day.
export async function GET(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const p = etParts();
  const force = req.nextUrl.searchParams.get("force") === "1";
  if (!force) {
    if (!isTradingDay(p.date)) return NextResponse.json({ skipped: "not a trading day", date: p.date });
    if (p.minutesOfDay < 16 * 60 + 15 || p.minutesOfDay >= 18 * 60) {
      return NextResponse.json({ skipped: "outside 16:15–18:00 ET window", date: p.date });
    }
    if (await hasSnapshot(p.date)) return NextResponse.json({ skipped: "already saved", date: p.date });
  }
  try {
    const snap = await takeEodSnapshot(p.date);
    return NextResponse.json({ ok: true, date: snap.date, netLiq: snap.netLiq, dayPl: snap.dayPl });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
