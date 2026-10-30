import { requireKv } from "@/lib/apiGuard";
import { NextResponse, type NextRequest } from "next/server";
import { KEYS, kv } from "@/lib/kv";
import type { OOTrade } from "@/lib/ooCsv";

export const dynamic = "force-dynamic";

// Fill in opening VIX on stored trades from { "YYYY-MM-DD HH:MM:SS": vix } (VIX at a minute is the same
// for every strategy). Only trades without a VIX are touched.
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const body = (await req.json().catch(() => null)) as { vix?: Record<string, unknown> } | null;
  if (!body?.vix || typeof body.vix !== "object") return NextResponse.json({ error: "Expected { vix: { 'date time': number } }" }, { status: 400 });
  const map = new Map(Object.entries(body.vix).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])));
  const store = kv();
  const all = await store.hgetall<OOTrade>(KEYS.ooTrades);
  const patched: [string, unknown][] = [];
  for (const [key, t] of Object.entries(all)) {
    if (typeof t.vix === "number") continue;
    const v = map.get(`${t.dateOpened} ${t.timeOpened}`);
    if (v !== undefined) patched.push([key, { ...t, vix: v }]);
  }
  if (patched.length) await store.hsetMany(KEYS.ooTrades, patched);
  return NextResponse.json({ received: map.size, patched: patched.length, total: Object.keys(all).length });
}
