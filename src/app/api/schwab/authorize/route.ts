import { requireKv } from "@/lib/apiGuard";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { KEYS, kv } from "@/lib/kv";
import { authorizeUrl } from "@/lib/schwab/tokens";

export const dynamic = "force-dynamic";

// Starts the Schwab OAuth flow (requires a dashboard session via proxy.ts).
export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const state = randomBytes(24).toString("hex");
  await kv().set(KEYS.oauthState(state), 1, { ex: 600 });
  return NextResponse.redirect(authorizeUrl(state));
}
