import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { liveTradingEnabled } from "@/lib/schwab/trading";
import { loadSettings, updateSettings } from "@/lib/stocks/engine";
import { effectiveSettings, riskSizingActive, type StockSettings } from "@/lib/stocks/rules";

export const dynamic = "force-dynamic";

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const s = await loadSettings();
  const eff = effectiveSettings(s);
  return NextResponse.json({ settings: eff, riskLive: riskSizingActive(eff, "live"), pending: (s?.pending ?? []).filter((p) => p.effectiveAt > Date.now()), liveSwitch: liveTradingEnabled() });
}

/** Loosening a limit takes effect in 24 hours; tightening at once. Going live needs { dryRun: false, confirm: "LIVE" }. */
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const b = (await req.json().catch(() => null)) as (Partial<StockSettings> & { confirm?: string }) | null;
  if (!b) return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  const { confirm, ...patch } = b;
  if (patch.dryRun === false && confirm !== "LIVE") return NextResponse.json({ error: 'Type LIVE to switch dry run off' }, { status: 400 });
  const r = await updateSettings(patch);
  return NextResponse.json(r, { status: r.errors.length ? 422 : 200 });
}
