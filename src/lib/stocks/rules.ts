// Stock Trades: the rules, as pure functions (no I/O), so the server enforces them and the tests pin them.
// The UI only displays what these return; every order request is checked here on the server.
import { addDays, etParts, isTradingDay } from "../time";

export const SOURCES = ["trend scout", "3b scan", "insider buy", "earnings beat", "news", "other"] as const;
export type Source = (typeof SOURCES)[number];
export type Direction = "long" | "short";
export type ExitReason = "stop" | "target" | "time" | "manual" | "kill";
export type Mode = "dry" | "live";

export interface IdeaInput {
  ticker: string;
  direction: Direction;
  entryType: "market" | "limit";
  limitPrice?: number | null;
  stop: number;
  target?: number | null;
  thesis: string;
  invalidation: string;
  days: number;
  source: Source;
}

export interface Trade extends IdeaInput {
  id: string;
  mode: Mode;
  /** pending: entry order working; open: filled with a working stop; closing: exit order sent; closed; cancelled: entry never filled. */
  status: "pending" | "open" | "closing" | "closed" | "cancelled";
  shares: number;
  submittedAt: number;
  /** Price when submitted (last trade), for slippage. */
  priceAtSubmit: number;
  initialStop: number;
  /** Risk per share to the initial stop, from the submit price (replaced by the fill price once filled). */
  riskPerShare: number;
  accountValue: number | null;
  shadowRiskPct: number;
  shadowShares: number;
  exitBy: string; // YYYY-MM-DD (ET): closed at market on this day
  orderId?: string | null;
  stopOrderId?: string | null;
  targetOrderId?: string | null;
  exitOrderId?: string | null;
  orderJson?: unknown;
  entryPrice?: number | null;
  entryTime?: number | null;
  slippage?: number | null;
  exitPrice?: number | null;
  exitTime?: number | null;
  exitReason?: ExitReason | null;
  pl?: number | null;
  plPct?: number | null;
  r?: number | null;
  shadowPl?: number | null;
  stopHistory: { at: number; stop: number }[];
  targetHistory: { at: number; target: number | null }[];
  notes: string[];
}

export interface StockSettings {
  dryRun: boolean;
  shares: number;
  maxOpen: number;
  maxPerWeek: number;
  /** Weekly realized shadow loss, % of the account, that locks new entries until Monday. */
  weeklyLossPct: number;
  /** Shadow size: % of the account risked to the stop. */
  shadowRiskPct: number;
}

export const DEFAULT_SETTINGS: StockSettings = { dryRun: true, shares: 1, maxOpen: 6, maxPerWeek: 3, weeklyLossPct: 2, shadowRiskPct: 0.5 };

/** Limits where a higher number is looser: raising them waits 24 hours; lowering them applies at once. */
export const LOOSEN_UP: (keyof StockSettings)[] = ["shares", "maxOpen", "maxPerWeek", "weeklyLossPct"];
export const LOOSEN_DELAY_MS = 24 * 3600_000;

export interface StoredSettings {
  values: StockSettings;
  pending: { key: keyof StockSettings; value: number | boolean; effectiveAt: number; requestedAt: number }[];
}

export function effectiveSettings(s: StoredSettings | null, now = Date.now()): StockSettings {
  const values = { ...DEFAULT_SETTINGS, ...(s?.values ?? {}) };
  for (const p of s?.pending ?? []) if (p.effectiveAt <= now) (values as Record<string, unknown>)[p.key] = p.value;
  return values;
}

/** Fold pending changes whose time has come into the values (housekeeping before a write). */
export function settle(s: StoredSettings | null, now = Date.now()): StoredSettings {
  return { values: effectiveSettings(s, now), pending: (s?.pending ?? []).filter((p) => p.effectiveAt > now) };
}

const LIMITS: Record<keyof StockSettings, [number, number] | null> = {
  dryRun: null,
  shares: [1, 1000],
  maxOpen: [0, 50],
  maxPerWeek: [0, 50],
  weeklyLossPct: [0.1, 50],
  shadowRiskPct: [0.05, 5],
};

/** Apply a settings change: tightening (and dry-run either way) at once, loosening 24 hours later. */
export function changeSettings(
  s: StoredSettings | null,
  patch: Partial<StockSettings>,
  now = Date.now(),
): { next: StoredSettings; applied: string[]; delayed: string[]; errors: string[] } {
  const next = settle(s, now);
  const applied: string[] = [];
  const delayed: string[] = [];
  const errors: string[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof StockSettings, number | boolean][]) {
    if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
    if (k === "dryRun") {
      if (typeof v !== "boolean") errors.push("dryRun must be true or false");
      else if (v !== next.values.dryRun) {
        next.values.dryRun = v;
        applied.push(`dry run ${v ? "on" : "off"}`);
      }
      continue;
    }
    const lim = LIMITS[k]!;
    if (typeof v !== "number" || !Number.isFinite(v) || v < lim[0] || v > lim[1]) {
      errors.push(`${k} must be between ${lim[0]} and ${lim[1]}`);
      continue;
    }
    const val = k === "shares" || k === "maxOpen" || k === "maxPerWeek" ? Math.round(v) : v;
    const cur = next.values[k] as number;
    next.pending = next.pending.filter((p) => p.key !== k);
    if (val === cur) continue;
    if (LOOSEN_UP.includes(k) && val > cur) {
      next.pending.push({ key: k, value: val, effectiveAt: now + LOOSEN_DELAY_MS, requestedAt: now });
      delayed.push(`${k} ${cur} → ${val}`);
    } else {
      (next.values as unknown as Record<string, number>)[k] = val;
      applied.push(`${k} ${cur} → ${val}`);
    }
  }
  return { next, applied, delayed, errors };
}

// ---- Calendar ----

export function addTradingDays(date: string, n: number): string {
  let d = date;
  for (let i = 0; i < n; ) {
    d = addDays(d, 1);
    if (isTradingDay(d)) i++;
  }
  return d;
}

/** Monday of the Mon–Fri week containing `date` (weekends belong to the week just ended). */
export function weekStart(date: string): string {
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

/** Last day of the time frame: entry date + N calendar days, moved to the next trading day if needed. */
export function exitByDate(entryDate: string, days: number): string {
  let d = addDays(entryDate, Math.max(1, Math.round(days)));
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

/** Entries are allowed on trading days 9:45–15:45 ET. */
export function entryWindowOpen(now = Date.now()): { ok: boolean; why?: string } {
  const p = etParts(now);
  if (!isTradingDay(p.date)) return { ok: false, why: "Market closed today (weekend or holiday)" };
  if (p.minutesOfDay < 9 * 60 + 45) return { ok: false, why: "No new entries before 9:45 ET" };
  if (p.minutesOfDay >= 15 * 60 + 45) return { ok: false, why: "No new entries after 15:45 ET" };
  return { ok: true };
}

/** Regular session (exits at market go in then). */
export function regularSession(now = Date.now()): boolean {
  const p = etParts(now);
  return isTradingDay(p.date) && p.minutesOfDay >= 9 * 60 + 30 && p.minutesOfDay < 16 * 60;
}

/** Time exit is due from 15:30 ET on the exit-by day (or any session after it). */
export function timeExitDue(t: Pick<Trade, "exitBy">, now = Date.now()): boolean {
  const p = etParts(now);
  return regularSession(now) && (p.date > t.exitBy || (p.date === t.exitBy && p.minutesOfDay >= 15 * 60 + 30));
}

// ---- Validation and guardrails ----

const round2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : NaN);

/** Parse and check the form: every field required (target optional). */
export function parseIdea(raw: Record<string, unknown>): { idea: IdeaInput | null; errors: string[] } {
  const errors: string[] = [];
  const ticker = String(raw.ticker ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-/]{0,9}$/.test(ticker)) errors.push("Ticker is required (letters, e.g. AAPL or BRK/B)");
  const direction = raw.direction === "long" || raw.direction === "short" ? raw.direction : null;
  if (!direction) errors.push("Direction is required (long or short)");
  const entryType = raw.entryType === "market" || raw.entryType === "limit" ? raw.entryType : null;
  if (!entryType) errors.push("Entry type is required (market or limit)");
  const limitPrice = num(raw.limitPrice);
  if (entryType === "limit" && !(limitPrice > 0)) errors.push("Limit price is required for a limit entry");
  const stop = num(raw.stop);
  if (!(stop > 0)) errors.push("Stop price is required");
  const targetRaw = raw.target === null || raw.target === undefined || raw.target === "" ? null : num(raw.target);
  if (targetRaw !== null && !(targetRaw > 0)) errors.push("Target must be a price (or left empty)");
  const thesis = String(raw.thesis ?? "").trim();
  if (thesis.length < 10) errors.push("Thesis is required (1–3 sentences)");
  if (thesis.length > 600) errors.push("Thesis is too long (keep it to 1–3 sentences)");
  const invalidation = String(raw.invalidation ?? "").trim();
  if (invalidation.length < 5) errors.push("Invalidation is required (what proves it wrong)");
  if (invalidation.length > 400) errors.push("Invalidation is too long");
  const days = num(raw.days);
  if (!(days >= 1 && days <= 365 && Number.isInteger(days))) errors.push("Time frame is required (whole days, 1–365)");
  const source = SOURCES.includes(raw.source as Source) ? (raw.source as Source) : null;
  if (!source) errors.push("Source is required");
  if ("shares" in raw || "quantity" in raw || "size" in raw) errors.push("Size can't be set here (fixed in Settings)");
  if (errors.length) return { idea: null, errors };
  return {
    idea: {
      ticker,
      direction: direction!,
      entryType: entryType!,
      limitPrice: entryType === "limit" ? round2(limitPrice) : null,
      stop: round2(stop),
      target: targetRaw === null ? null : round2(targetRaw),
      thesis,
      invalidation,
      days,
      source: source!,
    },
    errors: [],
  };
}

export interface StockQuote {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  description?: string | null;
  shortable: boolean | null;
  hardToBorrow: boolean | null;
}

export interface CheckContext {
  idea: IdeaInput;
  quote: StockQuote | null;
  trades: Trade[];
  settings: StockSettings;
  killSwitch: boolean;
  accountValue: number | null;
  now: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const isOpen = (t: Trade) => t.status === "pending" || t.status === "open" || t.status === "closing";

/** Trades' closed P/L of the current mode, in close order. */
const closedOfMode = (trades: Trade[], mode: Mode) =>
  trades.filter((t) => t.mode === mode && t.status === "closed" && typeof t.pl === "number").sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));

/** When the 3-losses-in-a-row lockout ends (null if none is running): 2 full trading days after the 3rd (or later) loss. */
export function streakLockUntil(trades: Trade[], mode: Mode): string | null {
  let streak = 0;
  let until: string | null = null;
  for (const t of closedOfMode(trades, mode)) {
    if ((t.pl ?? 0) < 0) {
      streak++;
      if (streak >= 3) until = addTradingDays(etParts(t.exitTime ?? 0).date, 3);
    } else streak = 0;
  }
  return until;
}

/** This week's realized shadow P/L (Mon–Fri week of `now`), current mode. */
export function weekShadowPl(trades: Trade[], mode: Mode, now: number): number {
  const wk = weekStart(etParts(now).date);
  return closedOfMode(trades, mode)
    .filter((t) => weekStart(etParts(t.exitTime ?? 0).date) === wk)
    .reduce((s, t) => s + (t.shadowPl ?? 0), 0);
}

/** Every pre-trade check, pass or fail, in the order shown. */
export function preTradeChecks(c: CheckContext): Check[] {
  const { idea, quote, settings, now } = c;
  const mode: Mode = settings.dryRun ? "dry" : "live";
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });

  add("Kill switch", !c.killSwitch, c.killSwitch ? "Kill switch is on: new entries are blocked until you switch it off" : "Off");
  const win = entryWindowOpen(now);
  add("Time window", win.ok, win.ok ? "Inside 9:45–15:45 ET on a trading day" : win.why!);

  const last = quote?.last ?? null;
  add("Quote", last !== null && last > 0, last ? `${idea.ticker} last ${last}` : `No current quote for ${idea.ticker}`);
  if (last !== null && last > 0) {
    // Reference price for the risk: the limit for a limit entry (that's where it fills), else the last price.
    const ref = idea.entryType === "limit" && idea.limitPrice ? idea.limitPrice : last;
    const sideOk = idea.direction === "long" ? idea.stop < last && idea.stop < ref : idea.stop > last && idea.stop > ref;
    add(
      "Stop side",
      sideOk,
      sideOk
        ? `Stop ${idea.stop} is ${idea.direction === "long" ? "below" : "above"} the price`
        : `A ${idea.direction} stop must be ${idea.direction === "long" ? "below" : "above"} the current price (${last}) and the entry`,
    );
    const riskPct = (Math.abs(ref - idea.stop) / ref) * 100;
    const riskOk = riskPct >= 1 && riskPct <= 25;
    add("Risk to stop", riskOk, `${riskPct.toFixed(2)}% of the entry price${riskOk ? "" : " (must be 1%–25%)"}`);
    if (idea.entryType === "limit" && idea.limitPrice) {
      const lOk = idea.direction === "long" ? idea.limitPrice > idea.stop : idea.limitPrice < idea.stop;
      add("Limit vs stop", lOk, lOk ? "Limit is on the right side of the stop" : "The limit price is past the stop");
    }
    if (idea.target) {
      const tOk = idea.direction === "long" ? idea.target > ref : idea.target < ref;
      add("Target side", tOk, tOk ? `Target ${idea.target}` : `A ${idea.direction} target must be ${idea.direction === "long" ? "above" : "below"} the entry`);
    }
  }
  if (idea.direction === "short") {
    const ok = quote?.shortable === true && quote?.hardToBorrow === false;
    add(
      "Shortable",
      ok,
      ok
        ? "Schwab: shortable, not hard-to-borrow"
        : quote?.shortable === false
          ? "Schwab says it isn't shortable"
          : quote?.hardToBorrow
            ? "Schwab lists it as hard-to-borrow"
            : "Couldn't confirm it's shortable and easy to borrow",
    );
  }

  const mine = c.trades.filter((t) => t.mode === mode);
  const open = mine.filter(isOpen);
  add("Max open ideas", open.length < settings.maxOpen, `${open.length} open of ${settings.maxOpen}`);
  const wk = weekStart(etParts(now).date);
  const thisWeek = mine.filter((t) => weekStart(etParts(t.submittedAt).date) === wk).length;
  add("Ideas this week", thisWeek < settings.maxPerWeek, `${thisWeek} of ${settings.maxPerWeek} this week (Mon–Fri)`);
  const sameTicker = open.find((t) => t.ticker === idea.ticker);
  add("One position per ticker", !sameTicker, sameTicker ? `Already ${sameTicker.status} in ${idea.ticker}: no adding to a position` : "None open");

  const wkLoss = weekShadowPl(c.trades, mode, now);
  const lossLimit = c.accountValue ? (-settings.weeklyLossPct / 100) * c.accountValue : null;
  const lossOk = lossLimit === null || wkLoss > lossLimit;
  add(
    "Weekly loss lockout",
    lossOk,
    lossLimit === null
      ? "Account value unknown: weekly loss check skipped"
      : `This week's shadow P/L ${Math.round(wkLoss).toLocaleString("en-US")} vs limit ${Math.round(lossLimit).toLocaleString("en-US")}${lossOk ? "" : ": blocked until Monday"}`,
  );
  const lockUntil = streakLockUntil(c.trades, mode);
  const streakOk = !lockUntil || etParts(now).date >= lockUntil;
  add("Losing-streak lockout", streakOk, streakOk ? "No 3-loss lockout running" : `3 losses in a row: blocked until ${lockUntil}`);
  return out;
}

// ---- Stop / target changes ----

export function checkStopChange(t: Pick<Trade, "direction" | "stopHistory" | "initialStop">, newStop: number, last: number | null): string | null {
  const cur = t.stopHistory.at(-1)?.stop ?? t.initialStop;
  if (!(newStop > 0)) return "Stop must be a price";
  if (t.direction === "long" ? newStop < cur : newStop > cur) return `Stops can only be tightened (current ${cur})`;
  if (newStop === cur) return "That's the current stop";
  if (last !== null && (t.direction === "long" ? newStop >= last : newStop <= last)) return `A tightened stop must still be ${t.direction === "long" ? "below" : "above"} the price (${last})`;
  return null;
}

// ---- Results ----

export function closeOut(t: Trade, exitPrice: number, exitTime: number, reason: ExitReason): Trade {
  const entry = t.entryPrice ?? t.priceAtSubmit;
  const dir = t.direction === "long" ? 1 : -1;
  const perShare = (exitPrice - entry) * dir;
  const risk = Math.abs(entry - t.initialStop) || t.riskPerShare;
  return {
    ...t,
    status: "closed",
    exitPrice: round2(exitPrice),
    exitTime,
    exitReason: reason,
    pl: round2(perShare * t.shares),
    plPct: Math.round((perShare / entry) * 10000) / 100,
    r: risk > 0 ? Math.round((perShare / risk) * 100) / 100 : null,
    shadowPl: round2(perShare * t.shadowShares),
  };
}

export function shadowShares(accountValue: number | null, riskPct: number, riskPerShare: number): number {
  if (!accountValue || !(riskPerShare > 0)) return 0;
  return Math.floor(((riskPct / 100) * accountValue) / riskPerShare);
}

export interface Summary {
  trades: number;
  wins: number;
  winPct: number | null;
  avgR: number | null;
  totalR: number;
  shadowPl: number;
  pl: number;
  bySource: { key: string; trades: number; winPct: number | null; avgR: number | null; totalR: number; shadowPl: number }[];
  byDirection: { key: string; trades: number; winPct: number | null; avgR: number | null; totalR: number; shadowPl: number }[];
}

export function summarize(trades: Trade[], mode: Mode): Summary {
  const closed = closedOfMode(trades, mode);
  const agg = (ts: Trade[]) => {
    const rs = ts.map((t) => t.r).filter((r): r is number => typeof r === "number");
    const wins = ts.filter((t) => (t.pl ?? 0) > 0).length;
    return {
      trades: ts.length,
      wins,
      winPct: ts.length ? wins / ts.length : null,
      avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      totalR: Math.round(rs.reduce((a, b) => a + b, 0) * 100) / 100,
      shadowPl: round2(ts.reduce((s, t) => s + (t.shadowPl ?? 0), 0)),
    };
  };
  const group = (key: (t: Trade) => string) => {
    const m = new Map<string, Trade[]>();
    for (const t of closed) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
    return [...m].map(([k, ts]) => ({ key: k, ...agg(ts) })).sort((a, b) => b.trades - a.trades);
  };
  const all = agg(closed);
  return {
    ...all,
    pl: round2(closed.reduce((s, t) => s + (t.pl ?? 0), 0)),
    bySource: group((t) => t.source),
    byDirection: group((t) => t.direction),
  };
}

/** Display-only size-up rule: 40 closed trades, average R above 0, no guardrail overrides. */
export function sizeUpEligible(s: Summary, overrides: number): boolean {
  return s.trades >= 40 && (s.avgR ?? 0) > 0 && overrides === 0;
}

// ---- Schwab order JSON ----

const px = (v: number) => v.toFixed(v < 1 ? 4 : 2);

/** One bracket: the entry triggers an OCO of the stop and the target (or just the stop when there's no target). */
export function bracketOrder(idea: IdeaInput, shares: number): Record<string, unknown> {
  const open = idea.direction === "long" ? "BUY" : "SELL_SHORT";
  const close = idea.direction === "long" ? "SELL" : "BUY_TO_COVER";
  const leg = (instruction: string) => [{ instruction, quantity: shares, instrument: { symbol: idea.ticker, assetType: "EQUITY" } }];
  const stopOrder = { orderStrategyType: "SINGLE", session: "NORMAL", duration: "GOOD_TILL_CANCEL", orderType: "STOP", stopPrice: px(idea.stop), orderLegCollection: leg(close) };
  const children = idea.target
    ? [
        {
          orderStrategyType: "OCO",
          childOrderStrategies: [
            { orderStrategyType: "SINGLE", session: "NORMAL", duration: "GOOD_TILL_CANCEL", orderType: "LIMIT", price: px(idea.target), orderLegCollection: leg(close) },
            stopOrder,
          ],
        },
      ]
    : [stopOrder];
  return {
    orderStrategyType: "TRIGGER",
    session: "NORMAL",
    duration: "DAY",
    orderType: idea.entryType === "market" ? "MARKET" : "LIMIT",
    ...(idea.entryType === "limit" ? { price: px(idea.limitPrice!) } : {}),
    orderLegCollection: leg(open),
    childOrderStrategies: children,
  };
}

export function stopReplacement(t: Pick<Trade, "direction" | "ticker" | "shares">, stop: number) {
  const close = t.direction === "long" ? "SELL" : "BUY_TO_COVER";
  return {
    orderStrategyType: "SINGLE",
    session: "NORMAL",
    duration: "GOOD_TILL_CANCEL",
    orderType: "STOP",
    stopPrice: px(stop),
    orderLegCollection: [{ instruction: close, quantity: t.shares, instrument: { symbol: t.ticker, assetType: "EQUITY" } }],
  };
}

export function targetReplacement(t: Pick<Trade, "direction" | "ticker" | "shares">, target: number) {
  const close = t.direction === "long" ? "SELL" : "BUY_TO_COVER";
  return {
    orderStrategyType: "SINGLE",
    session: "NORMAL",
    duration: "GOOD_TILL_CANCEL",
    orderType: "LIMIT",
    price: px(target),
    orderLegCollection: [{ instruction: close, quantity: t.shares, instrument: { symbol: t.ticker, assetType: "EQUITY" } }],
  };
}

export function marketClose(t: Pick<Trade, "direction" | "ticker" | "shares">) {
  const close = t.direction === "long" ? "SELL" : "BUY_TO_COVER";
  return {
    orderStrategyType: "SINGLE",
    session: "NORMAL",
    duration: "DAY",
    orderType: "MARKET",
    orderLegCollection: [{ instruction: close, quantity: t.shares, instrument: { symbol: t.ticker, assetType: "EQUITY" } }],
  };
}
