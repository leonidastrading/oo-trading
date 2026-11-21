import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { flattenAll } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

/** Close every Stock Trades position at market. Needs { confirm: "FLATTEN" }. */
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const b = (await req.json().catch(() => null)) as { confirm?: string } | null;
  if (b?.confirm !== "FLATTEN") return NextResponse.json({ error: 'Type FLATTEN to confirm' }, { status: 400 });
  try {
    return NextResponse.json(await flattenAll());
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
