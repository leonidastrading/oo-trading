import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { KEYS, kv } from "@/lib/kv";
import { STRATEGIES, type Annotation } from "@/lib/scorecard";

export const dynamic = "force-dynamic";

// Mark/unmark a live entry (Schwab opening orderId) as a manual entry for a strategy.
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const body = (await req.json().catch(() => null)) as { orderId?: string; manual?: boolean; strategy?: string; note?: string } | null;
  if (!body?.orderId || !/^[\w-]{1,40}$/.test(body.orderId)) return NextResponse.json({ error: "orderId required" }, { status: 400 });
  if (!body.manual) {
    await kv().hdel(KEYS.annotations, body.orderId);
    return NextResponse.json({ ok: true, removed: body.orderId });
  }
  if (!body.strategy || !STRATEGIES.includes(body.strategy)) {
    return NextResponse.json({ error: `strategy must be one of: ${STRATEGIES.join(", ")}` }, { status: 400 });
  }
  const a: Annotation = { manual: true, strategy: body.strategy, note: body.note?.slice(0, 200), at: Date.now() };
  await kv().hset(KEYS.annotations, body.orderId, a);
  return NextResponse.json({ ok: true, annotation: a });
}
