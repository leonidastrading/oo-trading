import { NextResponse, type NextRequest } from "next/server";
import { KEYS, kv } from "@/lib/kv";
import { exchangeCode } from "@/lib/schwab/tokens";

export const dynamic = "force-dynamic";

// Schwab redirects here (SCHWAB_REDIRECT_URI). Also protected by the login session,
// and the one-time `state` must match the one we issued.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const back = (q: string) => NextResponse.redirect(new URL(`/settings?${q}`, req.url));
  if (!code || !state) return back("schwab=error&reason=missing_code");
  const store = kv();
  const known = await store.get(KEYS.oauthState(state));
  await store.del(KEYS.oauthState(state));
  if (!known) return back("schwab=error&reason=bad_state");
  try {
    await exchangeCode(code);
    return back("schwab=connected");
  } catch (e) {
    console.error("[schwab callback]", (e as Error).message);
    return back("schwab=error&reason=token_exchange");
  }
}
