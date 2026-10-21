import { requireKv } from "@/lib/apiGuard";
import { NextResponse } from "next/server";
import { listSnapshots, takeEodSnapshot } from "@/lib/eod";
import { lastSessionDate } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  return NextResponse.json({ snapshots: await listSnapshots() });
}

// Manual snapshot from Settings (the cron does this automatically at ~16:30 ET).
export async function POST() {
  const missing = requireKv();
  if (missing) return missing;
  try {
    const snap = await takeEodSnapshot(lastSessionDate());
    return NextResponse.json({ ok: true, date: snap.date });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
