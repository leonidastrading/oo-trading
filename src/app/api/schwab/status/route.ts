import { NextResponse } from "next/server";
import { cacheAge } from "@/lib/cache";
import { KEYS, KV_MISSING, kv, kvConfigured } from "@/lib/kv";
import { rateUsage, RATE_LIMIT_PER_MIN } from "@/lib/schwab/client";
import { tokenStatus, tokenStatusFrom } from "@/lib/schwab/tokens";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!kvConfigured()) {
    return NextResponse.json({
      now: Date.now(),
      setupError: KV_MISSING,
      token: tokenStatusFrom(null),
      accountLast4: process.env.SCHWAB_ACCOUNT_LAST4 ?? null,
      configured: {
        clientId: !!process.env.SCHWAB_CLIENT_ID,
        clientSecret: !!process.env.SCHWAB_CLIENT_SECRET,
        redirectUri: process.env.SCHWAB_REDIRECT_URI ?? null,
      },
      rate: { usedThisMinute: 0, limit: RATE_LIMIT_PER_MIN },
      backoffUntil: null,
      accountFetchedAt: null,
    });
  }
  const [token, usage, accountAt, backoff] = await Promise.all([
    tokenStatus(),
    rateUsage(),
    cacheAge("account"),
    kv().get<{ until: number }>(KEYS.backoff),
  ]);
  return NextResponse.json({
    now: Date.now(),
    token,
    accountLast4: process.env.SCHWAB_ACCOUNT_LAST4 ?? null,
    configured: {
      clientId: !!process.env.SCHWAB_CLIENT_ID,
      clientSecret: !!process.env.SCHWAB_CLIENT_SECRET,
      redirectUri: process.env.SCHWAB_REDIRECT_URI ?? null,
    },
    rate: { usedThisMinute: usage, limit: RATE_LIMIT_PER_MIN },
    backoffUntil: backoff && backoff.until > Date.now() ? backoff.until : null,
    accountFetchedAt: accountAt,
  });
}
