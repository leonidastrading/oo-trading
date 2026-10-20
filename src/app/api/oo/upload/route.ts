import { NextResponse, type NextRequest } from "next/server";
import { KEYS, kv } from "@/lib/kv";
import { isValidTrade, tradeKey, type OOTrade } from "@/lib/ooCsv";

export const dynamic = "force-dynamic";

// Receives trades already parsed in the browser (same parser), in chunks.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { trades?: unknown[]; file?: string } | null;
  if (!body || !Array.isArray(body.trades)) return NextResponse.json({ error: "Expected { trades: [] }" }, { status: 400 });
  if (body.trades.length > 5000) return NextResponse.json({ error: "Max 5000 trades per request" }, { status: 413 });

  const valid = body.trades.filter(isValidTrade) as OOTrade[];
  const entries: [string, OOTrade][] = valid.map((t) => {
    const key = tradeKey(t);
    return [key, { ...t, key }];
  });
  const store = kv();
  const added = await store.hsetnxMany(KEYS.ooTrades, entries);
  const meta = (await store.get<{ updatedAt: number; files: string[] }>(KEYS.ooMeta)) ?? { updatedAt: 0, files: [] };
  if (body.file && !meta.files.includes(body.file)) meta.files.push(body.file);
  meta.updatedAt = Date.now();
  await store.set(KEYS.ooMeta, meta);
  return NextResponse.json({
    received: body.trades.length,
    invalid: body.trades.length - valid.length,
    added,
    duplicates: valid.length - added,
    total: await store.hlen(KEYS.ooTrades),
  });
}
