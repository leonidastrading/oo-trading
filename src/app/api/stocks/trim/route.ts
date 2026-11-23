import { NextResponse } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { trimDryToCap } from "@/lib/stocks/engine";

export const dynamic = "force-dynamic";

/** Trim dry-run positions over the "max position" % of the account down to it. Paper only: no orders. */
export async function POST() {
  const missing = requireKv();
  if (missing) return missing;
  try {
    return NextResponse.json(await trimDryToCap());
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, trimmed: [] }, { status: 502 });
  }
}
