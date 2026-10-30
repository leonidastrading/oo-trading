import { requireKv } from "@/lib/apiGuard";
import { NextResponse } from "next/server";
import { KEYS, kv } from "@/lib/kv";
import type { OOTrade } from "@/lib/ooCsv";
import { fillVix } from "@/lib/ooVix";

export const dynamic = "force-dynamic";

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const [all, meta] = await Promise.all([
    kv().hgetall<OOTrade>(KEYS.ooTrades),
    kv().get<{ updatedAt: number; files: string[] }>(KEYS.ooMeta),
  ]);
  const trades = Object.values(all);
  await fillVix(trades);
  return NextResponse.json({ trades, meta });
}
