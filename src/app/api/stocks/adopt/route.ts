import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { adoptPosition } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

/** Adopt a stock position opened outside the app (e.g. in the Schwab app while the API was down). */
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  const { preview, ...body } = raw;
  try {
    const r = await adoptPosition(body, { preview: preview === true });
    return NextResponse.json(r, { status: r.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ ok: false, errors: [(e as Error).message] }, { status: 502 });
  }
}
