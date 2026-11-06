import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { KEYS, kv } from "@/lib/kv";
import { optionsOnly } from "@/lib/views";

export const dynamic = "force-dynamic";

// Live/Today: show option positions only (default) or every holding.
export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  return NextResponse.json({ optionsOnly: await optionsOnly() });
}

export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const body = (await req.json().catch(() => null)) as { optionsOnly?: unknown } | null;
  if (typeof body?.optionsOnly !== "boolean") return NextResponse.json({ error: "optionsOnly (boolean) required" }, { status: 400 });
  await kv().set(KEYS.optionsOnly, body.optionsOnly ? "1" : "0");
  return NextResponse.json({ optionsOnly: body.optionsOnly });
}
