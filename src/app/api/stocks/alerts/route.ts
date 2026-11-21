import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { dismissAlert } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const b = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!b?.id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await dismissAlert(b.id);
  return NextResponse.json({ ok: true });
}
