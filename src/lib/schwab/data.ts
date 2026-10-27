// Normalized, cached Schwab data used by the Live/Today pages and the EOD cron.
import "server-only";
import { cached, type CacheResult } from "../cache";
import { normalizeTransactions, type Fill, type SchwabTransaction } from "../realized";
import { normalizePosition, type Position, type SchwabPosition } from "../spreads";
import { addDays, etMidnightUtc, todayET } from "../time";
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

export interface Bar {
  /** Bar open time, epoch seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Regular-session 1-minute bars for one ET date. */
export async function fetchMinuteBars(symbol: string, date: string): Promise<Bar[]> {
  const start = etMidnightUtc(date).getTime();
  const raw = await schwabGet<{ candles?: { open: number; high: number; low: number; close: number; datetime: number }[] }>(
    "/marketdata/v1/pricehistory",
    {
      symbol,
      periodType: "day",
      frequencyType: "minute",
      frequency: "1",
      startDate: String(start),
      endDate: String(start + 86_400_000),
      needExtendedHoursData: "false",
    },
  );
  return (raw.candles ?? [])
    .filter((c) => c.datetime >= start && c.datetime < start + 86_400_000)
    .map((c) => ({ time: Math.floor(c.datetime / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
}

export function cachedMinuteBars(symbol: string, date: string, maxAgeMs: number): Promise<CacheResult<Bar[]>> {
  return cached(`bars1m:v1:${symbol}:${date}`, maxAgeMs, () => fetchMinuteBars(symbol, date), {
    keepSeconds: date < todayET() ? 7 * 86_400 : undefined,
  });
}

/** Schwab quote symbol for an underlying (indexes need a "$" prefix). */
export function quoteSymbol(underlying: string): string {
  return ["SPX", "NDX", "RUT", "XSP", "VIX", "DJX"].includes(underlying) ? `$${underlying}` : underlying;
}

export const TX_LOOKBACK_DAYS = 10;

/** Commission + fees per option contract, per side (default $0.88). */
export function feePerContract(): number {
  const v = Number(process.env.FEE_PER_CONTRACT);
  return Number.isFinite(v) && v >= 0 && process.env.FEE_PER_CONTRACT !== "" && process.env.FEE_PER_CONTRACT !== undefined ? v : 0.88;
}

export async function fetchFills(refDate: string): Promise<Fill[]> {
  const hash = await getAccountHash();
  const raw = await schwabGet<SchwabTransaction[]>(`/trader/v1/accounts/${hash}/transactions`, {
    startDate: etMidnightUtc(addDays(refDate, -TX_LOOKBACK_DAYS)).toISOString(),
    endDate: new Date().toISOString(),
    types: "TRADE",
  });
  return normalizeTransactions(Array.isArray(raw) ? raw : [], feePerContract());
}

/** Raw TRADE + RECEIVE_AND_DELIVER (expirations/cash settlements) transactions in [from, to). */
async function fetchTransactionsWindow(from: Date, to: Date): Promise<SchwabTransaction[]> {
  const hash = await getAccountHash();
  const lists = await Promise.all(
    ["TRADE", "RECEIVE_AND_DELIVER"].map((types) =>
      schwabGet<SchwabTransaction[]>(`/trader/v1/accounts/${hash}/transactions`, {
        startDate: from.toISOString(),
        endDate: to.toISOString(),
        types,
      }),
    ),
  );
  return lists.flatMap((l) => (Array.isArray(l) ? l : []));
}

export interface FillsSince {
  fills: Fill[];
  fetchedAt: number | null;
  errors: string[];
  windows: { from: string; to: string; transactions: number | null; fetchedAt: number | null }[];
}

export const FILL_WINDOW_DAYS = 7;

/**
 * All fills from `start` (ET date) to now, fetched in 7-day windows. Each window is cached
 * on its own: finished windows are kept for a year and never refetched, so only the current
 * week hits Schwab on refresh, and one short response can't hide a whole period.
 */
export async function cachedFillsSince(start: string, liveMaxAgeMs: number, force = false): Promise<FillsSince> {
  const yearAgo = todayET(Date.now() - 364 * 86_400_000);
  let from = start > yearAgo ? start : yearAgo;
  const today = todayET();
  const settledBefore = addDays(today, -1); // settlements post overnight, so yesterday may still change
  const windows: FillsSince["windows"] = [];
  const raw: SchwabTransaction[] = [];
  const errors: string[] = [];
  let fetchedAt: number | null = null;
  while (from <= today) {
    const to = addDays(from, FILL_WINDOW_DAYS);
    const done = to <= settledBefore;
    const res = await cached(
      `txwin:v1:${from}:${to}`,
      done ? Infinity : liveMaxAgeMs,
      () => fetchTransactionsWindow(etMidnightUtc(from), to > today ? new Date() : etMidnightUtc(to)),
      { force: force && !done, keepSeconds: done ? 400 * 86_400 : undefined },
    );
    if (res.error && !errors.includes(res.error)) errors.push(res.error);
    raw.push(...(res.data ?? []));
    windows.push({ from, to, transactions: res.data?.length ?? null, fetchedAt: res.fetchedAt });
    if (res.fetchedAt) fetchedAt = fetchedAt === null ? res.fetchedAt : Math.min(fetchedAt, res.fetchedAt);
    from = to;
  }
  // Windows can overlap at the boundary instant; drop duplicate activities.
  const seen = new Set<string>();
  const unique = raw.filter((t) => {
    const k = `${t.activityId ?? ""}|${t.time ?? ""}|${t.orderId ?? ""}|${t.netAmount ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { fills: normalizeTransactions(unique, feePerContract()), fetchedAt, errors, windows };
}

/** Schwab transaction types that move money in or out of the account (not P/L). */
const TRANSFER_TYPES = ["ACH_RECEIPT", "ACH_DISBURSEMENT", "CASH_RECEIPT", "CASH_DISBURSEMENT", "ELECTRONIC_FUND", "WIRE_IN", "WIRE_OUT", "JOURNAL"];

export interface Transfer {
  date: string;
  amount: number;
  type: string;
  description: string;
}

/** Deposits (+) and withdrawals (−) from `start` to now, in cached 30-day windows (finished windows kept). */
export async function cachedTransfersSince(start: string, liveMaxAgeMs: number): Promise<{ transfers: Transfer[]; errors: string[] }> {
  const today = todayET();
  const out: Transfer[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let from = start; from <= today; ) {
    const to = addDays(from, 30);
    const done = to <= addDays(today, -1);
    const res = await cached(
      `xferwin:v1:${from}:${to}`,
      done ? Infinity : liveMaxAgeMs,
      async () => {
        const hash = await getAccountHash();
        const lists = await Promise.all(
          TRANSFER_TYPES.map((types) =>
            schwabGet<SchwabTransaction[]>(`/trader/v1/accounts/${hash}/transactions`, {
              startDate: etMidnightUtc(from).toISOString(),
              endDate: (to > today ? new Date() : etMidnightUtc(to)).toISOString(),
              types,
            }),
          ),
        );
        return lists.flatMap((l) => (Array.isArray(l) ? l : []));
      },
      { keepSeconds: done ? 400 * 86_400 : undefined },
    );
    if (res.error && !errors.includes(res.error)) errors.push(res.error);
    for (const t of res.data ?? []) {
      const k = `${t.activityId ?? ""}|${t.time ?? ""}|${t.netAmount ?? ""}`;
      if (seen.has(k) || !t.netAmount) continue;
      seen.add(k);
      const when = t.time ?? t.tradeDate;
      out.push({ date: when ? todayET(Date.parse(when)) : from, amount: t.netAmount, type: t.type ?? "", description: t.description ?? "" });
    }
    from = to;
  }
  return { transfers: out.sort((a, b) => a.date.localeCompare(b.date)), errors };
}

export function cachedAccount(maxAgeMs: number, force = false): Promise<CacheResult<AccountSnapshot>> {
  return cached("account", maxAgeMs, fetchAccount, { force });
}

export function cachedQuotes(symbols: string[], maxAgeMs: number, force = false): Promise<CacheResult<Record<string, Quote>>> {
  const key = "quotes:" + [...symbols].sort().join(",");
  return cached(key, maxAgeMs, () => fetchQuotes(symbols), { force });
}

export function cachedFills(refDate: string, maxAgeMs: number, force = false): Promise<CacheResult<Fill[]>> {
  return cached(`fills:v2:${refDate}:fee${feePerContract()}`, maxAgeMs, () => fetchFills(refDate), { force });
}
