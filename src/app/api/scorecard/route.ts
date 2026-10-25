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
      : Promise.resolve({ fills: null, fetchedAt: null, errors: [token.lastError ?? "Schwab is not connected"], windows: [] }),
    kv().hgetall<OOTrade>(KEYS.ooTrades),
  ]);
  errors.push(...fills.errors);
  const ooTrades = Object.values(oo);
  const sc = buildScorecard(fills.fills ?? [], ooTrades, inception());
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
        schwabFills: fills.fills ? `${fills.fills.length} fills since ${inception()}` : null,
        schwabWindows: fills.windows,
        backtestTrades: ooTrades.length,
        backtestCoverageEnd: sc.coverageEnd,
        fillsByDay: Object.entries(
          (fills.fills ?? []).reduce<Record<string, Record<string, number>>>((m, f) => {
            const day = (m[f.bookDate] ??= {});
            day[f.type] = (day[f.type] ?? 0) + 1;
            return m;
          }, {}),
        ).sort(([a], [b]) => a.localeCompare(b)),
      },
      ...sc,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
