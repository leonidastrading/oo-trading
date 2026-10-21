import { requireKv } from "@/lib/apiGuard";
import { NextResponse } from "next/server";
import { KEYS, kv } from "@/lib/kv";
import type { OOTrade } from "@/lib/ooCsv";

export const dynamic = "force-dynamic";

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const [all, meta] = await Promise.all([
    kv().hgetall<OOTrade>(KEYS.ooTrades),
    kv().get<{ updatedAt: number; files: string[] }>(KEYS.ooMeta),
  ]);
  return NextResponse.json({ trades: Object.values(all), meta });
}
