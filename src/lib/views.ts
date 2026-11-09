// Server-side assembly of the Live and Today page payloads.
import "server-only";
import { takeManualRefresh } from "./cache";
import { KEYS, kv } from "./kv";
import { CASH_SETTLED, expiredOrders, ghostExpired, pendingExpired, settledSymbols } from "./expired";
import { analyzeClose, expiryPnl, type CloseAnalysis, type OptionLeg } from "./options";
import { countOpenEntries, feesOn, groupClosesByOrder, openLots, realizedOn, type ClosedOrder, type Fill } from "./realized";
import { cachedAccount, cachedFills, cachedQuotes, feePerContract, quoteSymbol, type Balances, type Quote } from "./schwab/data";
import { tokenStatus, type TokenStatus } from "./schwab/tokens";
import { classifyBookEntry } from "./strategyRules";
import { classifySpread, groupSpreads, splitByEntry, toLeg, type Position, type SpreadGroup } from "./spreads";
import { closedMaxAge, etMidnightUtc, expiryFocusDate, etParts, lastSessionDate, MANUAL_REFRESH_MIN_MS, marketSession, refreshPolicy, todayET, type MarketPhase } from "./time";

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
  /** The expiration date this chart covers (see expiryFocusDate). */
  expiration: string;
}

/** One closed trade (Schwab order, or an entry's expiration at settlement) on the cumulative closed-P/L line. */
export interface ClosedPoint {
  time: number;
  label: string;
  /** Book strategy, when its structure matches one (strategyRules.ts). */
  strategy: string | null;
  realized: number;
  cum: number;
  expired: boolean;
}

/** Today's closed orders in close order with a running total; ends at pl.closed. Expirations sit at the settlement. */
export function closedCurve(orders: ClosedOrder[], settleTime: number): ClosedPoint[] {
  let cum = 0;
  return orders
    .map((o) => ({ o, time: o.pending || o.settled ? settleTime : o.time }))
    .sort((a, b) => a.time - b.time)
    .map(({ o, time }) => {
      cum = Math.round((cum + o.realized) * 100) / 100;
      // The legs as they were opened (closing fills run the other way).
      const legs = o.legs.map((l) => ({
        putCall: l.fill.putCall,
        strike: l.fill.strike,
        qty: -Math.sign(l.fill.qty) * l.closedQty,
        expiration: l.fill.expiration,
      }));
      const opened = o.legs.find((l) => l.openTime)?.openTime;
      const strategy = opened ? classifyBookEntry(legs, etParts(opened).date, etParts(opened).minutesOfDay) : null;
      const expired = !!o.pending || !!o.settled;
      return { time, label: `${o.underlying} ${classifySpread(legs)}${expired ? " · expired" : ""}`, strategy, realized: o.realized, cum, expired };
    });
}

export interface LiveData {
  meta: Meta;
  fetchedAt: number | null;
  account: (Balances & { last4: string; dayPl: number | null; marginEst: number | null }) | null;
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
  /** Expiration the page focuses on: today until the close, then the next trading day. */
  expiryDate: string;
  closedCurve: ClosedPoint[];
  /** The session's day P/L, one sample per minute from the open (see recordDaySample). */
  dayCurve: DayCurve;
}

export interface DaySample {
  /** Sample time (ms), its minute floored. */
  t: number;
  /** Day equity P/L: net liq − prior close net liq (falls back to open + closed). */
  pl: number;
  open: number;
  closed: number;
  /** Premium of the open option entries at this minute (credit received or debit paid, each entry's size). */
  basis?: number;
}
export interface DayCurve {
  /** Base for %: the day's average open premium (samples with positions on); prior close net liq before any. */
  base: number | null;
  baseKind: "premium" | "netliq" | null;
  /** Session open and close (ms) for the x axis. */
  from: number;
  to: number;
  samples: DaySample[];
}

/** Store this minute's day P/L for the session's curve (first write per minute wins). Only during the session. */
async function recordDaySample(date: string, s: DaySample) {
  const minute = new Date(s.t).toISOString().slice(11, 16);
  await kv().hsetnxMany(KEYS.dayCurve(date), [[minute, s]]);
}

/** Open premium, measured like the Open P/L % tile: per entry |Σ qty × avg price × 100|, options only. */
export function premiumBasis(groups: SpreadGroup[]): number {
  return groups
    .filter((g) => g.positions.every((p) => p.assetType === "OPTION"))
    .reduce((s, g) => s + Math.abs(g.positions.reduce((t, p) => t + p.qty * p.avgPrice * 100, 0)), 0);
}

async function readDayCurve(date: string, from: number, to: number): Promise<DayCurve> {
  const h = await kv().hgetall<DaySample | number | null>(KEYS.dayCurve(date));
  const samples = Object.entries(h)
    .filter(([k, v]) => k !== "base" && v && typeof v === "object")
    .map(([, v]) => v as DaySample)
    .sort((a, b) => a.t - b.t);
  const withPos = samples.filter((x) => (x.basis ?? 0) > 0);
  const base = withPos.length ? withPos.reduce((s, x) => s + x.basis!, 0) / withPos.length : null;
  return { base, baseKind: base ? "premium" : null, from, to, samples };
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
  // Legs Schwab already settled are closed even if a cached position snapshot still lists them.
  const gone = new Set([
    ...pending.map((p) => p.symbol),
    ...settledSymbols(fills, opts.today),
  ]);
  // One closed row per entry (each strategy's expired trade at its own P/L), not one lump per underlying.
  const byEntry = new Map<string, Position[]>();
  for (const p of splitByEntry(pending, openLots(fills))) byEntry.set(p.entryKey ?? "", [...(byEntry.get(p.entryKey ?? "") ?? []), p]);
  const orders = [...byEntry].flatMap(([key, ps]) =>
    expiredOrders(ps, opts, key).map((o) => ({
      ...o,
      legs: o.legs.map((l) => ({ ...l, openTime: ps[0].enteredAt ?? undefined })),
    })),
  );
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

/** Whether Live/Today show option positions only (Settings; on unless turned off). */
export async function optionsOnly(): Promise<boolean> {
  return (await kv().get<string>(KEYS.optionsOnly)) !== "0";
}

/** The positions Live/Today work with: options only unless the setting is off. */
async function visiblePositions(positions: Position[]): Promise<Position[]> {
  return (await optionsOnly()) ? positions.filter((p) => p.assetType === "OPTION") : positions;
}

/**
 * Max cache age: just under the poll interval while open. When closed, marks still move (after-hours and
 * overnight SPX option quotes), so data is refetched every 5 minutes while someone has the page open, and
 * always once after the session ends (closedMaxAge).
 */
const CLOSED_REFRESH_MS = 5 * 60_000;
const maxAge = (ms: number, now = Date.now()) =>
  Number.isFinite(ms) ? Math.max(ms - 2000, 5000) : Math.min(closedMaxAge(now), CLOSED_REFRESH_MS);

/**
 * Margin estimate when Schwab doesn't report one: for each expiration, the worst value the open legs can
 * reach at expiry (e.g. a credit spread's width × contracts × 100). Null when any risk is unbounded.
 */
export function definedRiskMargin(positions: Position[]): number | null {
  const byExp = new Map<string, OptionLeg[]>();
  for (const p of positions) {
    const l = toLeg(p);
    if (l) byExp.set(l.expiration, [...(byExp.get(l.expiration) ?? []), { ...l, avgPrice: 0 }]);
  }
  let total = 0;
  for (const legs of byExp.values()) {
    const top = Math.max(...legs.map((l) => l.strike));
    if (expiryPnl(legs, top + 1) < expiryPnl(legs, top) - 1e-9) return null; // naked calls
    total += Math.max(0, -Math.min(...[0, ...legs.map((l) => l.strike), top + 1].map((s) => expiryPnl(legs, s))));
  }
  return total;
}

export async function getLiveData(force = false): Promise<LiveData> {
  const { now, session, policy, allowForce, manualRefreshBlocked, token } = await baseMeta(force);
  const meta: Meta = {
    now, phase: session.phase, date: session.date, pollMs: policy.pollMs, token,
    errors: [], delayed: false, manualRefreshBlocked,
  };
  if (!token.connected) {
    meta.errors.push(token.lastError ?? "Schwab is not connected — connect it in Settings.");
    return { meta, fetchedAt: null, account: null, spx: null, pl: null, groups: [], expiring: [], expiryDate: expiryFocusDate(now), closedCurve: [], dayCurve: { base: null, baseKind: null, from: 0, to: 0, samples: [] } };
  }

  const sessionDate = lastSessionDate(now);
  const [acct, fills] = await Promise.all([
    cachedAccount(maxAge(policy.positionsMs), allowForce),
    cachedFills(sessionDate, maxAge(policy.transactionsMs), allowForce),
  ]);
  for (const e of [acct.error, fills.error]) if (e && !meta.errors.includes(e)) meta.errors.push(e);
  const today = todayET(now);
  const positions = await visiblePositions(acct.data?.positions ?? []);
  const groups = groupSpreads(positions, today);
  const expiryDate = expiryFocusDate(now);
  const todays = groups.filter((g) => g.expiration === expiryDate);

  const symbols = new Set(["$SPX", ...todays.map((g) => quoteSymbol(g.underlying)), ...settlementSymbols(positions, sessionDate, fills.data ?? [])]);
  const quotes = await cachedQuotes([...symbols], maxAge(policy.positionsMs), allowForce);
  if (quotes.error && quotes.error !== acct.error) meta.errors.push(quotes.error);
  const spx = quotes.data?.["$SPX"] ?? null;

  // One expiry curve per underlying, using only legs of the focused expiration.
  const byUnderlying = new Map<string, SpreadGroup[]>();
  for (const g of todays) byUnderlying.set(g.underlying, [...(byUnderlying.get(g.underlying) ?? []), g]);
  const expiring: ExpiryChart[] = [];
  // The focus moves to the next expiration at the close, so a chart is settled only for an expiration that
  // has passed (kept for older payloads; normally false).
  const settled = expiryDate < today;
  for (const [underlying, gs] of byUnderlying) {
    const spot = quotes.data?.[quoteSymbol(underlying)]?.last;
    const legs = gs.flatMap((g) => g.positions).map(toLeg).filter((l) => l !== null);
    const analysis = spot ? analyzeClose(legs, spot) : null;
    if (spot && analysis) {
      expiring.push({ key: gs[0].key, underlying, spot, analysis, markPl: gs.reduce((s, g) => s + g.plOpen, 0), settled, expiration: expiryDate });
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

  // Intraday day-P/L curve: one sample a minute while the market is open, from fresh data only.
  const dayFrom = etMidnightUtc(sessionDate).getTime() + session.openMin * 60_000;
  const dayTo = etMidnightUtc(sessionDate).getTime() + session.closeMin * 60_000;
  const openGroups = groupSpreads(splitByEntry(expired.open, openLots(fills.data ?? []), today), today);
  if (pl && b && session.phase !== "closed" && Number.isFinite(fetchedAt) && now - fetchedAt < 90_000) {
    const equity = b.netLiq !== null && b.startNetLiq !== null ? b.netLiq - b.startNetLiq : null;
    const t = Math.floor(now / 60_000) * 60_000;
    try {
      await recordDaySample(
        sessionDate,
        { t, pl: Math.round((equity ?? pl.open + pl.closed) * 100) / 100, open: pl.open, closed: pl.closed, basis: Math.round(premiumBasis(openGroups)) },
      );
    } catch (e) {
      meta.errors.push(`day P/L sample: ${(e as Error).message}`);
    }
  }
  const dayCurve: DayCurve = await readDayCurve(sessionDate, dayFrom, dayTo).catch(() => ({ base: null, baseKind: null, from: dayFrom, to: dayTo, samples: [] }));
  if (!dayCurve.base) {
    // No sample with positions yet: the current open premium, else the prior close.
    const now = premiumBasis(openGroups);
    if (now > 0) Object.assign(dayCurve, { base: now, baseKind: "premium" });
    else if (b?.startNetLiq) Object.assign(dayCurve, { base: b.startNetLiq, baseKind: "netliq" });
  }

  return {
    meta,
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
    account: b
      ? {
          ...b,
          last4: process.env.SCHWAB_ACCOUNT_LAST4 ?? "",
          dayPl: b.netLiq !== null && b.startNetLiq !== null ? b.netLiq - b.startNetLiq : null,
          marginEst: definedRiskMargin(expired.open),
        }
      : null,
    spx,
    pl,
    groups: openGroups,
    expiring,
    expiryDate,
    closedCurve: closedCurve(
      [...groupClosesByOrder(closes), ...expired.orders],
      etMidnightUtc(sessionDate).getTime() + (session.closeMin - 15) * 60000,
    ),
    dayCurve,
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
  const allPositions = await visiblePositions(acct.data?.positions ?? []);
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
    groups: groupSpreads(splitByEntry(positions, openLots(allFills), todayET(now)), todayET(now)),
  };
}
