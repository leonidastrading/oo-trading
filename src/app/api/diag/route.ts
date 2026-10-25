// TEMPORARY read-only probe: which account holds the 2026-10-16 fills? (remove after use)
import { NextResponse } from "next/server";
import { schwabGet, type AccountNumber } from "@/lib/schwab/client";
import { etMidnightUtc } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET() {
  const accounts = await schwabGet<AccountNumber[]>("/trader/v1/accounts/accountNumbers");
  const out = [];
  for (const a of accounts) {
    const rows: Record<string, number> = {};
    for (const types of ["TRADE", "RECEIVE_AND_DELIVER"]) {
      const txs = await schwabGet<{ time?: string; tradeDate?: string }[]>(`/trader/v1/accounts/${a.hashValue}/transactions`, {
        startDate: etMidnightUtc("2026-10-14").toISOString(),
        endDate: etMidnightUtc("2026-10-20").toISOString(),
        types,
      });
      for (const t of Array.isArray(txs) ? txs : []) {
        const d = `${types}:${(t.time ?? t.tradeDate ?? "").slice(0, 10)}`;
        rows[d] = (rows[d] ?? 0) + 1;
      }
    }
    out.push({ account: `••${a.accountNumber.slice(-4)}`, counts: rows });
  }
  return NextResponse.json(out);
}
