import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { cleanSmas, DEFAULT_SMAS } from "@/lib/chartSmas";
import { KEYS, kv } from "@/lib/kv";

export const dynamic = "force-dynamic";

// Which SMA lines the main chart shows (saved for every device).
export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const raw = await kv().get<unknown>(KEYS.chartSmas);
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return NextResponse.json({ smas: cleanSmas(parsed) ?? DEFAULT_SMAS });
}

export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const body = (await req.json().catch(() => null)) as { smas?: unknown } | null;
  const smas = cleanSmas(body?.smas);
  if (!smas) return NextResponse.json({ error: "smas (list of periods) required" }, { status: 400 });
  await kv().set(KEYS.chartSmas, JSON.stringify(smas));
  return NextResponse.json({ smas });
}
