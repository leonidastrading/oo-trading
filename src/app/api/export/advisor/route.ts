// Read-only export for the Book advisor's entry advisor (spx-ai-agent). GET only, Bearer OO_EXPORT_TOKEN
// (its own token: not OO_INGEST_TOKEN, not CRON_SECRET), outside the NextAuth session (see src/proxy.ts).
// Spec: spx-ai-agent docs/oo-trading-export.md; the advisor validates every response against its contract.
// No account identifiers leave this route; Schwab is only reached through the cached fetchers.
import { NextResponse, type NextRequest } from "next/server";
import { requireKv } from "@/lib/apiGuard";
import { bearerMatches } from "@/lib/bearerAuth";
import { ExportUnavailable, parseSince } from "@/lib/export/advisor";
import { loadAdvisorExport } from "@/lib/export/load";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  if (!bearerMatches(req, process.env.OO_EXPORT_TOKEN)) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const missing = requireKv();
  if (missing) return missing;
  const now = Date.now();
  const since = parseSince(req.nextUrl.searchParams.get("since"), now);
  if (since === null) return NextResponse.json({ error: "since must be an ISO timestamp" }, { status: 400, headers: NO_STORE });
  try {
    return NextResponse.json(await loadAdvisorExport(since, now), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof ExportUnavailable) return NextResponse.json({ error: e.message }, { status: 503, headers: NO_STORE });
    throw e;
  }
}
