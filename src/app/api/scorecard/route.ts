import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { takeManualRefresh } from "@/lib/cache";
import { KEYS, kv } from "@/lib/kv";
import type { OOTrade } from "@/lib/ooCsv";
import { cachedFillsSince } from "@/lib/schwab/data";
import { tokenStatus } from "@/lib/schwab/tokens";
import { buildScorecard } from "@/lib/scorecard";
import { MANUAL_REFRESH_MIN_MS, marketSession } from "@/lib/time";

export const dynamic = "force-dynamic";

/** First live day of the book. */
const inception = () => process.env.LIVE_SINCE ?? "2026-10-16";

export async function GET(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const errors: string[] = [];
  const session = marketSession();
  const wantsForce = req.nextUrl.searchParams.get("force") === "1";
  const force = wantsForce && (await takeManualRefresh("scorecard", MANUAL_REFRESH_MIN_MS));
  const token = await tokenStatus();
  const [fills, oo] = await Promise.all([
    token.connected
      ? cachedFillsSince(inception(), session.phase === "closed" ? 6 * 3600_000 : 5 * 60_000, force)
      : Promise.resolve({ data: null, fetchedAt: null, error: token.lastError ?? "Schwab is not connected" }),
    kv().hgetall<OOTrade>(KEYS.ooTrades),
  ]);
  if (fills.error) errors.push(fills.error);
  const ooTrades = Object.values(oo);
  const sc = buildScorecard(fills.data ?? [], ooTrades, inception());
  return NextResponse.json(
    {
      meta: {
        now: Date.now(),
        phase: session.phase,
        pollMs: session.phase === "closed" ? null : 5 * 60_000,
        errors,
        delayed: false,
        manualRefreshBlocked: wantsForce && !force,
      },
      fetchedAt: fills.fetchedAt,
      sources: {
        schwabFills: fills.data ? `${fills.data.length} fills since ${inception()}` : null,
        backtestTrades: ooTrades.length,
        backtestCoverageEnd: sc.coverageEnd,
      },
      ...sc,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
