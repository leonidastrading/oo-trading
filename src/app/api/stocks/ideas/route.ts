import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { submitIdea } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

/** Submit a trade idea. Every guardrail runs here on the server; the request can't set size or skip a check. */
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return NextResponse.json({ error: "Expected a JSON idea" }, { status: 400 });
  const { preview, ...body } = raw;
  try {
    // { preview: true } runs every check and sizes it without logging or sending; a real submit re-runs them all.
    const r = await submitIdea(body, { preview: preview === true });
    return NextResponse.json(r, { status: r.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
