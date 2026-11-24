import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { changeStop, changeTarget, closeTrade, savePostMortem, setTradeCard, triggerAdd } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

/** Change one trade: tighten the stop, change the target, trigger the planned add, close it, or file its post-mortem. */
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const b = (await req.json().catch(() => null)) as { id?: string; action?: string; value?: unknown; note?: string; postMortem?: Record<string, unknown> } | null;
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
            : b.action === "add"
              ? await triggerAdd(b.id, v, String(b.note ?? ""))
              : b.action === "postmortem"
                ? await savePostMortem(b.id, b.postMortem ?? {})
                : b.action === "card"
                  ? await setTradeCard(b.id, b.value)
                  : { ok: false, error: "Unknown action" };
    return NextResponse.json(r, { status: r.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
