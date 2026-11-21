// Stock Trades engine (server only): submit ideas, change stops/targets, close, kill switch, flatten, reconcile.
// Every path runs the guardrails in rules.ts here on the server; the UI is never trusted. In dry-run mode
// nothing reaches Schwab's order API: the order is logged and the trade is paper-filled at quotes.
import "server-only";
import { KEYS, kv } from "../kv";
import { schwabGet, SchwabApiError, type AccountNumber } from "../schwab/client";
import { cachedMinuteBars } from "../schwab/data";
import { mockEnabled } from "../schwab/mock";
import { liveTradingEnabled, schwabOrder } from "../schwab/trading";
import { addDays, etParts, isTradingDay } from "../time";
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

/** A paper DAY entry expires at its session's end (16:00, or 20:00 for extended hours) on the first trading day it could work. */
function dayOrderExpired(t: Trade, now: number): boolean {
  let d = etParts(t.submittedAt).date;
  const endMin = t.session === "SEAMLESS" ? 20 * 60 : 16 * 60;
  // Placed after that day's end (or on a non-trading day): it works on the next trading day.
  if (!isTradingDay(d) || etParts(t.submittedAt).minutesOfDay >= endMin) {
    do d = addDays(d, 1);
    while (!isTradingDay(d));
  }
  const p = etParts(now);
  return p.date > d || (p.date === d && p.minutesOfDay >= endMin);
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
  sizing?: { liveShares: number; shadow: ReturnType<typeof shadowSize>; entryRef: number; accountValue: number | null };
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
    const { idea, errors } = parseIdea(raw);
    if (!idea) {
      await log({ kind: "block", mode, ticker: String(raw.ticker ?? "").toUpperCase() || undefined, text: `Form incomplete: ${errors.join("; ")}` });
      return { ok: false, errors, checks: [], mode };
    }
    const now = clock();
    const [acct, quotes, trades, kill] = await Promise.all([tradingAccount(), stockQuotes([idea.ticker]).catch(() => ({}) as Record<string, StockQuote>), loadTrades(), killSwitchOn()]);
    const acctValue = await accountValue(acct).catch(() => null);
    const quote = quotes[idea.ticker] ?? null;
    const checks = preTradeChecks({ idea, quote, trades, settings, killSwitch: kill, accountValue: acctValue, now });
    if (mode === "live") {
      const on = liveTradingEnabled();
      checks.push({ name: "Server live switch", ok: on, detail: on ? "On" : "STOCK_LIVE_TRADING is off on the server: live orders can't be sent" });
    }
    const failed = checks.filter((c) => !c.ok);
    const lastPx = quote?.last ?? null;
    const entryRef = idea.entryType === "limit" && idea.limitPrice ? idea.limitPrice : (lastPx ?? 0);
    const sizing = { liveShares: settings.shares, shadow: shadowSize(acctValue, settings, entryRef, idea.stop), entryRef, accountValue: acctValue };
    if (opts.preview) return { ok: failed.length === 0, preview: true, sizing, errors: failed.map((c) => `${c.name}: ${c.detail}`), checks, mode, order: bracketOrder(idea, settings.shares, entrySession(idea.entryType, now).session) };
    if (failed.length) {
      await log({ kind: "block", mode, ticker: idea.ticker, text: failed.map((c) => `${c.name}: ${c.detail}`).join("; "), detail: { idea } });
      return { ok: false, errors: failed.map((c) => `${c.name}: ${c.detail}`), checks, mode, sizing };
    }

    const last = quote!.last!;
    const ref = idea.entryType === "limit" ? idea.limitPrice! : last;
    const risk = Math.abs(ref - idea.stop);
    const size = shadowSize(acctValue, settings, ref, idea.stop);
    const session = entrySession(idea.entryType, now).session;
    const order = bracketOrder(idea, settings.shares, session);
    const trade: Trade = {
      ...idea,
      id: rid(),
      mode,
      status: "pending",
      shares: settings.shares,
      submittedAt: now,
      priceAtSubmit: last,
      initialStop: idea.stop,
      riskPerShare: Math.round(risk * 100) / 100,
      accountValue: acctValue,
      shadowRiskPct: settings.riskPct,
      shadowShares: size.shares,
      shadowPosition: size.position,
      shadowRisk: size.risk,
      shadowCapped: size.capped,
      exitBy: exitByDate(etParts(now).date, idea.days),
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
      else if ((session === "NORMAL" || extendedSession(now)) && (idea.direction === "long" ? last <= idea.limitPrice! : last >= idea.limitPrice!)) {
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
      text: `${mode === "dry" ? "DRY RUN — would send" : "Sent"} ${idea.direction === "long" ? "BUY" : "SELL SHORT"} ${settings.shares} ${idea.ticker} ${idea.entryType === "market" ? "at market" : `limit ${idea.limitPrice}`}, stop ${idea.stop}${idea.target ? `, target ${idea.target}` : ""} (bracket)${trade.orderId && mode === "live" ? ` · order ${trade.orderId}` : ""} · account ••${acct.last4}`,
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
  const r = await schwabOrder("POST", `/trader/v1/accounts/${acct.hash}/orders`, marketClose(t));
  Object.assign(t, { status: "closing", exitOrderId: r.orderId, exitReason: reason });
  await saveTrade(t);
  await log({ kind: "order", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Sent market close (${reason}) · order ${r.orderId} · account ••${acct.last4}`, detail: { order: marketClose(t) } });
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
            const hit = last !== null && (t.direction === "long" ? last <= t.limitPrice! : last >= t.limitPrice!);
            const canTrade = t.session === "SEAMLESS" ? extendedSession(now) : regularSession(now);
            if (hit && canTrade) {
              Object.assign(t, { status: "open", entryPrice: t.limitPrice, entryTime: now, slippage: 0 });
              await markEntry(t, Date.now(), quotes);
              await saveTrade(t);
              changes.push(`${t.ticker}: paper entry filled at ${t.limitPrice}`);
            } else if (dayOrderExpired(t, now)) {
              Object.assign(t, { status: "cancelled", exitReason: null });
              await saveTrade(t);
              await log({ kind: "cancel", mode: "dry", ticker: t.ticker, tradeId: t.id, text: "DRY RUN — limit entry not filled by the close (day order expired)" });
              changes.push(`${t.ticker}: paper limit expired`);
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
                const z = shadowSize(t.accountValue, { riskPct: t.shadowRiskPct, maxPositionPct: settingsCap }, f.price, t.initialStop);
                return { shadowShares: z.shares, shadowPosition: z.position, shadowRisk: z.risk, shadowCapped: z.capped };
              })(),
            });
            await markEntry(t, f.time, quotes);
            await saveTrade(t);
            await log({ kind: "order", mode: "live", ticker: t.ticker, tradeId: t.id, text: `Entry filled at ${f.price} (slippage ${t.slippage})` });
            changes.push(`${t.ticker}: entry filled`);
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

        // Open: read the current stop/target orders (a tightened stop is a replacement with its own id).
        const stopO = t.stopOrderId ? await getOrder(acct, t.stopOrderId) : stopKid;
        const tgtO = t.targetOrderId ? await getOrder(acct, t.targetOrderId) : tgtKid;
        const sf = stopO?.status === "FILLED" ? fillOf(stopO) : null;
        const tf = tgtO?.status === "FILLED" ? fillOf(tgtO) : null;
        if (sf || tf) {
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
        // A position must never be without a working stop: alert and flatten.
        if (!stopO || DEAD.has(stopO.status ?? "")) {
          await alert(`${t.ticker}: no working stop (stop order ${stopO?.status ?? "missing"}). Flattening the position.`, t.id);
          await closeTradeUnlocked(t, "kill", q);
          changes.push(`${t.ticker}: stop missing → flattened`);
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
