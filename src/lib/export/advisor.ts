// Read-only export for the Book advisor's entry advisor (spx-ai-agent: docs/oo-trading-export.md, validated there
// against lib/entry/contract.ts). Pure: everything here is built from data the loader (./load.ts) already fetched.
//
// Privacy: nothing in the response names the account. Entry ids are a truncated sha256 of the Schwab order id;
// Schwab order/activity ids, the account number, its hash and its last four digits never appear.
import { createHash } from "node:crypto";
import type { EodSnapshot } from "../eod";
import type { GaugeRow } from "../gauge";
import { uniqueEntries } from "../allocSim";
import { intrinsic } from "../options";
import type { OOTrade } from "../ooCsv";
import type { Fill } from "../realized";
import { buildLiveTrades, canonicalStrategy, mergeSplitOrders, OO_TIME_EXITS, profileMatch, STRATEGIES, type LiveTrade, type Profile, type Scorecard } from "../scorecard";
import type { Bar, Quote } from "../schwab/data";
import { classifySpread, type Position } from "../spreads";
import { bookEntryCandidates, inWindow, tradingDte, type RuleLeg } from "../strategyRules";
import { addDays, etMidnightUtc, etParts, isTradingDay, marketSession, todayET } from "../time";

// ---------- Response shape (mirrors spx-ai-agent lib/entry/contract.ts) ----------

export type MatchKind = "exact" | "ambiguous" | "none";

export interface ExportLeg {
  putCall: "P" | "C";
  strike: number;
  qty: number;
  expiration: string;
}

export interface ExportEntry {
  id: string;
  filledAt: string;
  detectedAt: string | null;
  bot: string | null;
  candidates: string[];
  match: MatchKind;
  matchConfidence: number;
  matchReason: string;
  /** How the bot was found: the structure rules, or (when they don't fit) the Live tab's backtest profiles. */
  matchSource: "rules" | "live_profile" | null;
  structure: string;
  underlying: string;
  legs: ExportLeg[];
  contracts: number;
  netPrice: number;
  rules: { stop: string | null; target: string | null };
}

export interface ExportBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface ExportQuote {
  last: number;
  quoteTime: string;
  prevClose: number | null;
}

export interface QuoteSnapshot {
  at: string;
  spx: number;
  vix: number | null;
  vix9d: number | null;
}

export interface BotBucket {
  trades: number;
  winRate: number;
  avgPl: number;
}

/** Per-bot facts that change slowly (built from the stored OO trades + the scorecard; cached by the loader). */
export interface BotRecord {
  backtest: { byEntryTime: (BotBucket & { time: string })[]; byVixBucket: (BotBucket & { bucket: string })[] };
  liveVsBacktest: { days: number; livePl: number; backtestPl: number; gap: number } | null;
  rules: { stop: string | null; target: string | null };
}

export interface AdvisorExport {
  asOf: string;
  schwab: { connected: boolean; fillsFetchedAt: string | null; errors: string[] };
  entries: ExportEntry[];
  outcomes: { entryId: string; bot: string | null; closedAt: string; pl: number; how: string }[];
  book: {
    today: { entryId: string; bot: string | null; filledAt: string; status: "open" | "closed" | "stopped" | "expired"; pl: number }[];
    todayTotal: number;
    stoppedOutBots: string[];
    daily: { date: string; pl: number }[];
    /** ≤ 0: today's running total against the high of the cumulative daily series (0 = at the high). */
    drawdownFromHigh: number;
    /** Entries still open now: legs, size and open P/L (marks), for the morning advisor. */
    open: { entryId: string; bot: string | null; filledAt: string; legs: ExportLeg[]; contracts: number; pl: number }[];
  };
  /** Schwab net liquidation value now and at each stored end of day (no account identifiers). Null when unknown. */
  account: { netLiq: number | null; startNetLiq: number | null; asOf: string; eod: { date: string; netLiq: number }[] } | null;
  bots: Record<string, BotRecord & { last10Days: { date: string; trades: { time: string; pl: number }[] }[] }>;
  market: {
    spx: ExportQuote;
    vix: ExportQuote;
    vix9d: ExportQuote | null;
    snapshots: QuoteSnapshot[];
    spxBars1m: ExportBar[];
    spxBars5m5d: ExportBar[];
    spxDaily60: ExportBar[];
    vixDaily15: ExportBar[];
    vix9dDaily15: ExportBar[];
    gauge: { today: { straddle: number | null; strike: number | null; capturedAt: string | null } | null; avgMoveRatio10d: number | null };
  };
}

// ---------- Input ----------

export interface AdvisorInput {
  now: number;
  /** Entries at or after this instant (ms) are exported. */
  since: number;
  connected: boolean;
  errors: string[];
  /** When the current (live) transactions window was last fetched from Schwab. */
  fillsFetchedAt: number | null;
  /** Normalized fills (trades + settlements) from `fillsFrom` (ET date) to now. */
  fills: Fill[];
  fillsFrom: string;
  /** Current Schwab positions, for marks. */
  positions: Position[];
  quotes: { spx: Quote | null; vix: Quote | null; vix9d: Quote | null; fetchedAt: number | null };
  snapshots: QuoteSnapshot[];
  bars: { spx1m: Bar[]; spx5m: Bar[]; spxDaily: Bar[]; vixDaily: Bar[]; vix9dDaily: Bar[] };
  gauge: GaugeRow[];
  eod: EodSnapshot[];
  bots: Record<string, BotRecord>;
  /** Export id → when oo-trading first saw the entry (ms). */
  seenAt: Record<string, number>;
  /** Backtest profiles per strategy (the Live tab's attribution), for entries the structure rules don't fit. */
  profiles?: Map<string, Profile>;
  /** Schwab balances (net liquidation value now and at the start of the day). */
  balances?: { netLiq: number | null; startNetLiq: number | null } | null;
}

/** Thrown when a required block (the SPX or VIX quote) can't be produced; the route answers 503. */
export class ExportUnavailable extends Error {}

export const BOOK_BOTS = [...STRATEGIES, "3 Delta"];
/** Outcomes are reported for entries filled this many days before `since` too (multi-day bots, overnight settlement posting). */
export const OUTCOME_LOOKBACK_DAYS = 7;
export const VIX_BUCKETS = ["<15", "15-20", "20-25", "25-30", "30+"] as const;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const iso = (ms: number) => new Date(ms).toISOString();
const hhmm = (ms: number) => {
  const p = etParts(ms);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

/** `?since=<ISO>`: entries at or after this instant; defaults to today's 00:00 ET. Null when unparsable. */
export function parseSince(raw: string | null, now: number): number | null {
  if (raw === null || raw === "") return etMidnightUtc(todayET(now)).getTime();
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** Stable, non-identifying entry id: sha256 of the Schwab order id, 24 hex characters. */
export function entryId(orderId: string): string {
  return createHash("sha256").update(`oo-trading:entry:${orderId}`).digest("hex").slice(0, 24);
}

export const vixBucket = (vix: number): (typeof VIX_BUCKETS)[number] => (vix < 15 ? "<15" : vix < 20 ? "15-20" : vix < 25 ? "20-25" : vix < 30 ? "25-30" : "30+");

/** "Iron condor" → "iron condor" (the Live page's structure names, lower-cased for the advisor). */
export function structureName(legs: Pick<ExportLeg, "putCall" | "strike" | "qty">[]): string {
  const s = classifySpread(legs);
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// ---------- Bot matching ----------

export interface BotMatch {
  bot: string | null;
  candidates: string[];
  match: MatchKind;
  matchConfidence: number;
  matchReason: string;
}

function describeEntry(legs: RuleLeg[], entryDate: string, minutes: number): string {
  const opts = legs.filter((l) => l.putCall && l.strike !== null && l.expiration);
  const parts = [structureName(opts as ExportLeg[])];
  const width = (pc: "P" | "C") => {
    const ks = [...new Set(opts.filter((l) => l.putCall === pc).map((l) => l.strike!))].sort((a, b) => a - b);
    return ks.length === 2 ? `${pc === "P" ? "puts" : "calls"} ${ks[1] - ks[0]} wide` : null;
  };
  for (const w of [width("P"), width("C")]) if (w) parts.push(w);
  const exps = [...new Set(opts.map((l) => l.expiration!))].sort();
  if (exps.length === 1) parts.push(`${tradingDte(entryDate, exps[0])}DTE`);
  parts.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} ET`);
  return parts.join(", ");
}

/**
 * Which book strategy an entry is, from `bookEntryCandidates` (structure, widths, DTE) and the entry-time windows.
 * One candidate → exact (1.0 inside its window, 0.8 outside). Several → exact at 0.6 when the entry time singles
 * one out, else ambiguous with the candidates listed. None → none.
 */
export function matchBot(legs: RuleLeg[], entryDate: string, minutes: number, candidates: string[] = bookEntryCandidates(legs, entryDate)): BotMatch {
  const desc = describeEntry(legs, entryDate, minutes);
  if (!candidates.length) return { bot: null, candidates: [], match: "none", matchConfidence: 0, matchReason: `${desc}: no book strategy has this structure` };
  if (candidates.length === 1) {
    const bot = candidates[0];
    const inWin = inWindow(bot, minutes);
    return {
      bot,
      candidates,
      match: "exact",
      matchConfidence: inWin ? 1 : 0.8,
      matchReason: `${desc}: ${bot}${inWin ? " in its entry window" : " but outside its entry window"}`,
    };
  }
  const inWin = candidates.filter((s) => inWindow(s, minutes));
  if (inWin.length === 1) {
    return {
      bot: inWin[0],
      candidates,
      match: "exact",
      matchConfidence: 0.6,
      matchReason: `${desc}: fits ${candidates.join(" or ")}; ${inWin[0]} picked by the entry time`,
    };
  }
  return {
    bot: null,
    candidates,
    match: "ambiguous",
    matchConfidence: r2(1 / candidates.length),
    matchReason: `${desc}: fits ${candidates.join(" or ")}; the entry time does not settle it`,
  };
}

/**
 * A Live-tab profile match as a BotMatch. Confidence starts at 0.9 and drops for an entry time away from the
 * strategy's usual ones, a credit outside its usual range, and a close runner-up; the advisor gives no opinion
 * below its threshold (0.6).
 */
export function profileBotMatch(pm: NonNullable<ReturnType<typeof profileMatch>>, rules: BotMatch): BotMatch {
  let c = 0.9;
  if (pm.minutesOff > 5) c -= 0.15;
  if (pm.minutesOff > 15) c -= 0.15;
  if (pm.creditOutside > 0) c -= Math.min(0.4, 0.4 * pm.creditOutside);
  if (pm.margin !== null && pm.margin < 2) c -= 0.2;
  const conf = r2(Math.max(0, c));
  const desc = rules.matchReason.replace(/:[^:]*$/, "");
  return {
    bot: pm.strategy,
    candidates: rules.candidates,
    match: "exact",
    matchConfidence: conf,
    matchReason: `${desc}: ${pm.strategy} by its live profile (Live tab): ${pm.minutesOff.toFixed(0)} min from its usual entry time, credit ${pm.creditOutside ? `${pm.creditOutside} range-widths outside` : "inside"} its usual ${pm.creditLo}–${pm.creditHi}${pm.margin !== null ? `, runner-up ${pm.margin} behind` : ""}`,
  };
}

// ---------- Per-bot records (stored OO trades + scorecard) ----------

function bucketStats(trades: OOTrade[]): BotBucket {
  const per = trades.map((t) => t.pl / Math.max(1, t.contracts || 1));
  return {
    trades: trades.length,
    winRate: trades.length ? r4(trades.filter((t) => t.pl > 0).length / trades.length) : 0,
    avgPl: per.length ? r2(per.reduce((a, b) => a + b, 0) / per.length) : 0,
  };
}

/** The bot's stop and target as configured, read from the OO strategy names (e.g. "SL300") and exit reasons. */
export function botRules(bot: string, trades: OOTrade[]): BotRecord["rules"] {
  const names = [...new Set(trades.map((t) => t.strategy))];
  const find = (re: RegExp) => names.map((n) => re.exec(n)).find((m) => m)?.[1];
  const sl = find(/\bSL\s*(\d+)/i);
  const pt = find(/\bPT\s*(\d+)/i);
  const expired = trades.filter((t) => /expir/i.test(t.reason)).length;
  const timeExit = OO_TIME_EXITS[bot];
  const stop = sl ? `${sl}% of credit (OO SL${sl})` : null;
  const target = pt
    ? `${pt}% of credit (OO PT${pt})`
    : timeExit !== undefined
      ? `time exit ${String(Math.floor(timeExit / 60)).padStart(2, "0")}:${String(timeExit % 60).padStart(2, "0")} ET, then expire`
      : trades.length && expired >= trades.length / 2
        ? "expire"
        : null;
  return { stop, target };
}

/**
 * Backtest stats by entry time and by opening-VIX bucket (per contract), plus live-vs-backtest from the scorecard,
 * for every book bot. `sc` is the inception-to-date scorecard (null when fills aren't available).
 */
export function buildBotRecords(ooTrades: OOTrade[], sc: Scorecard | null): Record<string, BotRecord> {
  const byBot = new Map<string, OOTrade[]>();
  for (const t of uniqueEntries(ooTrades)) {
    const bot = canonicalStrategy(t.strategy);
    byBot.set(bot, [...(byBot.get(bot) ?? []), t]);
  }
  const out: Record<string, BotRecord> = {};
  for (const bot of new Set([...BOOK_BOTS, ...byBot.keys()])) {
    if (!BOOK_BOTS.includes(bot)) continue;
    const trades = byBot.get(bot) ?? [];
    const byTime = new Map<string, OOTrade[]>();
    for (const t of trades) byTime.set(t.timeOpened.slice(0, 5), [...(byTime.get(t.timeOpened.slice(0, 5)) ?? []), t]);
    const byEntryTime = [...byTime]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([time, ts]) => ({ time, ...bucketStats(ts) }));
    const withVix = trades.filter((t) => typeof t.vix === "number" && Number.isFinite(t.vix));
    const byVixBucket = VIX_BUCKETS.map((bucket) => ({ bucket, ...bucketStats(withVix.filter((t) => vixBucket(t.vix!) === bucket)) }));
    let liveVsBacktest: BotRecord["liveVsBacktest"] = null;
    const agg = sc?.periods.inception.strategies.find((a) => a.name === bot);
    if (agg && agg.matchedClosed > 0) {
      const days = new Set(sc!.trades.filter((t) => t.strategy === bot && t.status === "matched" && t.live?.status === "closed").map((t) => t.date)).size;
      liveVsBacktest = { days, livePl: agg.livePl, backtestPl: agg.btPl, gap: r2(agg.livePl - agg.btPl) };
    }
    out[bot] = { backtest: { byEntryTime, byVixBucket }, liveVsBacktest, rules: botRules(bot, trades) };
  }
  return out;
}

// ---------- Entries, outcomes, book ----------

interface TradeView {
  trade: LiveTrade;
  id: string;
  filledAt: number;
  underlying: string;
  legs: ExportLeg[];
  match: BotMatch;
  matchSource: "rules" | "live_profile" | null;
  /** P/L so far ($, net of Schwab fees): closed legs at their exit, open legs at the mark or settlement. */
  pl: number;
  status: "open" | "closed" | "stopped" | "expired";
  /** Last close (order exit or expiration settlement time), once nothing is open. */
  closedAt: number | null;
  how: string | null;
}

const bell = (date: string) => etMidnightUtc(date).getTime() + 16 * 3600_000;

function buildTradeViews(input: AdvisorInput): TradeView[] {
  const { now, fills, positions } = input;
  const today = todayET(now);
  const p = etParts(now);
  const session = marketSession(now);
  const options = mergeSplitOrders(fills.filter((f) => f.assetType === "OPTION"));
  const openingByOrder = new Map<string, Fill[]>();
  for (const f of options) {
    if (f.effect === "CLOSING" || f.settlement) continue;
    openingByOrder.set(f.orderId, [...(openingByOrder.get(f.orderId) ?? []), f]);
  }
  const marks = new Map<string, number>();
  for (const pos of positions) if (pos.qty !== 0) marks.set(pos.symbol, pos.mark);
  const spxDailyClose = new Map(input.bars.spxDaily.map((b) => [new Date(b.time * 1000).toISOString().slice(0, 10), b.close]));
  const spxQuote = input.quotes.spx;
  // Settlement value of an SPX option that expired on `date`: today's close from the quote once the session has
  // closed (the 16:00 print), earlier days from the daily bars. Null when not known yet.
  const settleFor = (underlying: string, date: string): number | null => {
    if (underlying !== "SPX") return null;
    if (date === today) {
      const closed = session.tradingDay && p.minutesOfDay >= 16 * 60 + 1;
      return closed && spxQuote?.last != null && (spxQuote.time ?? 0) >= bell(today) - 60_000 ? spxQuote.last : null;
    }
    return date < today ? (spxDailyClose.get(date) ?? null) : null;
  };

  const views: TradeView[] = [];
  for (const trade of buildLiveTrades(fills, input.fillsFrom)) {
    const opens = openingByOrder.get(trade.orderId) ?? [];
    if (!opens.length) continue;
    const filledAt = Math.max(...opens.map((f) => f.time));
    const underlying = opens[0].underlying;
    const legs: ExportLeg[] = trade.legs.map((l) => ({ putCall: l.putCall, strike: l.strike, qty: l.qty, expiration: l.expiration }));
    const symbolOf = (l: ExportLeg) => opens.find((f) => f.putCall === l.putCall && f.strike === l.strike && f.expiration === l.expiration)?.symbol ?? "";

    // P/L so far = entry cash + exit cash + value of what is still open − fees.
    const entryCash = trade.legs.reduce((s, l) => s - l.qty * l.price * 100, 0);
    const exitCash = trade.exits.reduce((s, x) => s + x.openSign * x.price * x.qty * 100, 0);
    let openValue = 0;
    let unknown = 0;
    let marked = 0;
    let settledPending = 0;
    let lastSettle = 0;
    for (const l of trade.legs) {
      const sym = symbolOf(l);
      const closed = trade.exits.filter((x) => x.symbol === sym).reduce((s, x) => s + x.qty, 0);
      const remaining = l.qty - Math.sign(l.qty) * closed;
      if (!remaining) continue;
      const mark = marks.get(sym);
      const expired = l.expiration < today || (l.expiration === today && settleFor(underlying, today) !== null);
      if (mark !== undefined && !expired) {
        openValue += remaining * mark * 100;
        marked += Math.abs(remaining);
      } else if (expired && settleFor(underlying, l.expiration) !== null) {
        openValue += remaining * intrinsic(l.putCall, l.strike, settleFor(underlying, l.expiration)!) * 100;
        settledPending += Math.abs(remaining);
        lastSettle = Math.max(lastSettle, bell(l.expiration));
      } else {
        unknown += Math.abs(remaining);
        openValue += remaining * l.price * 100; // no mark: carried at cost
      }
    }
    const pl = r2(entryCash + exitCash + openValue - trade.fees);
    const orderExits = trade.exits.filter((x) => x.via === "order");
    const lastOrderExit = orderExits.length ? Math.max(...orderExits.map((x) => x.time)) : null;
    const settlementExits = trade.exits.filter((x) => x.via === "settlement");
    const lastPosted = settlementExits.length ? Math.max(...settlementExits.map((x) => bell(expirationOf(x.symbol) ?? todayET(x.time)))) : null;

    let status: TradeView["status"];
    let closedAt: number | null = null;
    let how: string | null = null;
    // Done once every leg is closed by an order, posted, or expired at a known settlement (nothing left at a mark).
    const done = trade.status === "closed" || (unknown === 0 && marked === 0 && settledPending > 0);
    if (done) {
      closedAt = Math.max(lastOrderExit ?? 0, lastPosted ?? 0, lastSettle);
      if (!orderExits.length) {
        status = "expired";
        how = "expired";
      } else if (pl < 0) {
        status = "stopped";
        how = "stop";
      } else {
        status = "closed";
        how = "closed";
      }
    } else status = "open";

    const minutes = etParts(filledAt).minutesOfDay;
    let match = matchBot(legs, trade.date, minutes);
    let matchSource: TradeView["matchSource"] = match.bot ? "rules" : null;
    if (match.match !== "exact" && input.profiles) {
      const pm = profileMatch(trade, input.profiles);
      if (pm) {
        match = { ...profileBotMatch(pm, match), candidates: match.candidates.length ? match.candidates : [pm.strategy] };
        matchSource = "live_profile";
      }
    }
    if (match.bot === "$8 IC" && trade.units === 1) match.matchReason += " (1 lot: possibly the Dip add-on)";
    if (how === "closed" && match.bot && OO_TIME_EXITS[match.bot] !== undefined && lastOrderExit !== null) {
      const m = etParts(lastOrderExit).minutesOfDay;
      if (Math.abs(m - OO_TIME_EXITS[match.bot]) <= 3) how = "time";
    }
    views.push({ trade, id: entryId(trade.orderId), filledAt, underlying, legs, match, matchSource, pl, status, closedAt, how });
  }
  return views.sort((a, b) => a.filledAt - b.filledAt);
}

/** Expiration (YYYY-MM-DD) from an OCC option symbol, e.g. "SPXW  261112P07700000". */
function expirationOf(symbol: string): string | null {
  const m = /^\S+\s+(\d{2})(\d{2})(\d{2})[PC]\d{8}$/.exec(symbol);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

/** The last `n` trading days ending at `end` (inclusive), ascending. */
export function lastTradingDays(end: string, n: number): string[] {
  const out: string[] = [];
  for (let d = end; out.length < n; d = addDays(d, -1)) if (isTradingDay(d)) out.unshift(d);
  return out;
}

const toBar = (b: Bar): ExportBar => ({ t: iso(b.time * 1000), o: b.open, h: b.high, l: b.low, c: b.close });

function toQuote(q: Quote | null, fetchedAt: number | null): ExportQuote | null {
  if (!q || q.last === null) return null;
  const t = q.time ?? fetchedAt;
  return t === null ? null : { last: q.last, quoteTime: iso(t), prevClose: q.prevClose };
}

export function buildAdvisorExport(input: AdvisorInput): AdvisorExport {
  const { now } = input;
  const today = todayET(now);
  const spx = toQuote(input.quotes.spx, input.quotes.fetchedAt);
  const vix = toQuote(input.quotes.vix, input.quotes.fetchedAt);
  if (!input.connected) throw new ExportUnavailable(input.errors[0] ?? "Schwab is not connected");
  if (!spx || !vix) throw new ExportUnavailable(input.errors[0] ?? "No SPX/VIX quote");

  const views = buildTradeViews(input);
  const rulesFor = (bot: string | null): ExportEntry["rules"] => (bot ? input.bots[bot]?.rules : undefined) ?? { stop: null, target: null };

  const entries: ExportEntry[] = views
    .filter((v) => v.filledAt >= input.since)
    .map((v) => ({
      id: v.id,
      filledAt: iso(v.filledAt),
      detectedAt: input.seenAt[v.id] ? iso(input.seenAt[v.id]) : null,
      bot: v.match.bot,
      candidates: v.match.candidates,
      match: v.match.match,
      matchConfidence: v.match.matchConfidence,
      matchReason: v.match.matchReason,
      matchSource: v.matchSource,
      structure: structureName(v.legs),
      underlying: v.underlying,
      legs: v.legs,
      contracts: v.trade.units,
      netPrice: v.trade.credit,
      rules: rulesFor(v.match.bot),
    }));

  const outcomeFrom = input.since - OUTCOME_LOOKBACK_DAYS * 86_400_000;
  const outcomes = views
    .filter((v) => v.closedAt !== null && v.filledAt >= outcomeFrom)
    .map((v) => ({ entryId: v.id, bot: v.match.bot, closedAt: iso(v.closedAt!), pl: v.pl, how: v.how ?? "closed" }));

  const todays = views.filter((v) => v.trade.date === today);
  const bookToday = todays.map((v) => ({ entryId: v.id, bot: v.match.bot, filledAt: iso(v.filledAt), status: v.status, pl: v.pl }));
  const todayTotal = r2(todays.reduce((s, v) => s + v.pl, 0));
  const stoppedOutBots = [...new Set(todays.filter((v) => v.status === "stopped" && v.match.bot).map((v) => v.match.bot!))];

  // Daily book P/L for the last 15 trading days before today: the EOD snapshot's day P/L, else what closed that day.
  const eodByDate = new Map(input.eod.map((s) => [s.date, s]));
  const closedOn = (date: string) => views.filter((v) => v.closedAt !== null && todayET(v.closedAt) === date).reduce((s, v) => s + v.pl, 0);
  const daily = lastTradingDays(addDays(today, -1), 15).map((date) => ({ date, pl: r2(eodByDate.get(date)?.dayPl ?? closedOn(date)) }));
  let cum = 0;
  let high = 0;
  for (const d of daily) {
    cum += d.pl;
    high = Math.max(high, cum);
  }
  cum += todayTotal;
  high = Math.max(high, cum);
  const drawdownFromHigh = r2(cum - high);
  const openNow = views
    .filter((v) => v.status === "open")
    .map((v) => ({ entryId: v.id, bot: v.match.bot, filledAt: iso(v.filledAt), legs: v.legs, contracts: v.trade.units, pl: v.pl }));
  const account = input.balances
    ? {
        netLiq: input.balances.netLiq,
        startNetLiq: input.balances.startNetLiq,
        asOf: iso(now),
        eod: input.eod.filter((s) => s.netLiq !== null).map((s) => ({ date: s.date, netLiq: s.netLiq! })).sort((a, b) => a.date.localeCompare(b.date)),
      }
    : null;

  const days10 = lastTradingDays(today, 10);
  const bots: AdvisorExport["bots"] = {};
  for (const bot of new Set([...BOOK_BOTS, ...views.map((v) => v.match.bot).filter((b): b is string => !!b)])) {
    const rec = input.bots[bot] ?? { backtest: { byEntryTime: [], byVixBucket: VIX_BUCKETS.map((bucket) => ({ bucket, trades: 0, winRate: 0, avgPl: 0 })) }, liveVsBacktest: null, rules: { stop: null, target: null } };
    bots[bot] = {
      ...rec,
      last10Days: days10.map((date) => ({
        date,
        trades: views.filter((v) => v.match.bot === bot && v.trade.date === date && v.closedAt !== null).map((v) => ({ time: hhmm(v.filledAt), pl: v.pl })),
      })),
    };
  }

  const gaugeToday = input.gauge.find((r) => r.date === today);
  const closedGauge = input.gauge.filter((r) => r.status === "closed" && r.ratio !== null && r.date < today).sort((a, b) => a.date.localeCompare(b.date)).slice(-10);

  return {
    asOf: iso(now),
    schwab: { connected: input.connected, fillsFetchedAt: input.fillsFetchedAt === null ? null : iso(input.fillsFetchedAt), errors: input.errors },
    entries,
    outcomes,
    book: { today: bookToday, todayTotal, stoppedOutBots, daily, drawdownFromHigh, open: openNow },
    account,
    bots,
    market: {
      spx,
      vix,
      vix9d: toQuote(input.quotes.vix9d, input.quotes.fetchedAt),
      snapshots: [...input.snapshots].sort((a, b) => a.at.localeCompare(b.at)),
      spxBars1m: input.bars.spx1m.map(toBar),
      spxBars5m5d: input.bars.spx5m.map(toBar),
      spxDaily60: input.bars.spxDaily.slice(-60).map(toBar),
      vixDaily15: input.bars.vixDaily.slice(-15).map(toBar),
      vix9dDaily15: input.bars.vix9dDaily.slice(-15).map(toBar),
      gauge: {
        today:
          gaugeToday && (gaugeToday.status === "open" || gaugeToday.status === "closed")
            ? { straddle: gaugeToday.straddle, strike: gaugeToday.K, capturedAt: iso(gaugeToday.captured_at) }
            : { straddle: null, strike: null, capturedAt: null },
        avgMoveRatio10d: closedGauge.length ? r4(closedGauge.reduce((s, r) => s + r.ratio!, 0) / closedGauge.length) : null,
      },
    },
  };
}
