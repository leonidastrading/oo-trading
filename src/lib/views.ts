// Server-side assembly of the Live and Today page payloads.
import "server-only";
import { takeManualRefresh } from "./cache";
import { CASH_SETTLED, expiredOrders, ghostExpired, pendingExpired } from "./expired";
import { analyzeClose, type CloseAnalysis } from "./options";
import { countOpenEntries, feesOn, groupClosesByOrder, openLots, realizedOn, type ClosedOrder, type Fill } from "./realized";
import { cachedAccount, cachedFills, cachedQuotes, feePerContract, quoteSymbol, type Balances, type Quote } from "./schwab/data";
import { tokenStatus, type TokenStatus } from "./schwab/tokens";
import { classifySpread, groupSpreads, splitByEntry, toLeg, type Position, type SpreadGroup } from "./spreads";
import { etMidnightUtc, etParts, lastSessionDate, MANUAL_REFRESH_MIN_MS, marketSession, refreshPolicy, todayET, type MarketPhase } from "./time";

export interface Meta {
  now: number;
  phase: MarketPhase;
  date: string;
  pollMs: number | null;
  token: TokenStatus;
  errors: string[];
  delayed: boolean;
  manualRefreshBlocked: boolean;
}

export interface ExpiryChart {
  key: string;
  underlying: string;
  spot: number;
  analysis: CloseAnalysis;
  markPl: number;
  /** After the session close (16:15 ET, 13:15 on early closes): spot is the settlement and P/L is final. */
  settled: boolean;
}

/** One closed trade (Schwab order, or today's expirations at settlement) on the cumulative closed-P/L line. */
export interface ClosedPoint {
  time: number;
  label: string;
  realized: number;
  cum: number;
  expired: boolean;
}

/** Today's closed orders in close order with a running total; ends at pl.closed. */
export function closedCurve(orders: ClosedOrder[], settleTime: number): ClosedPoint[] {
  let cum = 0;
  return orders
    .map((o) => ({ o, time: o.pending ? settleTime : o.time }))
    .sort((a, b) => a.time - b.time)
    .map(({ o, time }) => {
      cum = Math.round((cum + o.realized) * 100) / 100;
      const legs = o.legs.map((l) => ({ putCall: l.fill.putCall, strike: l.fill.strike, qty: -Math.sign(l.fill.qty) * l.closedQty }));
      return { time, label: `${o.underlying} ${o.pending ? "expired" : classifySpread(legs)}`, realized: o.realized, cum, expired: !!o.pending };
    });
}

export interface LiveData {
  meta: Meta;
  fetchedAt: number | null;
  account: (Balances & { last4: string; dayPl: number | null }) | null;
  spx: Quote | null;
  /** Session P/L: open (all positions), closed (realized today, net of fees), fees today. */
  pl: {
    open: number;
    entries: number;
    closed: number;
    expired: number;
    expiredPending: boolean;
    fees: number;
    contracts: number;
    feeRate: number;
    unknownBasis: number;
    closedPositions: number;
    closedLegs: number;
  } | null;
  groups: SpreadGroup[];
  /** Today's expirations, one chart per underlying. */
  expiring: ExpiryChart[];
  closedCurve: ClosedPoint[];
}

async function baseMeta(force: boolean) {
  const now = Date.now();
  const session = marketSession(now);
  const policy = refreshPolicy(session.phase);
  let manualRefreshBlocked = false;
  let allowForce = false;
  if (force) {
    allowForce = await takeManualRefresh("all", MANUAL_REFRESH_MIN_MS);
    manualRefreshBlocked = !allowForce;
  }
  return { now, session, policy, allowForce, manualRefreshBlocked, token: await tokenStatus() };
}

function isDelayed(phase: MarketPhase, fetchedAt: number | null, intervalMs: number, now: number) {
  if (phase === "closed" || !Number.isFinite(intervalMs)) return false;
  return fetchedAt === null || now - fetchedAt > 2 * intervalMs;
}

/**
 * Split positions into still-open ones and expired cash-settled options valued at settlement
 * ("Expired (pending Schwab posting)"), from the session close until Schwab posts them.
 */
export function splitExpired(
  positions: Position[],
  fills: Fill[],
  quotes: Record<string, Quote> | null | undefined,
  now: number,
) {
  const session = marketSession(now);
  const opts = {
    sessionDate: lastSessionDate(now),
    today: todayET(now),
    afterClose: session.tradingDay && etParts(now).minutesOfDay >= session.closeMin,
    settle: Object.fromEntries([...CASH_SETTLED].map((u) => [u, quotes?.[quoteSymbol(u)]?.last])),
    fills,
  };
  // Include legs Schwab already dropped from the account but hasn't posted yet.
  const pending = pendingExpired([...positions, ...ghostExpired(positions, fills, opts.sessionDate)], opts);
  const gone = new Set(pending.map((p) => p.symbol));
  const orders = expiredOrders(pending, opts);
  return {
    open: positions.filter((p) => !gone.has(p.symbol)),
    pending,
    orders,
    realized: Math.round(orders.reduce((s, o) => s + o.realized, 0) * 100) / 100,
  };
}

/** Quote symbols needed to value the session's expiring cash-settled options. */
export function settlementSymbols(positions: Position[], sessionDate: string, fills: Fill[] = []): string[] {
  return [
    ...new Set(
      [...positions, ...ghostExpired(positions, fills, sessionDate)]
        .filter((p) => p.expiration === sessionDate && CASH_SETTLED.has(p.underlying))
        .map((p) => quoteSymbol(p.underlying)),
    ),
  ];
}

/** Max cache age: just under the poll interval while open; when closed, only refetch if empty. */
const maxAge = (ms: number) => (Number.isFinite(ms) ? Math.max(ms - 2000, 5000) : Infinity);

export async function getLiveData(force = false): Promise<LiveData> {
  const { now, session, policy, allowForce, manualRefreshBlocked, token } = await baseMeta(force);
  const meta: Meta = {
    now, phase: session.phase, date: session.date, pollMs: policy.pollMs, token,
    errors: [], delayed: false, manualRefreshBlocked,
  };
  if (!token.connected) {
    meta.errors.push(token.lastError ?? "Schwab is not connected — connect it in Settings.");
    return { meta, fetchedAt: null, account: null, spx: null, pl: null, groups: [], expiring: [], closedCurve: [] };
  }

  const sessionDate = lastSessionDate(now);
  const [acct, fills] = await Promise.all([
    cachedAccount(maxAge(policy.positionsMs), allowForce),
    cachedFills(sessionDate, maxAge(policy.transactionsMs), allowForce),
  ]);
  for (const e of [acct.error, fills.error]) if (e && !meta.errors.includes(e)) meta.errors.push(e);
  const today = todayET(now);
  const positions = acct.data?.positions ?? [];
  const groups = groupSpreads(positions, today);
  const todays = groups.filter((g) => g.isToday);

  const symbols = new Set(["$SPX", ...todays.map((g) => quoteSymbol(g.underlying)), ...settlementSymbols(positions, sessionDate, fills.data ?? [])]);
  const quotes = await cachedQuotes([...symbols], maxAge(policy.positionsMs), allowForce);
  if (quotes.error && quotes.error !== acct.error) meta.errors.push(quotes.error);
  const spx = quotes.data?.["$SPX"] ?? null;

  // One expiry curve per underlying, using only legs expiring today.
  const byUnderlying = new Map<string, SpreadGroup[]>();
  for (const g of todays) byUnderlying.set(g.underlying, [...(byUnderlying.get(g.underlying) ?? []), g]);
  const expiring: ExpiryChart[] = [];
  const settled = session.tradingDay && etParts(now).minutesOfDay >= session.closeMin;
  for (const [underlying, gs] of byUnderlying) {
    const spot = quotes.data?.[quoteSymbol(underlying)]?.last;
    const legs = gs.flatMap((g) => g.positions).map(toLeg).filter((l) => l !== null);
    const analysis = spot ? analyzeClose(legs, spot) : null;
    if (spot && analysis) {
      expiring.push({ key: gs[0].key, underlying, spot, analysis, markPl: gs.reduce((s, g) => s + g.plOpen, 0), settled });
    }
  }
  expiring.sort((a, b) => (a.underlying === "SPX" ? -1 : b.underlying === "SPX" ? 1 : a.underlying.localeCompare(b.underlying)));

  const b = acct.data?.balances;
  const closes = realizedOn(fills.data ?? [], sessionDate);
  const fee = feesOn(fills.data ?? [], sessionDate);
  const expired = splitExpired(positions, fills.data ?? [], quotes.data, now);
  const pl = acct.data
    ? {
        open: Math.round(expired.open.reduce((s, p) => s + p.plOpen, 0) * 100) / 100,
        entries: countOpenEntries(fills.data ?? [], expired.open),
        closed: Math.round((closes.reduce((s, c) => s + (c.realized ?? 0), 0) + expired.realized) * 100) / 100,
        expired: expired.realized,
        expiredPending: expired.orders.length > 0,
        fees: fee.fees,
        contracts: fee.contracts,
        feeRate: feePerContract(),
        unknownBasis: closes.filter((c) => c.realized === null).length,
        // Closed today: each closing order is a position, plus today's expired entries; legs counted per order/entry.
        closedPositions: groupClosesByOrder(closes).length + countOpenEntries(fills.data ?? [], expired.pending),
        closedLegs:
          new Set(closes.map((c) => `${c.fill.orderId}|${c.fill.symbol}`)).size +
          splitByEntry(expired.pending, openLots(fills.data ?? [])).length,
      }
    : null;
  const fetchedAt = Math.min(acct.fetchedAt ?? Infinity, quotes.fetchedAt ?? Infinity);
  meta.delayed = isDelayed(session.phase, Number.isFinite(fetchedAt) ? fetchedAt : null, policy.positionsMs, now);
  return {
    meta,
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
    account: b
      ? {
          ...b,
          last4: process.env.SCHWAB_ACCOUNT_LAST4 ?? "",
          dayPl: b.netLiq !== null && b.startNetLiq !== null ? b.netLiq - b.startNetLiq : null,
        }
      : null,
    spx,
    pl,
    groups: groupSpreads(splitByEntry(expired.open, openLots(fills.data ?? [])), today),
    expiring,
    closedCurve: closedCurve(
      [...groupClosesByOrder(closes), ...expired.orders],
      etMidnightUtc(sessionDate).getTime() + (session.closeMin - 15) * 60000,
    ),
  };
}

export interface TodayData {
  meta: Meta;
  fetchedAt: number | null;
  sessionDate: string;
  fills: Fill[];
  closed: ClosedOrder[];
  realized: number;
  unknownBasis: number;
  openPl: number;
  /** Open strategy entries (legs from one Schwab order count once). */
  entries: number;
  dayPl: number | null;
  total: number;
  groups: SpreadGroup[];
}

export async function getTodayData(force = false): Promise<TodayData> {
  const { now, session, policy, allowForce, manualRefreshBlocked, token } = await baseMeta(force);
  const meta: Meta = {
    now, phase: session.phase, date: session.date, pollMs: Number.isFinite(policy.transactionsMs) ? policy.transactionsMs : null,
    token, errors: [], delayed: false, manualRefreshBlocked,
  };
  const sessionDate = lastSessionDate(now);
  const empty: TodayData = {
    meta, fetchedAt: null, sessionDate, fills: [], closed: [], realized: 0, unknownBasis: 0, openPl: 0, entries: 0, dayPl: null, total: 0, groups: [],
  };
  if (!token.connected) {
    meta.errors.push(token.lastError ?? "Schwab is not connected — connect it in Settings.");
    return empty;
  }
  const [fills, acct] = await Promise.all([
    cachedFills(sessionDate, maxAge(policy.transactionsMs), allowForce),
    cachedAccount(maxAge(policy.positionsMs), allowForce),
  ]);
  for (const e of [fills.error, acct.error]) if (e && !meta.errors.includes(e)) meta.errors.push(e);

  const allFills = fills.data ?? [];
  const closes = realizedOn(allFills, sessionDate);
  const allPositions = acct.data?.positions ?? [];
  const settleSymbols = settlementSymbols(allPositions, sessionDate, allFills);
  const quotes = settleSymbols.length
    ? await cachedQuotes(["$SPX", ...settleSymbols.filter((s) => s !== "$SPX")], maxAge(policy.positionsMs), allowForce)
    : null;
  if (quotes?.error && !meta.errors.includes(quotes.error)) meta.errors.push(quotes.error);
  const expired = splitExpired(allPositions, allFills, quotes?.data, now);
  const closed = [...expired.orders, ...groupClosesByOrder(closes)];
  const realized = Math.round((closes.reduce((s, c) => s + (c.realized ?? 0), 0) + expired.realized) * 100) / 100;
  const positions = expired.open;
  const openPl = Math.round(positions.reduce((s, p) => s + p.plOpen, 0) * 100) / 100;
  const b = acct.data?.balances;
  meta.delayed = isDelayed(session.phase, fills.fetchedAt, policy.transactionsMs, now);
  return {
    meta,
    fetchedAt: fills.fetchedAt,
    sessionDate,
    fills: allFills.filter((f) => f.bookDate === sessionDate).reverse(),
    closed,
    realized,
    unknownBasis: closes.filter((c) => c.realized === null).length,
    openPl,
    entries: countOpenEntries(allFills, positions),
    dayPl: b && b.netLiq !== null && b.startNetLiq !== null ? b.netLiq - b.startNetLiq : null,
    total: Math.round((realized + openPl) * 100) / 100,
    groups: groupSpreads(splitByEntry(positions, openLots(allFills)), todayET(now)),
  };
}
