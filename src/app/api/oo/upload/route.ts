import { requireKv } from "@/lib/apiGuard";
import { NextResponse, type NextRequest } from "next/server";
import { KEYS, kv } from "@/lib/kv";
import { isValidTrade, tradeKey, tradeSlot, type OOTrade } from "@/lib/ooCsv";

export const dynamic = "force-dynamic";

// Receives trades already parsed in the browser (same parser), in chunks.
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const body = (await req.json().catch(() => null)) as { trades?: unknown[]; file?: string } | null;
  if (!body || !Array.isArray(body.trades)) return NextResponse.json({ error: "Expected { trades: [] }" }, { status: 400 });
  if (body.trades.length > 5000) return NextResponse.json({ error: "Max 5000 trades per request" }, { status: 413 });

  const valid = body.trades.filter(isValidTrade) as OOTrade[];
  const entries: [string, OOTrade][] = valid.map((t) => {
    const key = tradeKey(t);
    return [key, { ...t, key }];
  });
  const store = kv();
  // Latest upload wins: an entry already stored from another run (same strategy, date and time) is replaced.
  const existing = await store.hgetall<OOTrade>(KEYS.ooTrades);
  const slots = new Set(entries.map(([, t]) => tradeSlot(t)));
  const keys = new Set(entries.map(([k]) => k));
  const replaced = Object.entries(existing)
    .filter(([k, t]) => slots.has(tradeSlot(t)) && !keys.has(k))
    .map(([k]) => k);
  if (replaced.length) await store.hdel(KEYS.ooTrades, ...replaced);
  const added = entries.filter(([k]) => !(k in existing)).length;
  await store.hsetMany(KEYS.ooTrades, entries);
  const meta = (await store.get<{ updatedAt: number; files: string[] }>(KEYS.ooMeta)) ?? { updatedAt: 0, files: [] };
  if (body.file && !meta.files.includes(body.file)) meta.files.push(body.file);
  meta.updatedAt = Date.now();
  await store.set(KEYS.ooMeta, meta);
  return NextResponse.json({
    received: body.trades.length,
    invalid: body.trades.length - valid.length,
    added,
    replaced: replaced.length,
    duplicates: valid.length - added,
    total: await store.hlen(KEYS.ooTrades),
  });
}
