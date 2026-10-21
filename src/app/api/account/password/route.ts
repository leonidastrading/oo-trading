import { requireKv } from "@/lib/apiGuard";
import { NextResponse, type NextRequest } from "next/server";
import { checkPassword, MIN_PASSWORD_LENGTH, passwordChangedAt, setPassword, tooManyFailures } from "@/lib/password";

export const dynamic = "force-dynamic";

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  return NextResponse.json({ changedAt: await passwordChangedAt(), minLength: MIN_PASSWORD_LENGTH });
}

// Session-protected by proxy.ts; also requires the current password.
export async function POST(req: NextRequest) {
  const missing = requireKv();
  if (missing) return missing;
  const { current, next } = ((await req.json().catch(() => ({}))) ?? {}) as { current?: string; next?: string };
  if (typeof current !== "string" || typeof next !== "string") {
    return NextResponse.json({ error: "Enter your current and new password." }, { status: 400 });
  }
  if (await tooManyFailures(false)) {
    return NextResponse.json({ error: "Too many failed attempts. Try again in 15 minutes." }, { status: 429 });
  }
  if (!(await checkPassword(current))) {
    await tooManyFailures(true);
    return NextResponse.json({ error: "Current password is wrong." }, { status: 403 });
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
  }
  if (next === current) return NextResponse.json({ error: "New password must be different." }, { status: 400 });
  await setPassword(next);
  return NextResponse.json({ ok: true });
}
