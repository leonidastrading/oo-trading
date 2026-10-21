// Server-side assembly of the Live and Today page payloads.
import "server-only";
import { takeManualRefresh } from "./cache";
import { analyzeClose, type CloseAnalysis } from "./options";
import { feesOn, groupClosesByOrder, realizedOn, type ClosedOrder, type Fill } from "./realized";
import { cachedAccount, cachedFills, cachedQuotes, feePerContract, quoteSymbol, type Balances, type Quote } from "./schwab/data";
import { tokenStatus, type TokenStatus } from "./schwab/tokens";
import { groupSpreads, toLeg, type SpreadGroup } from "./spreads";
import { lastSessionDate, MANUAL_REFRESH_MIN_MS, marketSession, refreshPolicy, todayET, type MarketPhase } from "./time";

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
}

export interface LiveData {
  meta: Meta;
  fetchedAt: number | null;
  account: (Balances & { last4: string; dayPl: number | null }) | null;
  spx: Quote | null;
  /** Session P/L: open (all positions), closed (realized today, net of fees), fees today. */
  pl: { open: number; closed: number; fees: number; contracts: number; feeRate: number; unknownBasis: number } | null;
  groups: SpreadGroup[];
  /** Today's expirations, one chart per underlying. */
  expiring: ExpiryChart[];
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
    return { meta, fetchedAt: null, account: null, spx: null, pl: null, groups: [], expiring: [] };
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

  const symbols = new Set(["$SPX", ...todays.map((g) => quoteSymbol(g.underlying))]);
  const quotes = await cachedQuotes([...symbols], maxAge(policy.positionsMs), allowForce);
  if (quotes.error && quotes.error !== acct.error) meta.errors.push(quotes.error);
  const spx = quotes.data?.["$SPX"] ?? null;

  // One expiry curve per underlying, using only legs expiring today.
  const byUnderlying = new Map<string, SpreadGroup[]>();
  for (const g of todays) byUnderlying.set(g.underlying, [...(byUnderlying.get(g.underlying) ?? []), g]);
  const expiring: ExpiryChart[] = [];
  for (const [underlying, gs] of byUnderlying) {
    const spot = quotes.data?.[quoteSymbol(underlying)]?.last;
    const legs = gs.flatMap((g) => g.positions).map(toLeg).filter((l) => l !== null);
    const analysis = spot ? analyzeClose(legs, spot) : null;
    if (spot && analysis) {
      expiring.push({ key: gs[0].key, underlying, spot, analysis, markPl: gs.reduce((s, g) => s + g.plOpen, 0) });
    }
  }
  expiring.sort((a, b) => (a.underlying === "SPX" ? -1 : b.underlying === "SPX" ? 1 : a.underlying.localeCompare(b.underlying)));

  const b = acct.data?.balances;
  const closes = realizedOn(fills.data ?? [], sessionDate);
  const fee = feesOn(fills.data ?? [], sessionDate);
  const pl = acct.data
    ? {
        open: Math.round(positions.reduce((s, p) => s + p.plOpen, 0) * 100) / 100,
        closed: Math.round(closes.reduce((s, c) => s + (c.realized ?? 0), 0) * 100) / 100,
        fees: fee.fees,
        contracts: fee.contracts,
        feeRate: feePerContract(),
        unknownBasis: closes.filter((c) => c.realized === null).length,
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
    groups,
    expiring,
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
    meta, fetchedAt: null, sessionDate, fills: [], closed: [], realized: 0, unknownBasis: 0, openPl: 0, dayPl: null, total: 0, groups: [],
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
  const closed = groupClosesByOrder(closes);
  const realized = Math.round(closes.reduce((s, c) => s + (c.realized ?? 0), 0) * 100) / 100;
  const positions = acct.data?.positions ?? [];
  const openPl = Math.round(positions.reduce((s, p) => s + p.plOpen, 0) * 100) / 100;
  const b = acct.data?.balances;
  meta.delayed = isDelayed(session.phase, fills.fetchedAt, policy.transactionsMs, now);
  return {
    meta,
    fetchedAt: fills.fetchedAt,
    sessionDate,
    fills: allFills.filter((f) => todayET(f.time) === sessionDate).reverse(),
    closed,
    realized,
    unknownBasis: closes.filter((c) => c.realized === null).length,
    openPl,
    dayPl: b && b.netLiq !== null && b.startNetLiq !== null ? b.netLiq - b.startNetLiq : null,
    total: Math.round((realized + openPl) * 100) / 100,
    groups: groupSpreads(positions, todayET(now)),
  };
}
