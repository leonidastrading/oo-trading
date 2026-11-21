import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { changeStop, changeTarget, closeTrade } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

/** Change one trade: tighten the stop, change the target, or close it at market. */
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const b = (await req.json().catch(() => null)) as { id?: string; action?: string; value?: unknown } | null;
  if (!b?.id) return NextResponse.json({ error: "Missing trade id" }, { status: 400 });
  const v = Number(b.value);
  try {
    const r =
      b.action === "stop"
        ? await changeStop(b.id, v)
        : b.action === "target"
          ? await changeTarget(b.id, v)
          : b.action === "close"
            ? await closeTrade(b.id, "manual")
            : { ok: false, error: "Unknown action" };
    return NextResponse.json(r, { status: r.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
