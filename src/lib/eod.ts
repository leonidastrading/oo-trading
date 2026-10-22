// End-of-day snapshots (written by the 16:30 ET cron) for history without OO CSVs.
import "server-only";
import { KEYS, kv } from "./kv";
import { realizedOn } from "./realized";
import { cachedAccount, cachedFills, cachedQuotes } from "./schwab/data";
import { settlementSymbols, splitExpired } from "./views";

export interface EodSnapshot {
  date: string;
  takenAt: number;
  netLiq: number | null;
  startNetLiq: number | null;
  dayPl: number | null;
  realized: number;
  openPl: number;
  positions: { symbol: string; qty: number; mark: number; avgPrice: number; plOpen: number; plDay: number }[];
}

export async function takeEodSnapshot(date: string): Promise<EodSnapshot> {
  const acct = await cachedAccount(0, true);
  if (!acct.data || acct.error) throw new Error(acct.error ?? "No account data");
  const fills = await cachedFills(date, 0, true);
  const symbols = settlementSymbols(acct.data.positions, date);
  const quotes = symbols.length ? await cachedQuotes(["$SPX", ...symbols.filter((s) => s !== "$SPX")], 60_000) : null;
  // Expired cash-settled options count as realized at the settlement price.
  const expired = splitExpired(acct.data.positions, fills.data ?? [], quotes?.data, Date.now());
  const realized = realizedOn(fills.data ?? [], date).reduce((s, c) => s + (c.realized ?? 0), 0) + expired.realized;
  const b = acct.data.balances;
  const snap: EodSnapshot = {
    date,
    takenAt: Date.now(),
    netLiq: b.netLiq,
    startNetLiq: b.startNetLiq,
    dayPl: b.netLiq !== null && b.startNetLiq !== null ? Math.round((b.netLiq - b.startNetLiq) * 100) / 100 : null,
    realized: Math.round(realized * 100) / 100,
    openPl: Math.round(expired.open.reduce((s, p) => s + p.plOpen, 0) * 100) / 100,
    positions: acct.data.positions.map((p) => ({
      symbol: p.symbol, qty: p.qty, mark: p.mark, avgPrice: p.avgPrice, plOpen: p.plOpen, plDay: p.plDay,
    })),
  };
  await kv().hset(KEYS.eod, date, snap);
  return snap;
}

export async function listSnapshots(): Promise<EodSnapshot[]> {
  const all = await kv().hgetall<EodSnapshot>(KEYS.eod);
  return Object.values(all).sort((a, b) => a.date.localeCompare(b.date));
}

export async function hasSnapshot(date: string): Promise<boolean> {
  const all = await kv().hgetall<EodSnapshot>(KEYS.eod);
  return date in all;
}
