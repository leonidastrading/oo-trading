import { requireKv } from "@/lib/apiGuard";
import { NextResponse } from "next/server";
import { listSnapshots } from "@/lib/eod";
import { weeklyRows, type WeekRow } from "@/lib/pnl";
import { realizedOn } from "@/lib/realized";
import { cachedAccount, cachedFillsSince, cachedTransfersSince, type Transfer } from "@/lib/schwab/data";
import { addDays, marketSession, todayET } from "@/lib/time";

export const dynamic = "force-dynamic";

// Earliest date to look at; the account's first fills are on 2026-10-19.
const since = () => process.env.PNL_SINCE ?? "2026-10-12";

export interface PnlData {
  meta: { now: number; errors: string[]; pollMs: number };
  account: string;
  netLiq: number | null;
  weeks: WeekRow[];
  transfers: Transfer[];
  from: string | null;
}

export async function GET() {
  const missing = requireKv();
  if (missing) return missing;
  const now = Date.now();
  const today = todayET(now);
  const open = marketSession(now).phase !== "closed";
  const errors: string[] = [];

  const [acct, fills, xfers, snaps] = await Promise.all([
    cachedAccount(open ? 60_000 : 30 * 60_000),
    cachedFillsSince(since(), open ? 5 * 60_000 : 6 * 3600_000),
    cachedTransfersSince(since(), open ? 30 * 60_000 : 6 * 3600_000),
    listSnapshots(),
  ]);
  if (acct.error) errors.push(acct.error);
  errors.push(...fills.errors, ...xfers.errors);

  const firstFill = fills.fills.reduce<string | null>((m, f) => (m === null || f.bookDate < m ? f.bookDate : m), null);
  const firstSnap = snaps[0]?.date ?? null;
  const from = [firstFill, firstSnap].filter((d): d is string => !!d).sort()[0] ?? null;

  const closes: Record<string, number> = {};
  const priorCloses: Record<string, number> = {};
  for (const s of snaps) {
    if (s.netLiq !== null) closes[s.date] = s.netLiq;
    if (s.startNetLiq !== null) priorCloses[s.date] = s.startNetLiq;
  }
  const netLiq = acct.data?.balances.netLiq ?? null;
  if (netLiq !== null) closes[today] = netLiq;

  const realized: Record<string, number> = {};
  if (from) {
    for (let d = from; d <= today; d = addDays(d, 1)) {
      const r = realizedOn(fills.fills, d).reduce((s, c) => s + (c.realized ?? 0), 0);
      if (r) realized[d] = r;
    }
  }
  const transfers: Record<string, number> = {};
  for (const t of xfers.transfers) transfers[t.date] = (transfers[t.date] ?? 0) + t.amount;

  const weeks = from ? weeklyRows({ closes, priorCloses, realized, transfers, from, today }) : [];
  const body: PnlData = {
    meta: { now, errors, pollMs: 5 * 60_000 },
    account: process.env.SCHWAB_ACCOUNT_LAST4 ?? "",
    netLiq,
    weeks,
    transfers: xfers.transfers.filter((t) => !from || t.date >= from),
    from,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
