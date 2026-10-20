// Normalized, cached Schwab data used by the Live/Today pages and the EOD cron.
import "server-only";
import { cached, type CacheResult } from "../cache";
import { normalizeTransactions, type Fill, type SchwabTransaction } from "../realized";
import { normalizePosition, type Position, type SchwabPosition } from "../spreads";
import { addDays, etMidnightUtc } from "../time";
import { getAccountHash, schwabGet } from "./client";

export interface Balances {
  netLiq: number | null;
  startNetLiq: number | null;
  buyingPower: number | null;
  optionBuyingPower: number | null;
  cash: number | null;
}

export interface AccountSnapshot {
  type: string;
  positions: Position[];
  balances: Balances;
}

interface RawAccount {
  securitiesAccount: {
    type?: string;
    positions?: SchwabPosition[];
    initialBalances?: Record<string, number>;
    currentBalances?: Record<string, number>;
  };
  aggregatedBalance?: { currentLiquidationValue?: number; liquidationValue?: number };
}

const num = (...xs: (number | undefined)[]) => xs.find((x) => typeof x === "number" && Number.isFinite(x)) ?? null;

export async function fetchAccount(): Promise<AccountSnapshot> {
  const hash = await getAccountHash();
  const raw = await schwabGet<RawAccount>(`/trader/v1/accounts/${hash}`, { fields: "positions" });
  const a = raw.securitiesAccount ?? {};
  const cur = a.currentBalances ?? {};
  const init = a.initialBalances ?? {};
  return {
    type: a.type ?? "",
    positions: (a.positions ?? []).map(normalizePosition),
    balances: {
      netLiq: num(cur.liquidationValue, raw.aggregatedBalance?.currentLiquidationValue),
      startNetLiq: num(init.liquidationValue, init.accountValue),
      buyingPower: num(cur.buyingPower, cur.availableFunds, cur.cashAvailableForTrading),
      optionBuyingPower: num(cur.optionBuyingPower, cur.buyingPowerNonMarginableTrade),
      cash: num(cur.cashBalance, cur.totalCash, cur.cashAvailableForTrading),
    },
  };
}

export interface Quote {
  symbol: string;
  last: number | null;
  change: number | null;
  changePct: number | null;
  prevClose: number | null;
  time: number | null;
}

type RawQuotes = Record<
  string,
  { quote?: { lastPrice?: number; mark?: number; netChange?: number; netPercentChange?: number; closePrice?: number; tradeTime?: number; quoteTime?: number } }
>;

export async function fetchQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const raw = await schwabGet<RawQuotes>("/marketdata/v1/quotes", { symbols: symbols.join(","), fields: "quote" });
  const out: Record<string, Quote> = {};
  for (const [sym, v] of Object.entries(raw)) {
    const q = v.quote ?? {};
    const last = num(q.lastPrice, q.mark);
    const prevClose = num(q.closePrice);
    const change = num(q.netChange) ?? (last !== null && prevClose !== null ? last - prevClose : null);
    out[sym] = {
      symbol: sym,
      last,
      change,
      changePct: num(q.netPercentChange) ?? (change !== null && prevClose ? (change / prevClose) * 100 : null),
      prevClose,
      time: num(q.tradeTime, q.quoteTime),
    };
  }
  return out;
}

/** Schwab quote symbol for an underlying (indexes need a "$" prefix). */
export function quoteSymbol(underlying: string): string {
  return ["SPX", "NDX", "RUT", "XSP", "VIX", "DJX"].includes(underlying) ? `$${underlying}` : underlying;
}

export const TX_LOOKBACK_DAYS = 10;

export async function fetchFills(refDate: string): Promise<Fill[]> {
  const hash = await getAccountHash();
  const raw = await schwabGet<SchwabTransaction[]>(`/trader/v1/accounts/${hash}/transactions`, {
    startDate: etMidnightUtc(addDays(refDate, -TX_LOOKBACK_DAYS)).toISOString(),
    endDate: new Date().toISOString(),
    types: "TRADE",
  });
  return normalizeTransactions(Array.isArray(raw) ? raw : []);
}

export function cachedAccount(maxAgeMs: number, force = false): Promise<CacheResult<AccountSnapshot>> {
  return cached("account", maxAgeMs, fetchAccount, { force });
}

export function cachedQuotes(symbols: string[], maxAgeMs: number, force = false): Promise<CacheResult<Record<string, Quote>>> {
  const key = "quotes:" + [...symbols].sort().join(",");
  return cached(key, maxAgeMs, () => fetchQuotes(symbols), { force });
}

export function cachedFills(refDate: string, maxAgeMs: number, force = false): Promise<CacheResult<Fill[]>> {
  return cached(`fills:${refDate}`, maxAgeMs, () => fetchFills(refDate), { force });
}
