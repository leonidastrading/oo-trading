import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { setKillSwitch } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const b = (await req.json().catch(() => null)) as { on?: boolean } | null;
  if (typeof b?.on !== "boolean") return NextResponse.json({ error: "Expected { on: true|false }" }, { status: 400 });
  try {
    return NextResponse.json(await setKillSwitch(b.on));
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
