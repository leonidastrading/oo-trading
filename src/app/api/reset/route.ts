import { NextResponse, type NextRequest } from "next/server";
import { KEYS, kv } from "@/lib/kv";

export const dynamic = "force-dynamic";

const TARGETS = {
  trades: [KEYS.ooTrades, KEYS.ooMeta],
  snapshots: [KEYS.eod],
  schwab: [KEYS.tokens, KEYS.accountHash, KEYS.backoff],
} as const;

export async function POST(req: NextRequest) {
  const { what, confirm } = ((await req.json().catch(() => ({}))) ?? {}) as { what?: string; confirm?: string };
  if (!what || !(what in TARGETS)) return NextResponse.json({ error: "Unknown reset target" }, { status: 400 });
  if (confirm !== "RESET") return NextResponse.json({ error: "Confirmation required" }, { status: 400 });
  await kv().del(...TARGETS[what as keyof typeof TARGETS]);
  return NextResponse.json({ ok: true, reset: what });
}
