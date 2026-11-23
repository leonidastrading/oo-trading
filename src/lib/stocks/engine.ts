// Stock Trades engine (server only): submit ideas, change stops/targets, close, kill switch, flatten, reconcile.
// Every path runs the guardrails in rules.ts here on the server; the UI is never trusted. In dry-run mode
// nothing reaches Schwab's order API: the order is logged and the trade is paper-filled at quotes.
import "server-only";
import { fetchCard } from "./scout";
import { KEYS, kv } from "../kv";
import { schwabGet, SchwabApiError, type AccountNumber } from "../schwab/client";
import { cachedFills, cachedMinuteBars } from "../schwab/data";
import { cached } from "../cache";
import { normalizePosition, type SchwabPosition } from "../spreads";
import { mockEnabled } from "../schwab/mock";
import { liveTradingEnabled, schwabOrder } from "../schwab/trading";
import { etParts } from "../time";
import {
  bracketOrder,
  entrySession,
  extendedSession,
  changeSettings,
  checkStopChange,
  closeOut,
  effectiveSettings,
  exitByDate,
  marketClose,
  parseIdea,
  preTradeChecks,
  regularSession,
  shadowSize,
  starterShares,
  orderShares,
  tradeCapPct,
  riskSizingActive,
  checkAdd,
  parsePostMortem,
  adoptChecks,
  stopReplacement,
  targetReplacement,
  timeExitDue,
  type Check,
  type ExitReason,
  type StockQuote,
  type StockSettings,
  type StoredSettings,
  type Trade,
} from "./rules";

export interface LogEntry {
  id: string;
  at: number;
  kind: "order" | "block" | "change" | "cancel" | "exit" | "alert" | "kill" | "settings" | "error";
  mode: "dry" | "live";
  ticker?: string;
  tradeId?: string;
  text: string;
  detail?: unknown;
}

export interface TradingAccount {
  last4: string;
  nickname: string | null;
  type: string | null;
  hash: string;
}

const store = () => kv();
/** Now, or (local mock preview only, never on Vercel) STOCKS_FAKE_NOW plus the time since start. */
const startedAt = Date.now();
const clock = () => (mockEnabled() && process.env.STOCKS_FAKE_NOW ? Date.parse(process.env.STOCKS_FAKE_NOW) + (Date.now() - startedAt) : Date.now());
const rid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---- Storage ----

export async function loadTrades(): Promise<Trade[]> {
  return Object.values(await store().hgetall<Trade>(KEYS.stockTrades)).sort((a, b) => b.submittedAt - a.submittedAt);
}
const saveTrade = (t: Trade) => store().hset(KEYS.stockTrades, t.id, t);

export async function loadSettings(): Promise<StoredSettings | null> {
  return store().get<StoredSettings>(KEYS.stockSettings);
}
export async function settingsNow(): Promise<StockSettings> {
  return effectiveSettings(await loadSettings());
}

export async function killSwitchOn(): Promise<boolean> {
  return !!(await store().get<{ on: boolean }>(KEYS.stockKill))?.on;
}

export async function log(e: Omit<LogEntry, "id" | "at">): Promise<void> {
  const at = Date.now();
  const id = `${String(at).padStart(14, "0")}-${Math.random().toString(36).slice(2, 6)}`;
  await store().hset(KEYS.stockLog, id, { ...e, id, at });
}
export async function loadLog(limit = 300): Promise<LogEntry[]> {
  return Object.values(await store().hgetall<LogEntry>(KEYS.stockLog))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export async function alert(text: string, tradeId?: string) {
  const id = rid();
  await store().hset(KEYS.stockAlerts, id, { id, at: Date.now(), text, tradeId });
  await log({ kind: "alert", mode: "live", tradeId, text });
}
export async function loadAlerts(): Promise<{ id: string; at: number; text: string }[]> {
  return Object.values(await store().hgetall<{ id: string; at: number; text: string }>(KEYS.stockAlerts)).sort((a, b) => b.at - a.at);
}
export async function dismissAlert(id: string) {
  await store().hdel(KEYS.stockAlerts, id);
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  // One writer at a time, so two submits can't both slip under a limit.
  for (let i = 0; i < 20; i++) {
    if (await store().set(KEYS.stockLock, 1, { px: 30_000, nx: true })) {
      try {
        return await fn();
      } finally {
        await store().del(KEYS.stockLock);
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Busy: another Stock Trades action is running, try again");
}

// ---- Schwab reads ----

/** The account Stock Trades trades: STOCK_ACCOUNT_LAST4, else the dashboard's account (SCHWAB_ACCOUNT_LAST4). */
export async function tradingAccount(): Promise<TradingAccount> {
  const last4 = process.env.STOCK_ACCOUNT_LAST4 || process.env.SCHWAB_ACCOUNT_LAST4;
  if (!last4) throw new Error("No trading account configured (STOCK_ACCOUNT_LAST4 / SCHWAB_ACCOUNT_LAST4)");
  const cached = await store().get<TradingAccount>(KEYS.stockAccount);
  if (cached && cached.last4 === last4) return cached;
  const accounts = await schwabGet<AccountNumber[]>("/trader/v1/accounts/accountNumbers");
  const match = accounts.find((a) => a.accountNumber.endsWith(last4));
  if (!match) throw new SchwabApiError(`No Schwab account ending in ${last4}`, 404);
  let nickname: string | null = null;
  let type: string | null = null;
  try {
    const pref = await schwabGet<{ accounts?: { accountNumber?: string; nickName?: string; type?: string; displayAcctId?: string }[] }>("/trader/v1/userPreference");
    const p = pref.accounts?.find((a) => a.accountNumber?.endsWith(last4));
    nickname = p?.nickName || p?.displayAcctId || null;
    type = p?.type ?? null;
  } catch {
    // nickname is cosmetic
  }
  const acct: TradingAccount = { last4, nickname, type, hash: match.hashValue };
  await store().set(KEYS.stockAccount, acct, { ex: 24 * 3600 });
  return acct;
}

export async function accountValue(acct: TradingAccount): Promise<number | null> {
  const raw = await schwabGet<{ securitiesAccount?: { currentBalances?: { liquidationValue?: number } }; aggregatedBalance?: { currentLiquidationValue?: number } }>(
    `/trader/v1/accounts/${acct.hash}`,
  );
  return raw.securitiesAccount?.currentBalances?.liquidationValue ?? raw.aggregatedBalance?.currentLiquidationValue ?? null;
}

export interface HeldStock {
  symbol: string;
  description: string;
  assetType: string;
  qty: number;
  avgPrice: number;
  marketValue: number;
}

/** Stock/ETF positions in the trading account (Schwab), cached briefly. */
export async function heldStocks(acct: TradingAccount, force = false): Promise<HeldStock[]> {
  const load = async () => {
    const raw = await schwabGet<{ securitiesAccount?: { positions?: SchwabPosition[] } }>(`/trader/v1/accounts/${acct.hash}`, { fields: "positions" });
    return (raw.securitiesAccount?.positions ?? [])
      .map(normalizePosition)
      .filter((p) => ["EQUITY", "COLLECTIVE_INVESTMENT", "ETF"].includes(p.assetType) && p.qty !== 0)
      .map((p) => ({ symbol: p.symbol, description: p.description, assetType: p.assetType, qty: p.qty, avgPrice: Math.round(p.avgPrice * 100) / 100, marketValue: p.marketValue }));
  };
  if (force) return load();
  return (await cached("stocks:held", 60_000, load)).data ?? [];
}

/** Held stocks the tab isn't managing (e.g. bought in the Schwab app while the API was down). */
export async function unmanagedStocks(acct: TradingAccount, trades: Trade[]): Promise<HeldStock[]> {
  const managed = new Set(trades.filter((t) => t.mode === "live" && ["pending", "open", "closing"].includes(t.status)).map((t) => t.ticker));
  return (await heldStocks(acct)).filter((h) => !managed.has(h.symbol));
}

export async function stockQuotes(symbols: string[]): Promise<Record<string, StockQuote>> {
  if (!symbols.length) return {};
  type Raw = Record<
    string,
    {
      quote?: { lastPrice?: number; bidPrice?: number; askPrice?: number; mark?: number };
      reference?: { description?: string; isShortable?: boolean; isHardToBorrow?: boolean };
    }
  >;
  const raw = await schwabGet<Raw>("/marketdata/v1/quotes", { symbols: [...new Set(symbols)].join(","), fields: "quote,reference" });
  const out: Record<string, StockQuote> = {};
  for (const [sym, r] of Object.entries(raw)) {
    if (!r?.quote) continue;
    out[sym] = {
      symbol: sym,
      last: r.quote.lastPrice ?? r.quote.mark ?? null,
      bid: r.quote.bidPrice ?? null,
      ask: r.quote.askPrice ?? null,
      description: r.reference?.description ?? null,
      shortable: typeof r.reference?.isShortable === "boolean" ? r.reference.isShortable : null,
      hardToBorrow: typeof r.reference?.isHardToBorrow === "boolean" ? r.reference.isHardToBorrow : null,
    };
  }
  return out;
}

// ---- Market-relative marks ----

/**
 * Prices of SPY and the trade's benchmark ETF at `ms`: the current quote when `ms` is now(ish), else the
 * 1-minute bar holding that time (Schwab price history), else the current quote as the closest available.
 */
async function marksAt(t: Pick<Trade, "benchmark">, ms: number, quotes?: Record<string, StockQuote>): Promise<{ spy: number | null; bench: number | null }> {
  const syms = ["SPY", ...(t.benchmark ? [t.benchmark] : [])];
  const q = quotes && syms.every((s) => quotes[s]) ? quotes : await stockQuotes(syms).catch(() => ({}) as Record<string, StockQuote>);
  const at = async (sym: string): Promise<number | null> => {
    const now = q[sym]?.last ?? null;
    if (Math.abs(Date.now() - ms) < 120_000) return now;
    try {
      const bars = (await cachedMinuteBars(sym, etParts(ms).date, 5 * 60_000)).data ?? [];
      const hit = [...bars].reverse().find((b) => b.time * 1000 <= ms);
      return hit?.close ?? now;
    } catch {
      return now;
    }
  };
  return { spy: await at("SPY"), bench: t.benchmark ? await at(t.benchmark) : null };
}

const markEntry = async (t: Trade, ms: number, quotes?: Record<string, StockQuote>) => {
  const m = await marksAt(t, ms, quotes);
  t.spyEntry = m.spy;
  t.benchEntry = t.benchmark ? m.bench : null;
};

// ---- Submit ----

export interface SubmitResult {
  ok: boolean;
  /** A preview: checks and sizing only, nothing logged or sent. */
  preview?: boolean;
  sizing?: {
    liveShares: number;
    byRisk?: boolean;
    shadow: ReturnType<typeof shadowSize>;
    entryRef: number;
    accountValue: number | null;
    planAdd: boolean;
    starterShadow: number;
    addShadow: number;
    starterPosition: number;
    starterRisk: number;
  };
  errors: string[];
  checks: Check[];
  trade?: Trade;
  order?: unknown;
  mode: "dry" | "live";
}

export async function submitIdea(raw: Record<string, unknown>, opts: { preview?: boolean } = {}): Promise<SubmitResult> {
  return withLock(async () => {
    const settings = await settingsNow();
    const mode = settings.dryRun ? "dry" : "live";
    // Every idea comes from a Trend Scout card: the ticker is the card's, not the form's.
    const card = await fetchCard(raw.cardId);
    if (!card.ok) return { ok: false, errors: [card.error], checks: [], mode };
    const { idea, errors } = parseIdea({ ...raw, ticker: card.prefill.ticker, source: "trend scout" });
    if (!idea) {
      if (!opts.preview) await log({ kind: "block", mode, ticker: card.prefill.ticker, text: `Form incomplete: ${errors.join("; ")}` });
      return { ok: false, errors, checks: [], mode };
    }
    const cardRef = { cardId: card.prefill.cardId, cardUrl: card.prefill.cardUrl };
    const now = clock();
    const [acct, quotes, trades, kill] = await Promise.all([tradingAccount(), stockQuotes([idea.ticker]).catch(() => ({}) as Record<string, StockQuote>), loadTrades(), killSwitchOn()]);
    const acctValue = await accountValue(acct).catch(() => null);
    const quote = quotes[idea.ticker] ?? null;
    // This trade's own position cap (confidence slider), never above the setting.
    const sized = { ...settings, maxPositionPct: tradeCapPct(settings, idea.positionPct) };
    const checks = preTradeChecks({ idea, quote, trades, settings: sized, killSwitch: kill, accountValue: acctValue, now });
    if (mode === "live") {
      const on = liveTradingEnabled();
      checks.push({ name: "Server live switch", ok: on, detail: on ? "On" : "STOCK_LIVE_TRADING is off on the server: live orders can't be sent" });
    }
    const lastPx = quote?.last ?? null;
    const entryRef = idea.entryType !== "market" && idea.limitPrice ? idea.limitPrice : (lastPx ?? 0);
    const full = shadowSize(acctValue, sized, entryRef, idea.stop);
    const starterN = starterShares(full.shares, idea.planAdd);
    // Order size: from the account (risk % to the stop, capped per position) when that's in force, else fixed.
    const byRisk = riskSizingActive(settings, mode, now);
    const liveN = orderShares(settings, mode, full.shares, idea.planAdd, now);
    if (byRisk) checks.push({ name: "Order size", ok: liveN >= 1, detail: liveN >= 1 ? `${liveN} sh: ${settings.riskPct}% risk to the stop, max ${sized.maxPositionPct}% of the account` : "Sizes to 0 shares (account value unknown, or one share is over the limits)" });
    else if (settings.sizeByRisk) checks.push({ name: "Order size", ok: true, detail: `Warning: account sizing isn't live yet (24 hours after switching it on) — using the fixed ${settings.shares} share(s)` });
    const failed = checks.filter((c) => !c.ok);
    const sizing = {
      liveShares: liveN,
      byRisk,
      shadow: full,
      entryRef,
      accountValue: acctValue,
      planAdd: !!idea.planAdd,
      starterShadow: starterN,
      addShadow: full.shares - starterN,
      starterPosition: Math.round(starterN * entryRef * 100) / 100,
      starterRisk: Math.round(starterN * Math.abs(entryRef - idea.stop) * 100) / 100,
    };
    if (opts.preview) return { ok: failed.length === 0, preview: true, sizing, errors: failed.map((c) => `${c.name}: ${c.detail}`), checks, mode, order: bracketOrder(idea, Math.max(liveN, 1), entrySession(idea.entryType, now).session) };
    if (failed.length) {
      await log({ kind: "block", mode, ticker: idea.ticker, text: failed.map((c) => `${c.name}: ${c.detail}`).join("; "), detail: { idea } });
      return { ok: false, errors: failed.map((c) => `${c.name}: ${c.detail}`), checks, mode, sizing };
    }

    const last = quote!.last!;
    const ref = idea.entryType !== "market" ? idea.limitPrice! : last;
    const risk = Math.abs(ref - idea.stop);
    const size = shadowSize(acctValue, sized, ref, idea.stop);
    const session = entrySession(idea.entryType, now).session;
    const order = bracketOrder(idea, liveN, session);
    const trade: Trade = {
      ...idea,
      ...cardRef,
      id: rid(),
      mode,
      status: "pending",
      shares: liveN,
      sizedByRisk: byRisk,
      submittedAt: now,
      priceAtSubmit: last,
      initialStop: idea.stop,
      riskPerShare: Math.round(risk * 100) / 100,
      accountValue: acctValue,
      shadowRiskPct: settings.riskPct,
      shadowShares: starterShares(size.shares, idea.planAdd),
      fullShadowShares: size.shares,
      plannedRisk: Math.round(size.shares * risk * 100) / 100,
      shadowPosition: Math.round(starterShares(size.shares, idea.planAdd) * ref * 100) / 100,
      shadowRisk: Math.round(starterShares(size.shares, idea.planAdd) * risk * 100) / 100,
      shadowCapped: size.capped,
      add: null,
      postMortem: null,
      exitBy: idea.days ? exitByDate(etParts(now).date, idea.days) : "",
      orderJson: order,
      session,
      stopHistory: [{ at: now, stop: idea.stop }],
      targetHistory: [{ at: now, target: idea.target ?? null }],
      notes: [],
    };

    if (mode === "live") {
      try {
        const r = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, order);
        trade.orderId = r.orderId;
      } catch (e) {
        await log({ kind: "error", mode, ticker: idea.ticker, text: `Order rejected/failed: ${(e as Error).message}`, detail: { order } });
        return { ok: false, errors: [`Schwab didn't take the order: ${(e as Error).message}`], checks, mode, order, sizing };
      }
    } else {
      trade.orderId = `dry-${trade.id}`;
      // Paper fill: a market entry fills at the last price now; a limit waits for the price to reach it.
      if (idea.entryType === "market") Object.assign(trade, { status: "open", entryPrice: last, entryTime: now, slippage: 0 });
      else if (idea.entryType === "limit" && (session === "NORMAL" || extendedSession(now)) && (idea.direction === "long" ? last <= idea.limitPrice! : last >= idea.limitPrice!)) {
        Object.assign(trade, { status: "open", entryPrice: idea.limitPrice, entryTime: now, slippage: Math.round((idea.limitPrice! - last) * 100) / 100 });
      }
      if (trade.status === "open") await markEntry(trade, Date.now());
    }
    await saveTrade(trade);
    await log({
      kind: "order",
      mode,
      ticker: idea.ticker,
      tradeId: trade.id,
      text: `${mode === "dry" ? "DRY RUN — would send" : "Sent"} ${idea.direction === "long" ? "BUY" : "SELL SHORT"} ${liveN} ${idea.ticker} ${idea.entryType === "market" ? "at market" : `${idea.entryType} ${idea.limitPrice}`}, stop ${idea.stop}${idea.target ? `, target ${idea.target}` : ""} (bracket)${trade.orderId && mode === "live" ? ` · order ${trade.orderId}` : ""} · account ••${acct.last4}`,
      detail: { order },
    });
    return { ok: true, errors: [], checks, trade, order, mode, sizing };
  });
}

// ---- Live order helpers ----

interface RawOrder {
  orderId?: number;
  status?: string;
  orderType?: string;
  price?: number;
  stopPrice?: number;
  filledQuantity?: number;
  closeTime?: string;
  orderActivityCollection?: { executionLegs?: { price?: number; quantity?: number; time?: string }[] }[];
  childOrderStrategies?: RawOrder[];
}

const fillOf = (o: RawOrder | null | undefined): { price: number; time: number } | null => {
  const legs = (o?.orderActivityCollection ?? []).flatMap((a) => a.executionLegs ?? []);
  const q = legs.reduce((s, l) => s + (l.quantity ?? 0), 0);
  if (!legs.length || !q) return null;
  const price = legs.reduce((s, l) => s + (l.price ?? 0) * (l.quantity ?? 0), 0) / q;
  const time = Math.max(...legs.map((l) => Date.parse(l.time ?? "") || 0));
  return { price: Math.round(price * 100) / 100, time: time || Date.now() };
};
const flatChildren = (o: RawOrder): RawOrder[] => (o.childOrderStrategies ?? []).flatMap((c) => [c, ...flatChildren(c)]);
const DEAD = new Set(["CANCELED", "REJECTED", "EXPIRED", "REPLACED"]);
/** Most times the sync puts an order of one trade back before giving up. */
const MAX_REENTRIES = 5;

/** Put the protective stop (with the target as an OCO, when there is one) back on an open live trade. */
async function replaceProtection(acct: TradingAccount, t: Trade): Promise<void> {
  const order = t.target ? { orderStrategyType: "OCO", childOrderStrategies: [targetReplacement(t, t.target), stopReplacement(t, t.stop)] } : stopReplacement(t, t.stop);
  const r = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, order);
  if (!r.orderId) throw new Error("Schwab returned no order id");
  if (t.target) {
    const kids = flatChildren(await getOrder(acct, r.orderId));
    const stop = kids.find((k) => k.orderType === "STOP")?.orderId;
    const tgt = kids.find((k) => k.orderType === "LIMIT")?.orderId;
    if (!stop) throw new Error("the new stop's id wasn't returned");
    t.stopOrderId = String(stop);
    t.targetOrderId = tgt ? String(tgt) : null;
  } else {
    t.stopOrderId = r.orderId;
    t.targetOrderId = null;
  }
  t.reentries = (t.reentries ?? 0) + 1;
}

async function getOrder(acct: TradingAccount, id: string): Promise<RawOrder> {
  return (await schwabOrder<RawOrder>("GET", `/trader/v1/accounts/${acct.hash}/orders/${id}`)).data ?? {};
}
async function cancelOrder(acct: TradingAccount, id: string | null | undefined) {
  if (!id || id.startsWith("dry-")) return;
  try {
    await schwabOrder("DELETE", `/trader/v1/accounts/${acct.hash}/orders/${id}`);
  } catch (e) {
    // Already filled/cancelled is fine; anything else is logged by the caller.
    if (!/40[04]|cannot be canceled|not.*cancel/i.test((e as Error).message)) throw e;
  }
}

// ---- Changes ----

export async function changeStop(id: string, newStop: number): Promise<{ ok: boolean; error?: string }> {
  return withLock(async () => {
    const t = (await store().hgetall<Trade>(KEYS.stockTrades))[id];
    if (!t || (t.status !== "open" && t.status !== "pending")) return { ok: false, error: "No open trade with that id" };
    const q = (await stockQuotes([t.ticker]).catch(() => ({}) as Record<string, StockQuote>))[t.ticker];
    const err = checkStopChange(t, Math.round(newStop * 100) / 100, q?.last ?? null);
    if (err) {
      await log({ kind: "block", mode: t.mode, ticker: t.ticker, tradeId: id, text: `Stop change refused: ${err}` });
      return { ok: false, error: err };
    }
    const stop = Math.round(newStop * 100) / 100;
    if (t.mode === "live") {
      if (!t.stopOrderId) return { ok: false, error: "The stop order isn't known yet (entry not filled or not reconciled); try after the next sync" };
      try {
        const acct = await tradingAccount();
        const r = await schwabOrder("PUT", `/trader/v1/accounts/${acct.hash}/orders/${t.stopOrderId}`, stopReplacement(t, stop));
        if (r.orderId) t.stopOrderId = r.orderId;
        // The add carries its own stop order (same level): move it too.
        if (t.add?.status === "filled" && t.add.stopOrderId) {
          const r2 = await schwabOrder("PUT", `/trader/v1/accounts/${acct.hash}/orders/${t.add.stopOrderId}`, stopReplacement({ ...t, shares: t.add.liveShares }, stop));
          if (r2.orderId) t.add.stopOrderId = r2.orderId;
        }
      } catch (e) {
        await log({ kind: "error", mode: "live", ticker: t.ticker, tradeId: id, text: `Stop change failed (old stop still working): ${(e as Error).message}` });
        return { ok: false, error: `Schwab refused the change; the old stop is still working: ${(e as Error).message}` };
      }
    }
    t.stopHistory.push({ at: Date.now(), stop });
    t.stop = stop;
    await saveTrade(t);
    await log({ kind: "change", mode: t.mode, ticker: t.ticker, tradeId: id, text: `Stop tightened to ${stop}` });
    return { ok: true };
  });
}

export async function changeTarget(id: string, target: number): Promise<{ ok: boolean; error?: string }> {
  return withLock(async () => {
    const t = (await store().hgetall<Trade>(KEYS.stockTrades))[id];
    if (!t || (t.status !== "open" && t.status !== "pending")) return { ok: false, error: "No open trade with that id" };
    const tgt = Math.round(target * 100) / 100;
    const ref = t.entryPrice ?? t.priceAtSubmit;
    if (!(tgt > 0) || (t.direction === "long" ? tgt <= ref : tgt >= ref)) return { ok: false, error: `A ${t.direction} target must be ${t.direction === "long" ? "above" : "below"} the entry (${ref})` };
    if (t.mode === "live" && t.add && t.add.status !== "cancelled" && (!t.target || !t.add.targetOrderId)) {
      return { ok: false, error: "With the add on, a target can only be changed if the trade already had one" };
    }
    if (t.mode === "live" && (!t.target || !t.targetOrderId)) {
      // Adding a target: put on a new stop+target OCO, then pull the old lone stop.
      if (t.status !== "open" || !t.stopOrderId) return { ok: false, error: "Add a target once the entry has filled and its stop is synced" };
      const acct = await tradingAccount();
      const oco = { orderStrategyType: "OCO", childOrderStrategies: [targetReplacement(t, tgt), stopReplacement(t, t.stop)] };
      const place = async () => {
        const r = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, oco);
        const kids = r.orderId ? flatChildren(await getOrder(acct, r.orderId)) : [];
        return { stop: kids.find((k) => k.orderType === "STOP")?.orderId, target: kids.find((k) => k.orderType === "LIMIT")?.orderId };
      };
      let ids: { stop?: number; target?: number } | null = null;
      try {
        ids = await place(); // new pair first, so a stop is always working
        await cancelOrder(acct, t.stopOrderId);
      } catch {
        // Schwab may refuse a second closing order for the same shares: swap them as fast as possible instead.
        await cancelOrder(acct, t.stopOrderId);
        try {
          ids = await place();
        } catch (e) {
          try {
            const r = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, stopReplacement(t, t.stop));
            t.stopOrderId = r.orderId;
            await saveTrade(t);
            return { ok: false, error: `Schwab refused the target; the stop was put back: ${(e as Error).message}` };
          } catch (e2) {
            await alert(`${t.ticker}: adding the target failed and the stop couldn't be restored (${(e2 as Error).message}). Flattening.`, t.id);
            await closeTradeUnlocked(t, "kill", undefined);
            return { ok: false, error: "Couldn't restore the stop: the position was flattened" };
          }
        }
      }
      t.stopOrderId = ids?.stop ? String(ids.stop) : t.stopOrderId;
      t.targetOrderId = ids?.target ? String(ids.target) : null;
    } else if (t.mode === "live") {
      try {
        const acct = await tradingAccount();
        const r = await schwabOrder("PUT", `/trader/v1/accounts/${acct.hash}/orders/${t.targetOrderId}`, targetReplacement(t, tgt));
        if (r.orderId) t.targetOrderId = r.orderId;
        if (t.add?.status === "filled" && t.add.targetOrderId) {
          const r2 = await schwabOrder("PUT", `/trader/v1/accounts/${acct.hash}/orders/${t.add.targetOrderId}`, targetReplacement({ ...t, shares: t.add.liveShares }, tgt));
          if (r2.orderId) t.add.targetOrderId = r2.orderId;
        }
      } catch (e) {
        return { ok: false, error: `Schwab refused the change: ${(e as Error).message}` };
      }
    }
    t.targetHistory.push({ at: Date.now(), target: tgt });
    t.target = tgt;
    await saveTrade(t);
    await log({ kind: "change", mode: t.mode, ticker: t.ticker, tradeId: id, text: `Target changed to ${tgt}` });
    return { ok: true };
  });
}

// ---- Adopt a position opened outside the app ----

/**
 * Take over a stock position placed in the Schwab app (e.g. while the API was down): the idea fields are
 * filled in after the fact, the server puts on the stop (and target) for the actual share count, and from
 * then on it's managed like any other trade. A stop on the wrong side of the price blocks it; any other
 * guardrail it broke is recorded as an override (counted against the size-up rule).
 */
export async function adoptPosition(raw: Record<string, unknown>, opts: { preview?: boolean } = {}) {
  return withLock(async () => {
    // A card is optional here (the shares are already held and need a stop either way), but if one is
    // given it must be for this ticker.
    let cardRef: { cardId?: string; cardUrl?: string | null } = {};
    if (raw.cardId !== undefined && raw.cardId !== null && raw.cardId !== "") {
      const card = await fetchCard(raw.cardId);
      if (!card.ok) return { ok: false, errors: [card.error], checks: [] as Check[] };
      if (card.prefill.ticker !== String(raw.ticker ?? "").trim().toUpperCase())
        return { ok: false, errors: [`Card ${card.prefill.cardId} is for ${card.prefill.ticker}, not ${String(raw.ticker ?? "").toUpperCase()}`], checks: [] as Check[] };
      cardRef = { cardId: card.prefill.cardId, cardUrl: card.prefill.cardUrl };
    }
    const { idea, errors } = parseIdea({ ...raw, entryType: "market", limitPrice: null, planAdd: false });
    if (!idea) return { ok: false, errors, checks: [] as Check[] };
    const now = clock();
    const acct = await tradingAccount();
    const [held, quotes, trades, kill, settings] = await Promise.all([
      heldStocks(acct, true),
      stockQuotes([idea.ticker, "SPY", ...(idea.benchmark ? [idea.benchmark] : [])]).catch(() => ({}) as Record<string, StockQuote>),
      loadTrades(),
      killSwitchOn(),
      settingsNow(),
    ]);
    const pos = held.find((h) => h.symbol === idea.ticker);
    const pre: Check[] = [];
    pre.push({ name: "Position at Schwab", ok: !!pos, detail: pos ? `${pos.qty} sh @ ${pos.avgPrice}` : `No ${idea.ticker} position in account ••${acct.last4}` });
    if (pos) pre.push({ name: "Direction", ok: (pos.qty > 0) === (idea.direction === "long"), detail: pos.qty > 0 ? "Held long" : "Held short" });
    const already = trades.find((t) => t.ticker === idea.ticker && t.mode === "live" && ["pending", "open", "closing"].includes(t.status));
    pre.push({ name: "Not managed yet", ok: !already, detail: already ? "Already managed here" : "Not managed" });
    pre.push({ name: "Server live switch", ok: liveTradingEnabled(), detail: liveTradingEnabled() ? "On (the stop is a real order)" : "STOCK_LIVE_TRADING is off" });
    const acctValue = await accountValue(acct).catch(() => null);
    const quote = quotes[idea.ticker] ?? null;
    // Same guardrails as a new idea, judged as live, at the position's entry price.
    const all = preTradeChecks({ idea, quote, trades, settings: { ...settings, dryRun: false }, killSwitch: kill, accountValue: acctValue, now });
    const split = adoptChecks(all);
    const blocking = [...pre.filter((c) => !c.ok), ...split.hard];
    const checks = [...pre, ...split.shown];
    const entry = pos?.avgPrice ?? 0;
    const shares = Math.abs(pos?.qty ?? 0);
    const size = shadowSize(acctValue, settings, entry, idea.stop);
    const sizing = {
      liveShares: shares,
      shadow: size,
      entryRef: entry,
      accountValue: acctValue,
      planAdd: false,
      starterShadow: size.shares,
      addShadow: 0,
      starterPosition: size.position,
      starterRisk: size.risk,
    };
    const overrides = split.overrides.map((c) => `${c.name}: ${c.detail}`);
    if (opts.preview || blocking.length) {
      if (!opts.preview) await log({ kind: "block", mode: "live", ticker: idea.ticker, text: `Adopt blocked: ${blocking.map((c) => `${c.name}: ${c.detail}`).join("; ")}` });
      return { ok: blocking.length === 0, preview: opts.preview, errors: blocking.map((c) => `${c.name}: ${c.detail}`), overrides, checks, sizing, mode: "live" as const };
    }

    // Protective orders for the actual shares: stop + target as one OCO, or the stop alone.
    const t0 = { ...idea, shares };
    const protect = idea.target ? { orderStrategyType: "OCO", childOrderStrategies: [targetReplacement(t0, idea.target), stopReplacement(t0, idea.stop)] } : stopReplacement(t0, idea.stop);
    let orderId: string | null = null;
    let stopOrderId: string | null = null;
    let targetOrderId: string | null = null;
    try {
      const r = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, protect);
      orderId = r.orderId;
      if (idea.target && r.orderId) {
        const kids = flatChildren(await getOrder(acct, r.orderId));
        stopOrderId = kids.find((k) => k.orderType === "STOP")?.orderId?.toString() ?? null;
        targetOrderId = kids.find((k) => k.orderType === "LIMIT")?.orderId?.toString() ?? null;
      } else stopOrderId = r.orderId;
    } catch (e) {
      await log({ kind: "error", mode: "live", ticker: idea.ticker, text: `Adopt: Schwab refused the stop: ${(e as Error).message}`, detail: { order: protect } });
      return { ok: false, errors: [`Schwab refused the stop: ${(e as Error).message}`], overrides, checks, sizing, mode: "live" as const };
    }
    const fills = await cachedFills(etParts(now).date, 60_000).catch(() => null);
    const lastFill = (fills?.data ?? []).filter((f) => f.symbol === idea.ticker).sort((a, b) => b.time - a.time)[0];
    const entryTime = lastFill?.time ?? now;
    const risk = Math.abs(entry - idea.stop);
    const trade: Trade = {
      ...idea,
      ...cardRef,
      id: rid(),
      mode: "live",
      status: "open",
      shares,
      submittedAt: entryTime,
      priceAtSubmit: entry,
      initialStop: idea.stop,
      riskPerShare: Math.round(risk * 100) / 100,
      accountValue: acctValue,
      shadowRiskPct: settings.riskPct,
      shadowShares: size.shares,
      fullShadowShares: size.shares,
      plannedRisk: Math.round(size.shares * risk * 100) / 100,
      shadowPosition: size.position,
      shadowRisk: size.risk,
      shadowCapped: size.capped,
      exitBy: idea.days ? exitByDate(etParts(entryTime).date, idea.days) : "",
      orderId,
      stopOrderId,
      targetOrderId,
      orderJson: protect,
      session: "NORMAL",
      entryPrice: entry,
      entryTime,
      slippage: null,
      stopHistory: [{ at: now, stop: idea.stop }],
      targetHistory: [{ at: now, target: idea.target ?? null }],
      notes: ["Adopted: opened outside the app"],
      add: null,
      postMortem: null,
      adopted: true,
      overrides,
    };
    await markEntry(trade, entryTime, quotes);
    await saveTrade(trade);
    await log({
      kind: "order",
      mode: "live",
      ticker: idea.ticker,
      tradeId: trade.id,
      text: `Adopted ${shares} sh ${idea.ticker} @ ${entry} (opened outside the app); sent ${idea.target ? `stop ${idea.stop} + target ${idea.target} (OCO)` : `stop ${idea.stop}`} · order ${orderId} · account ••${acct.last4}`,
      detail: { order: protect },
    });
    for (const o of overrides) await log({ kind: "block", mode: "live", ticker: idea.ticker, tradeId: trade.id, text: `Override (adopted trade): ${o}` });
    return { ok: true, errors: [], overrides, checks, sizing, mode: "live" as const, trade };
  });
}

// ---- Planned add ----

/**
 * "Trigger met": send the one planned add (2/3 of full shadow size; 1 live share for now). The server checks
 * it's the only add, the position is in profit, the new stop keeps starter + add within the idea's risk
 * budget, and the max position / exposure caps; the stop is moved first, then the add goes in with its own
 * stop (and target) attached so no share is ever unprotected.
 */
export async function triggerAdd(id: string, newStop: number, note: string) {
  return withLock(async () => {
    const t = (await store().hgetall<Trade>(KEYS.stockTrades))[id];
    if (!t) return { ok: false, error: "No trade with that id", checks: [] as Check[] };
    const settings = await settingsNow();
    const [quotes, trades, kill] = await Promise.all([stockQuotes([t.ticker, "SPY", ...(t.benchmark ? [t.benchmark] : [])]).catch(() => ({}) as Record<string, StockQuote>), loadTrades(), killSwitchOn()]);
    const last = quotes[t.ticker]?.last ?? null;
    const stop = Math.round(newStop * 100) / 100;
    const r = checkAdd({ trade: t, last, newStop: stop, note, settings, trades, killSwitch: kill, now: clock() });
    if (t.mode === "live" && !liveTradingEnabled()) r.checks.push({ name: "Server live switch", ok: false, detail: "STOCK_LIVE_TRADING is off" });
    const failed = r.checks.filter((c) => !c.ok);
    if (failed.length) {
      await log({ kind: "block", mode: t.mode, ticker: t.ticker, tradeId: id, text: `Add blocked: ${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")}` });
      return { ok: false, error: failed.map((c) => `${c.name}: ${c.detail}`).join("; "), checks: r.checks, requiredStop: r.requiredStop };
    }
    const cur = t.stopHistory.at(-1)?.stop ?? t.initialStop;
    // A risk-sized trade adds the other 2/3 for real; a fixed-size one adds 1 share.
    const addN = t.sizedByRisk ? Math.max(1, r.addShadowShares) : 1;
    const addOrder = bracketOrder({ ...t, entryType: "market", limitPrice: null, stop }, addN, "NORMAL");
    if (t.mode === "live") {
      const acct = await tradingAccount();
      try {
        if (stop !== cur && t.stopOrderId) {
          const rs = await schwabOrder("PUT", `/trader/v1/accounts/${acct.hash}/orders/${t.stopOrderId}`, stopReplacement(t, stop));
          if (rs.orderId) t.stopOrderId = rs.orderId;
        }
      } catch (e) {
        return { ok: false, error: `Couldn't move the stop, so the add wasn't sent: ${(e as Error).message}`, checks: r.checks };
      }
      if (stop !== cur) {
        t.stopHistory.push({ at: Date.now(), stop });
        t.stop = stop;
      }
      try {
        const ro = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, addOrder);
        t.add = { status: "pending", note: note.trim(), requestedAt: Date.now(), priceAtSubmit: last!, liveShares: addN, shadowShares: r.addShadowShares, stopAtAdd: stop, orderId: ro.orderId };
      } catch (e) {
        await saveTrade(t);
        await log({ kind: "error", mode: "live", ticker: t.ticker, tradeId: id, text: `Add rejected: ${(e as Error).message}` });
        return { ok: false, error: `Schwab didn't take the add (the stop move stands): ${(e as Error).message}`, checks: r.checks };
      }
    } else {
      if (stop !== cur) {
        t.stopHistory.push({ at: Date.now(), stop });
        t.stop = stop;
      }
      t.add = { status: "filled", note: note.trim(), requestedAt: Date.now(), priceAtSubmit: last!, liveShares: addN, shadowShares: r.addShadowShares, stopAtAdd: stop, orderId: `dry-add-${t.id}`, price: last, time: Date.now() };
    }
    await saveTrade(t);
    await log({
      kind: "order",
      mode: t.mode,
      ticker: t.ticker,
      tradeId: id,
      text: `${t.mode === "dry" ? "DRY RUN — would send" : "Sent"} ADD ${t.direction === "long" ? "BUY" : "SELL SHORT"} 1 ${t.ticker} at market (shadow +${r.addShadowShares} sh), stop ${stop}${t.target ? `, target ${t.target}` : ""} · trigger met: "${note.trim()}"`,
      detail: { order: addOrder },
    });
    return { ok: true, checks: r.checks, order: addOrder };
  });
}

// ---- Post-mortem ----

export async function savePostMortem(id: string, raw: Record<string, unknown>) {
  return withLock(async () => {
    const t = (await store().hgetall<Trade>(KEYS.stockTrades))[id];
    if (!t || t.status !== "closed") return { ok: false, error: "Post-mortems are for closed trades" };
    const { pm, errors } = parsePostMortem(raw);
    if (!pm) return { ok: false, error: errors.join("; ") };
    t.postMortem = pm;
    await saveTrade(t);
    await log({ kind: "change", mode: t.mode, ticker: t.ticker, tradeId: id, text: `Post-mortem: thesis ${pm.thesisRight}, catalyst ${pm.catalystHappened}, right reason ${pm.rightReason} — ${pm.learned}` });
    return { ok: true };
  });
}

// ---- Exits ----

/** Close one trade at market (or cancel its entry if it hasn't filled). Callers hold the lock. */
async function closeTradeUnlocked(t: Trade, reason: ExitReason, quote: StockQuote | undefined): Promise<Trade> {
  const now = Date.now();
  if (t.mode === "dry") {
    if (t.status === "pending") {
      Object.assign(t, { status: "cancelled", exitReason: reason });
      await saveTrade(t);
      await log({ kind: "cancel", mode: "dry", ticker: t.ticker, tradeId: t.id, text: `DRY RUN — entry cancelled (${reason})` });
      return t;
    }
    const px = quote?.last ?? t.entryPrice ?? t.priceAtSubmit;
    if (t.add?.status === "pending") t.add.status = "cancelled";
    const done = closeOut(t, px, now, reason, await marksAt(t, now));
    await saveTrade(done);
    await log({ kind: "exit", mode: "dry", ticker: t.ticker, tradeId: t.id, text: `DRY RUN — would close at market (${reason}) ~${px}: ${done.pl! >= 0 ? "+" : ""}${done.pl} (${done.r}R)` });
    return done;
  }
  const acct = await tradingAccount();
  if (t.status === "pending") {
    await cancelOrder(acct, t.orderId);
    Object.assign(t, { status: "cancelled", exitReason: reason });
    await saveTrade(t);
    await log({ kind: "cancel", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Entry order ${t.orderId} cancelled (${reason})` });
    return t;
  }
  if (t.status !== "open") return t;
  // Pull the protective legs first so they can't fill too, then close at market.
  await cancelOrder(acct, t.targetOrderId);
  await cancelOrder(acct, t.stopOrderId);
  if (t.add && t.add.status !== "cancelled") {
    await cancelOrder(acct, t.add.targetOrderId);
    await cancelOrder(acct, t.add.stopOrderId);
    if (t.add.status === "pending") {
      await cancelOrder(acct, t.add.orderId);
      t.add.status = "cancelled";
    }
  }
  const total = t.shares + (t.add?.status === "filled" ? t.add.liveShares : 0);
  const closeOrder = marketClose({ ...t, shares: total });
  const r = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, closeOrder);
  Object.assign(t, { status: "closing", exitOrderId: r.orderId, exitReason: reason });
  await saveTrade(t);
  await log({ kind: "order", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Sent market close of ${total} (${reason}) · order ${r.orderId} · account ••${acct.last4}`, detail: { order: closeOrder } });
  return t;
}

export async function closeTrade(id: string, reason: ExitReason = "manual") {
  return withLock(async () => {
    const t = (await store().hgetall<Trade>(KEYS.stockTrades))[id];
    if (!t || !["pending", "open"].includes(t.status)) return { ok: false, error: "No open trade with that id" };
    const q = (await stockQuotes([t.ticker]).catch(() => ({}) as Record<string, StockQuote>))[t.ticker];
    await closeTradeUnlocked(t, reason, q);
    return { ok: true };
  });
}

/** Kill switch: on cancels every unfilled entry and blocks new ones (protective stops stay); off allows entries again. */
export async function setKillSwitch(on: boolean) {
  return withLock(async () => {
    await store().set(KEYS.stockKill, { on, at: Date.now() });
    const settings = await settingsNow();
    const mode = settings.dryRun ? "dry" : "live";
    let cancelled = 0;
    if (on) {
      for (const t of (await loadTrades()).filter((x) => x.status === "pending")) {
        await closeTradeUnlocked(t, "kill", undefined);
        cancelled++;
      }
    }
    await log({ kind: "kill", mode, text: on ? `Kill switch ON: new entries blocked, ${cancelled} unfilled entr${cancelled === 1 ? "y" : "ies"} cancelled (stops on open positions left working)` : "Kill switch OFF: entries allowed" });
    return { ok: true, cancelled };
  });
}

/** Flatten everything this tab opened: cancel entries, close positions at market (reason "kill"). */
export async function flattenAll() {
  return withLock(async () => {
    const live = (await loadTrades()).filter((t) => t.status === "pending" || t.status === "open");
    const quotes = await stockQuotes(live.map((t) => t.ticker)).catch(() => ({}) as Record<string, StockQuote>);
    const errors: string[] = [];
    for (const t of live) {
      try {
        await closeTradeUnlocked(t, "kill", quotes[t.ticker]);
      } catch (e) {
        errors.push(`${t.ticker}: ${(e as Error).message}`);
        await alert(`Flatten failed for ${t.ticker}: ${(e as Error).message}`, t.id);
      }
    }
    await log({ kind: "kill", mode: "live", text: `Flatten all: ${live.length - errors.length} of ${live.length} closed/cancelled` });
    return { ok: errors.length === 0, closed: live.length - errors.length, errors };
  });
}

// ---- Reconcile ----

/** Sync with Schwab (live) or the quotes (dry): fills, stop/target hits, unfilled entries, time exits, missing stops. */
export async function reconcile(): Promise<{ checked: number; changes: string[] }> {
  return withLock(async () => {
    const trades = (await loadTrades()).filter((t) => ["pending", "open", "closing"].includes(t.status));
    const changes: string[] = [];
    if (!trades.length) return { checked: 0, changes };
    const now = clock();
    const quotes = await stockQuotes([...trades.map((t) => t.ticker), "SPY", ...trades.flatMap((t) => (t.benchmark ? [t.benchmark] : []))]).catch(
      () => ({}) as Record<string, StockQuote>,
    );
    const settingsCap = (await settingsNow()).maxPositionPct;

    for (const t of trades) {
      const q = quotes[t.ticker];
      const last = q?.last ?? null;
      try {
        if (t.mode === "dry") {
          if (t.status === "pending") {
            // A limit fills at its price once the market reaches it; a stop entry triggers when the market
            // trades through it and then fills at the market (the last price).
            const below = last !== null && last <= t.limitPrice!;
            const above = last !== null && last >= t.limitPrice!;
            const isStop = t.entryType === "stop";
            const hit = (t.direction === "long") === isStop ? above : below;
            const canTrade = t.session === "SEAMLESS" ? extendedSession(now) : regularSession(now);
            if (hit && canTrade) {
              const fill = isStop ? last! : t.limitPrice!;
              Object.assign(t, { status: "open", entryPrice: fill, entryTime: now, slippage: Math.round((fill - t.limitPrice!) * 10000) / 10000 });
              await markEntry(t, Date.now(), quotes);
              await saveTrade(t);
              changes.push(`${t.ticker}: paper entry filled at ${t.entryPrice}`);
            }
            continue;
          }
          if (t.status === "open" && last !== null && regularSession(now)) {
            const stopHit = t.direction === "long" ? last <= t.stop : last >= t.stop;
            const tgtHit = !!t.target && (t.direction === "long" ? last >= t.target : last <= t.target);
            if (stopHit || tgtHit) {
              const done = closeOut(t, stopHit ? t.stop : t.target!, now, stopHit ? "stop" : "target", await marksAt(t, Date.now(), quotes));
              await saveTrade(done);
              await log({ kind: "exit", mode: "dry", ticker: t.ticker, tradeId: t.id, text: `DRY RUN — ${stopHit ? "stop" : "target"} hit at ${done.exitPrice}: ${done.pl! >= 0 ? "+" : ""}${done.pl} (${done.r}R)` });
              changes.push(`${t.ticker}: paper ${stopHit ? "stop" : "target"}`);
              continue;
            }
            if (timeExitDue(t, now)) {
              await closeTradeUnlocked(t, "time", q);
              changes.push(`${t.ticker}: paper time exit`);
            }
          }
          continue;
        }

        // Live
        const acct = await tradingAccount();
        if (t.status === "closing") {
          const o = t.exitOrderId ? await getOrder(acct, t.exitOrderId) : null;
          const f = fillOf(o);
          if (o?.status === "FILLED" && f) {
            const done = closeOut(t, f.price, f.time, t.exitReason ?? "manual", await marksAt(t, f.time, quotes));
            await saveTrade(done);
            await log({ kind: "exit", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Closed (${done.exitReason}) at ${done.exitPrice}: ${done.pl! >= 0 ? "+" : ""}${done.pl} (${done.r}R)` });
            changes.push(`${t.ticker}: closed`);
          } else if (o && DEAD.has(o.status ?? "")) {
            await alert(`${t.ticker}: the market close order ${t.exitOrderId} was ${o.status}. The position may still be open with no stop — check Schwab now.`, t.id);
          }
          continue;
        }
        if (!t.orderId) continue;
        const parent = await getOrder(acct, t.orderId);
        const kids = flatChildren(parent);
        const stopKid = kids.find((k) => k.orderType === "STOP");
        const tgtKid = kids.find((k) => k.orderType === "LIMIT");
        if (!t.stopOrderId && stopKid?.orderId) t.stopOrderId = String(stopKid.orderId);
        if (!t.targetOrderId && tgtKid?.orderId) t.targetOrderId = String(tgtKid.orderId);

        if (t.status === "pending") {
          const f = fillOf(parent);
          if (parent.status === "FILLED" && f) {
            const risk = Math.abs(f.price - t.initialStop);
            const dir = t.direction === "long" ? 1 : -1;
            Object.assign(t, {
              status: "open",
              entryPrice: f.price,
              entryTime: f.time,
              slippage: Math.round((f.price - t.priceAtSubmit) * dir * 100) / 100,
              riskPerShare: Math.round(risk * 100) / 100,
              ...(() => {
                // Re-size the shadow at the actual fill (same risk %, same cap).
                const z = shadowSize(t.accountValue, { riskPct: t.shadowRiskPct, maxPositionPct: tradeCapPct({ maxPositionPct: settingsCap }, t.positionPct) }, f.price, t.initialStop);
                const st = starterShares(z.shares, t.planAdd);
                return {
                  shadowShares: st,
                  fullShadowShares: z.shares,
                  plannedRisk: Math.round(z.shares * risk * 100) / 100,
                  shadowPosition: Math.round(st * f.price * 100) / 100,
                  shadowRisk: Math.round(st * risk * 100) / 100,
                  shadowCapped: z.capped,
                };
              })(),
            });
            await markEntry(t, f.time, quotes);
            await saveTrade(t);
            await log({ kind: "order", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Entry filled at ${f.price} (slippage ${t.slippage})` });
            changes.push(`${t.ticker}: entry filled`);
          } else if (parent.status === "EXPIRED" && (t.reentries ?? 0) < MAX_REENTRIES && !(await killSwitchOn())) {
            // An entry that expired unfilled goes back in at the next session (cancel it here to stop that).
            if (t.session === "SEAMLESS" ? extendedSession(now) : regularSession(now)) {
              const r = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, bracketOrder(t, t.shares, t.session ?? "NORMAL"));
              Object.assign(t, { orderId: r.orderId, stopOrderId: null, targetOrderId: null, reentries: (t.reentries ?? 0) + 1 });
              await log({ kind: "order", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Entry order expired unfilled: re-entered as order ${r.orderId}` });
              changes.push(`${t.ticker}: entry re-entered`);
            }
            await saveTrade(t);
            continue;
          } else if (DEAD.has(parent.status ?? "")) {
            Object.assign(t, { status: "cancelled" });
            await saveTrade(t);
            await log({ kind: "cancel", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Entry order ${t.orderId} ${parent.status?.toLowerCase()} (not filled)` });
            changes.push(`${t.ticker}: entry ${parent.status}`);
            continue;
          } else {
            await saveTrade(t);
            continue;
          }
        }

        // The planned add: pick up its fill and its own stop/target ids; check its stop like the starter's.
        let addExit: { price: number; time: number } | null = null;
        if (t.add?.orderId && t.add.status !== "cancelled") {
          const ap = await getOrder(acct, t.add.orderId);
          const akids = flatChildren(ap);
          const ak = akids.find((k) => k.orderType === "STOP");
          const at = akids.find((k) => k.orderType === "LIMIT");
          if (!t.add.stopOrderId && ak?.orderId) t.add.stopOrderId = String(ak.orderId);
          if (!t.add.targetOrderId && at?.orderId) t.add.targetOrderId = String(at.orderId);
          const af = fillOf(ap);
          if (t.add.status === "pending" && ap.status === "FILLED" && af) {
            Object.assign(t.add, { status: "filled", price: af.price, time: af.time });
            await log({ kind: "order", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Add filled at ${af.price}` });
            changes.push(`${t.ticker}: add filled`);
          } else if (t.add.status === "pending" && DEAD.has(ap.status ?? "")) {
            t.add.status = "cancelled";
            await log({ kind: "cancel", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Add order ${t.add.orderId} ${ap.status?.toLowerCase()}` });
          }
          if (t.add.status === "filled") {
            const aso = t.add.stopOrderId ? await getOrder(acct, t.add.stopOrderId) : ak;
            const ato = t.add.targetOrderId ? await getOrder(acct, t.add.targetOrderId) : at;
            addExit = (aso?.status === "FILLED" ? fillOf(aso) : null) ?? (ato?.status === "FILLED" ? fillOf(ato) : null);
            if (!addExit && (!aso || (DEAD.has(aso.status ?? "") && aso.status !== "REPLACED"))) {
              await alert(`${t.ticker}: the add has no working stop (${aso?.status ?? "missing"}). Flattening the position.`, t.id);
              await closeTradeUnlocked(t, "kill", q);
              changes.push(`${t.ticker}: add stop missing → flattened`);
              continue;
            }
          }
        }

        // Open: read the current stop/target orders (a tightened stop is a replacement with its own id).
        const stopO = t.stopOrderId ? await getOrder(acct, t.stopOrderId) : stopKid;
        const tgtO = t.targetOrderId ? await getOrder(acct, t.targetOrderId) : tgtKid;
        const sf = stopO?.status === "FILLED" ? fillOf(stopO) : null;
        const tf = tgtO?.status === "FILLED" ? fillOf(tgtO) : null;
        if (sf || tf) {
          // With the add on, wait until its own stop/target has filled too (they sit at the same levels).
          if (t.add?.status === "filled" && !addExit) {
            await saveTrade(t);
            continue;
          }
          const f = (sf ?? tf)!;
          const done = closeOut(t, f.price, f.time, sf ? "stop" : "target", await marksAt(t, f.time, quotes));
          await saveTrade(done);
          await log({ kind: "exit", mode: "live", ticker: t.ticker, tradeId: t.id, text: `${sf ? "Stop" : "Target"} filled at ${f.price}: ${done.pl! >= 0 ? "+" : ""}${done.pl} (${done.r}R)` });
          changes.push(`${t.ticker}: ${sf ? "stop" : "target"} filled`);
          continue;
        }
        // A replaced stop (tightened) lives on under a new id: if we somehow lost that id, alert rather than flatten.
        if (stopO?.status === "REPLACED") {
          await alert(`${t.ticker}: the stop order was replaced but its new id isn't known — check the stop in Schwab.`, t.id);
          await saveTrade(t);
          continue;
        }
        // A position must never be without a working stop. A cancelled or expired stop is put back (with
        // its target) in the regular session, from the open; if that fails, alert and flatten.
        const tgtDead = !!t.target && (!tgtO || (DEAD.has(tgtO.status ?? "") && tgtO.status !== "REPLACED"));
        if (!stopO || DEAD.has(stopO.status ?? "")) {
          if (!regularSession(now)) {
            await saveTrade(t);
            continue; // stops don't trigger outside the regular session: re-enter at the open
          }
          let err = (t.reentries ?? 0) >= MAX_REENTRIES ? `already re-entered ${MAX_REENTRIES} times` : "";
          if (!err) {
            try {
              if (tgtO && !DEAD.has(tgtO.status ?? "")) await cancelOrder(acct, t.targetOrderId);
              await replaceProtection(acct, t);
            } catch (e) {
              err = (e as Error).message;
            }
          }
          if (err) {
            await alert(`${t.ticker}: no working stop (stop order ${stopO?.status ?? "missing"}) and it couldn't be re-entered (${err}). Flattening the position.`, t.id);
            await closeTradeUnlocked(t, "kill", q);
            changes.push(`${t.ticker}: stop missing → flattened`);
            continue;
          }
          await saveTrade(t);
          await alert(`${t.ticker}: the stop order was ${stopO?.status?.toLowerCase() ?? "missing"}; re-entered stop ${t.stop}${t.target ? ` and target ${t.target}` : ""}.`, t.id);
          await log({ kind: "order", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Stop was ${stopO?.status?.toLowerCase() ?? "missing"}: re-entered stop ${t.stop}${t.target ? ` + target ${t.target}` : ""}` });
          changes.push(`${t.ticker}: stop re-entered`);
          continue;
        }
        // The target was cancelled or expired while the stop still works: swap in a fresh stop+target pair.
        if (tgtDead && regularSession(now) && (t.reentries ?? 0) < MAX_REENTRIES && !(t.add && t.add.status !== "cancelled")) {
          const oldStop = t.stopOrderId;
          try {
            await cancelOrder(acct, oldStop);
            await replaceProtection(acct, t);
            await saveTrade(t);
            await log({ kind: "order", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Target was ${tgtO?.status?.toLowerCase() ?? "missing"}: re-entered stop ${t.stop} + target ${t.target}` });
            changes.push(`${t.ticker}: target re-entered`);
          } catch (e) {
            // The old stop is gone and the pair was refused: put a lone stop back, or flatten.
            try {
              const r = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, stopReplacement(t, t.stop));
              Object.assign(t, { stopOrderId: r.orderId, targetOrderId: null, reentries: MAX_REENTRIES });
              await saveTrade(t);
              await alert(`${t.ticker}: the target couldn't be re-entered (${(e as Error).message}); the stop ${t.stop} is working.`, t.id);
            } catch (e2) {
              await alert(`${t.ticker}: re-entering the target failed and the stop couldn't be restored (${(e2 as Error).message}). Flattening.`, t.id);
              await closeTradeUnlocked(t, "kill", q);
            }
          }
          continue;
        }
        await saveTrade(t);
        if (timeExitDue(t, now)) {
          await closeTradeUnlocked(t, "time", q);
          changes.push(`${t.ticker}: time exit sent`);
        }
      } catch (e) {
        await log({ kind: "error", mode: t.mode, ticker: t.ticker, tradeId: t.id, text: `Sync error: ${(e as Error).message}` });
      }
    }
    return { checked: trades.length, changes };
  });
}

/**
 * Resize every open dry-run position to the current "max position" % of the account (at the last price):
 * bigger ones are cut, smaller ones are raised — which can put a wide-stop trade over the risk-per-trade %. Paper only: nothing is sent to Schwab, and live positions are left alone.
 */
export async function trimDryToCap(): Promise<{ ok: boolean; error?: string; trimmed: string[] }> {
  return withLock(async () => {
    const settings = await settingsNow();
    const acct = await tradingAccount();
    const value = await accountValue(acct).catch(() => null);
    if (!value) return { ok: false, error: "Couldn't read the account value", trimmed: [] };
    const all = await loadTrades();
    const open = all.filter((t) => t.mode === "dry" && t.status === "open" && t.entryPrice);
    const quotes = await stockQuotes([...new Set(open.map((t) => t.ticker))]).catch(() => ({}) as Record<string, StockQuote>);
    const cap = (settings.maxPositionPct / 100) * value;
    const trimmed: string[] = [];
    for (const t of open) {
      const px = quotes[t.ticker]?.last ?? t.entryPrice!;
      const addOn = t.add?.status === "filled" ? t.add.shadowShares : 0;
      const total = t.shadowShares + addOn;
      const want = Math.floor(cap / px);
      if (!(px > 0) || total === want || want < 1) continue;
      const k = want / total;
      const starter = addOn ? Math.max(1, Math.floor(t.shadowShares * k)) : want;
      const risk = Math.abs(t.entryPrice! - t.initialStop);
      const full = Math.max(starter, Math.floor((t.fullShadowShares ?? t.shadowShares) * k));
      if (t.add && addOn) t.add.shadowShares = Math.max(0, want - starter);
      if (t.sizedByRisk) {
        t.shares = starter;
        if (t.add && addOn) t.add.liveShares = t.add.shadowShares;
      }
      Object.assign(t, {
        shadowShares: starter,
        fullShadowShares: full,
        plannedRisk: Math.round(full * risk * 100) / 100,
        shadowPosition: Math.round(starter * t.entryPrice! * 100) / 100,
        shadowRisk: Math.round(starter * risk * 100) / 100,
        shadowCapped: true,
      });
      await saveTrade(t);
      // Sizing up past the risk-based size means a stop-out loses more than the risk-per-trade %: say so.
      const riskPct = (want * risk) / value * 100;
      const over = riskPct > settings.riskPct * 1.02 ? ` (stop-out risk now ${riskPct.toFixed(2)}% of the account, over the ${settings.riskPct}% setting)` : "";
      await log({ kind: "change", mode: "dry", ticker: t.ticker, tradeId: t.id, text: `DRY RUN — size ${total} → ${want} sh to make it ${settings.maxPositionPct}% of the account${over}` });
      trimmed.push(`${t.ticker} ${total} → ${want}${over}`);
    }
    return { ok: true, trimmed };
  });
}

// ---- Settings ----

export async function updateSettings(patch: Partial<StockSettings>) {
  return withLock(async () => {
    const r = changeSettings(await loadSettings(), patch);
    if (!r.errors.length && (r.applied.length || r.delayed.length)) {
      await store().set(KEYS.stockSettings, r.next);
      await log({
        kind: "settings",
        mode: effectiveSettings(r.next).dryRun ? "dry" : "live",
        text: [r.applied.length ? `Now: ${r.applied.join(", ")}` : "", r.delayed.length ? `In 24h: ${r.delayed.join(", ")}` : ""].filter(Boolean).join(" · "),
      });
    }
    return r;
  });
}
