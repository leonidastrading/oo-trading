import "server-only";
import type { NextRequest } from "next/server";

/**
 * External-scheduler auth (cron-job.org): `Authorization: Bearer <token>` or `?key=<token>`, where the token is
 * GAUGE_CRON_TOKEN (shareable with the scheduler) or CRON_SECRET.
 */
export function cronAuthorized(req: NextRequest): boolean {
  const tokens = [process.env.GAUGE_CRON_TOKEN, process.env.CRON_SECRET].filter((t): t is string => !!t);
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/, "").trim() ?? req.nextUrl.searchParams.get("key");
  return !!given && tokens.includes(given);
}
