// Everything is private: require a NextAuth session for every page and API route
// except the sign-in flow itself and the cron endpoint (which checks CRON_SECRET).
import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedEmail } from "@/lib/allowed";
import { sessionsValidAfter } from "@/lib/sessionEpoch";

// /api/ingest/ checks its own bearer token (write-only backtest refresh).
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/api/cron/", "/api/ingest/"];

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) return NextResponse.next();

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (token && isAllowedEmail(token.email)) {
    const validAfter = await sessionsValidAfter();
    if (!validAfter || Number(token.authAt ?? 0) >= validAfter) return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?callbackUrl=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|manifest.webmanifest).*)"],
};
