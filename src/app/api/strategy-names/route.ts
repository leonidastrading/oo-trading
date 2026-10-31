import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { KEYS, kv } from "@/lib/kv";
import { cleanName, NAMEABLE } from "@/lib/strategyNames";

export const dynamic = "force-dynamic";

// Display names for the book strategies (canonical → display). Private like every non-auth route.
export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const names = await kv().hgetall<string>(KEYS.strategyNames);
  return NextResponse.json({ strategies: NAMEABLE, names: Object.fromEntries(Object.entries(names).filter(([k]) => NAMEABLE.includes(k))) });
}

/** Body: { names: { [canonical]: display } }; an empty display name restores the default. */
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const body = (await req.json().catch(() => null)) as { names?: Record<string, unknown> } | null;
  if (!body?.names || typeof body.names !== "object") return NextResponse.json({ error: "names required" }, { status: 400 });
  const set: [string, string][] = [];
  const clear: string[] = [];
  for (const [k, v] of Object.entries(body.names)) {
    if (!NAMEABLE.includes(k)) return NextResponse.json({ error: `unknown strategy: ${k}` }, { status: 400 });
    const name = cleanName(v);
    if (name && name !== k) set.push([k, name]);
    else clear.push(k);
  }
  if (set.length) await kv().hsetMany(KEYS.strategyNames, set);
  if (clear.length) await kv().hdel(KEYS.strategyNames, ...clear);
  return GET();
}
