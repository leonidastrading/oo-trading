// Write-only endpoint for the automated backtest refresh (Bearer OO_INGEST_TOKEN).
// Upserts trades by strategy + date/time opened, so a re-run with different contract
// counts replaces the old rows instead of duplicating them.
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { KEYS, kv } from "@/lib/kv";
import { fillVix, rememberVix } from "@/lib/ooVix";
import { isValidTrade, tradeKey, tradeSlot, type OOTrade } from "@/lib/ooCsv";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const token = process.env.OO_INGEST_TOKEN;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token || !given) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(token), h(given));
}

const slot = tradeSlot;

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const missing = requireKv();
  if (missing) return missing;
  const body = (await req.json().catch(() => null)) as { trades?: unknown[]; source?: string } | null;
  if (!body || !Array.isArray(body.trades)) return NextResponse.json({ error: "Expected { trades: [] }" }, { status: 400 });
  if (body.trades.length > 5000) return NextResponse.json({ error: "Max 5000 trades per request" }, { status: 413 });

  const now = Date.now();
  const valid = body.trades.filter(isValidTrade).map((t) => ({ ...t, key: tradeKey(t), source: body.source ?? "OO auto-refresh", uploadedAt: now }));
  const store = kv();
  await rememberVix(valid);
  await fillVix(valid);
  const existing = await store.hgetall<OOTrade>(KEYS.ooTrades);
  const incomingSlots = new Set(valid.map(slot));
  const incomingKeys = new Set(valid.map((t) => t.key));
  const replaced = Object.entries(existing)
    .filter(([key, t]) => incomingSlots.has(slot(t)) && !incomingKeys.has(key))
    .map(([key]) => key);
  if (replaced.length) await store.hdel(KEYS.ooTrades, ...replaced);
  const fresh = valid.filter((t) => !(t.key in existing));
  await store.hsetnxMany(KEYS.ooTrades, fresh.map((t) => [t.key, t] as [string, unknown]));
  // Fill in Margin Req. / opening VIX on trades stored before the feed carried them.
  for (const t of valid) {
    const old = existing[t.key];
    if (!old) continue;
    const patch: Partial<OOTrade> = {};
    if (typeof t.margin === "number" && typeof old.margin !== "number") patch.margin = t.margin;
    if (typeof t.vix === "number" && typeof old.vix !== "number") patch.vix = t.vix;
    if (Object.keys(patch).length) await store.hset(KEYS.ooTrades, t.key, { ...old, ...patch });
  }

  const meta = (await store.get<{ updatedAt: number; files: string[]; autoRefreshedAt?: number }>(KEYS.ooMeta)) ?? { updatedAt: 0, files: [] };
  const source = body.source ?? "OO auto-refresh";
  if (!meta.files.includes(source)) meta.files.push(source);
  meta.updatedAt = meta.autoRefreshedAt = Date.now();
  await store.set(KEYS.ooMeta, meta);
  return NextResponse.json({
    received: body.trades.length,
    invalid: body.trades.length - valid.length,
    added: fresh.length,
    replaced: replaced.length,
    unchanged: valid.length - fresh.length,
    total: await store.hlen(KEYS.ooTrades),
  });
}
