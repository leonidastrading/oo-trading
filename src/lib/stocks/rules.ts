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
  /** "stop" = enter only when the price trades through `limitPrice` (above it for a long, below for a short). */
  entryType: "market" | "limit" | "stop";
  /** The limit price, or the trigger price of a stop entry. */
  limitPrice?: number | null;
  stop: number;
  target?: number | null;
  thesis: string;
  /** What proves it wrong: the thesis kill criteria (separate from the stop). */
  invalidation?: string;
  /** Optional time frame in days; without it the trade has no time exit. */
  days?: number | null;
  source: Source;
  /** Optional sector ETF to score against, in addition to SPY (e.g. XBI, SMH, XLE). */
  benchmark?: string | null;
  /** Stage of the story at entry (0 Stealth … 4 Unwind). */
  stage?: Stage;
  /** Stage 3 long: ticked "I understand" on the late-stage warning. */
  lateStageAck?: boolean;
  /** Variant perception. */
  marketBelieves?: string;
  iBelieve?: string;
  /** Optional free-form notes. */
  ideaNotes?: string | null;
  becauseData?: string;
  /** What forces the market to see it, and when (date or window). */
  catalyst?: string;
  catalystDate?: string;
  /** Optional: what the price implies, e.g. "priced for 10% growth". */
  priceImplies?: string | null;
  /** Optional: crowding at entry (manual low / normal / high; Stocktwits figures when available). */
  crowding?: Crowding | null;
  /** One planned add: the starter is 1/3 of full shadow size, the add the other 2/3. */
  planAdd?: boolean;
  addTrigger?: string | null;
}

export const STAGES = [
  { value: 0, label: "0 Stealth", hint: "fundamentals turning, few notice" },
  { value: 1, label: "1 Recognition", hint: "first hard-number surprise or guidance raise" },
  { value: 2, label: "2 Institutional", hint: "revisions cascading, funds buying" },
  { value: 3, label: "3 Mania", hint: "social and media hype, price outrunning fundamentals" },
  { value: 4, label: "4 Unwind", hint: "crowd exhausted, story cracking" },
] as const;
export type Stage = 0 | 1 | 2 | 3 | 4;
export const CROWDING_LEVELS = ["low", "normal", "high"] as const;
export interface Crowding {
  level: (typeof CROWDING_LEVELS)[number];
  source: "manual" | "stocktwits";
  /** Stocktwits: message volume vs its 90-day average (× and σ) and sentiment, when available. */
  volumeMultiple?: number | null;
  volumeSigma?: number | null;
  sentiment?: string | null;
}

/** The planned add, once triggered. */
export interface AddLeg {
  status: "pending" | "filled" | "cancelled";
  note: string;
  requestedAt: number;
  priceAtSubmit: number;
  liveShares: number;
  shadowShares: number;
  stopAtAdd: number;
  orderId?: string | null;
  stopOrderId?: string | null;
  targetOrderId?: string | null;
  price?: number | null;
  time?: number | null;
}

export interface PostMortem {
  thesisRight: "yes" | "no" | "partly";
  catalystHappened: "yes" | "no" | "not yet";
  rightReason: "yes" | "no" | "luck";
  learned: string;
  at: number;
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
  /** Risk % of the account the shadow size was built on (settings.riskPct at submit). */
  shadowRiskPct: number;
  shadowShares: number;
  /** Shadow position $ (shares × entry), its $ risk to the stop, and whether the max-position cap cut the size. */
  shadowPosition?: number;
  shadowRisk?: number;
  shadowCapped?: boolean;
  exitBy: string; // YYYY-MM-DD (ET): closed at market on this day ("" = no time exit)
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
  /** Entry order session: NORMAL (regular hours) or SEAMLESS (extended-hours limit). */
  session?: "NORMAL" | "SEAMLESS";
  /** How many times an expired/cancelled order of this trade was put back by the sync. */
  reentries?: number;
  /** SPY (and benchmark ETF) prices at the entry and exit fills, for market-relative scoring. */
  spyEntry?: number | null;
  spyExit?: number | null;
  benchEntry?: number | null;
  benchExit?: number | null;
  /** Excess return in % (vs SPY / vs the benchmark) and in R (÷ initial stop distance %). */
  excess?: number | null;
  excessR?: number | null;
  benchExcess?: number | null;
  benchExcessR?: number | null;
  stopHistory: { at: number; stop: number }[];
  targetHistory: { at: number; target: number | null }[];
  notes: string[];
  /** Full risk-based shadow size; with a planned add the starter holds 1/3 of it (shadowShares) and the add 2/3. */
  fullShadowShares?: number;
  /** Total planned $ risk (full shadow size × initial stop distance): the R denominator. */
  plannedRisk?: number | null;
  add?: AddLeg | null;
  postMortem?: PostMortem | null;
  /** The Trend Scout card this idea came from. */
  cardId?: string;
  cardUrl?: string | null;
  /** Placed outside the app (e.g. in the Schwab app while the API was down) and adopted afterwards. */
  adopted?: boolean;
  /** Guardrails it broke (only possible for adopted trades); any override stops the size-up banner. */
  overrides?: string[];
}

export interface StockSettings {
  dryRun: boolean;
  /** Live shares per order (fixed; the shadow size is computed). */
  shares: number;
  maxOpen: number;
  maxPerWeek: number;
  /** Weekly realized shadow loss, % of the account, that locks new entries until Monday. */
  weeklyLossPct: number;
  /** Shadow (full) size: % of the account risked to the stop… */
  riskPct: number;
  /** …capped at this % of the account per position. */
  maxPositionPct: number;
  /** Shadow exposure limits, % of the account: gross (long + short) and net (|long − short|). */
  maxGrossPct: number;
  maxNetPct: number;
}

// Open ideas / ideas per week stay at 20 (asked for on Nov 21); the rest are the spec's defaults.
export const DEFAULT_SETTINGS: StockSettings = {
  dryRun: true,
  shares: 1,
  maxOpen: 20,
  maxPerWeek: 20,
  weeklyLossPct: 3,
  riskPct: 1,
  maxPositionPct: 15,
  maxGrossPct: 75,
  maxNetPct: 50,
};

/** Limits where a higher number is looser: raising them waits 24 hours; lowering them applies at once. */
export const LOOSEN_UP: (keyof StockSettings)[] = ["shares", "maxOpen", "maxPerWeek", "weeklyLossPct", "riskPct", "maxPositionPct", "maxGrossPct", "maxNetPct"];
export const LOOSEN_DELAY_MS = 24 * 3600_000;

export interface StoredSettings {
  values: StockSettings;
  pending: { key: keyof StockSettings; value: number | boolean; effectiveAt: number; requestedAt: number }[];
}

export function effectiveSettings(s: StoredSettings | null, now = Date.now()): StockSettings {
  const known = Object.fromEntries(Object.entries(s?.values ?? {}).filter(([k]) => k in DEFAULT_SETTINGS));
  const values = { ...DEFAULT_SETTINGS, ...known } as StockSettings;
  for (const p of s?.pending ?? []) if (p.effectiveAt <= now && p.key in DEFAULT_SETTINGS) (values as unknown as Record<string, unknown>)[p.key] = p.value;
  return values;
}

/** Fold pending changes whose time has come into the values (housekeeping before a write). */
export function settle(s: StoredSettings | null, now = Date.now()): StoredSettings {
  return { values: effectiveSettings(s, now), pending: (s?.pending ?? []).filter((p) => p.effectiveAt > now) };
}

const LIMITS: Record<keyof StockSettings, [number, number] | null> = {
  dryRun: null,
  shares: [1, 1000],
  maxOpen: [0, 100],
  maxPerWeek: [0, 100],
  weeklyLossPct: [0.1, 50],
  riskPct: [0.05, 5],
  maxPositionPct: [1, 100],
  maxGrossPct: [1, 400],
  maxNetPct: [1, 400],
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

/**
 * When an entry can go in, and how: any time. During the regular session (9:30–16:00 ET on a trading day)
 * market or limit; outside it (pre-market, after hours, overnight, weekends, holidays) limit only, sent as an
 * extended-hours ("SEAMLESS") order that works from 7:00 to 20:00 ET on the next session if it isn't one now.
 */
export function entrySession(entryType: IdeaInput["entryType"], now = Date.now()): { ok: boolean; session: "NORMAL" | "SEAMLESS"; why: string } {
  if (regularSession(now)) return { ok: true, session: "NORMAL", why: "Regular session" };
  // A stop entry only triggers in the regular session: placed outside it, it waits for the next one.
  if (entryType === "stop") return { ok: true, session: "NORMAL", why: "Stop entry: triggers in the next regular session (9:30–16:00 ET)" };
  if (entryType === "market") return { ok: false, session: "SEAMLESS", why: "Outside the regular session (9:30–16:00 ET) entries must be limit or stop orders" };
  return { ok: true, session: "SEAMLESS", why: "Extended hours: limit order, working 7:00–20:00 ET" };
}

/** Schwab's extended-hours window on a trading day, 7:00–20:00 ET (includes the regular session). */
export function extendedSession(now = Date.now()): boolean {
  const p = etParts(now);
  return isTradingDay(p.date) && p.minutesOfDay >= 7 * 60 && p.minutesOfDay < 20 * 60;
}

/** Regular session (exits at market go in then). */
export function regularSession(now = Date.now()): boolean {
  const p = etParts(now);
  return isTradingDay(p.date) && p.minutesOfDay >= 9 * 60 + 30 && p.minutesOfDay < 16 * 60;
}

/** Time exit is due from 15:30 ET on the exit-by day (or any session after it). */
export function timeExitDue(t: Pick<Trade, "exitBy">, now = Date.now()): boolean {
  if (!t.exitBy) return false;
  const p = etParts(now);
  return regularSession(now) && (p.date > t.exitBy || (p.date === t.exitBy && p.minutesOfDay >= 15 * 60 + 30));
}

// ---- Validation and guardrails ----

const round2 = (v: number) => Math.round(v * 100) / 100;
/** Order prices: cents, or 4 decimals under $1 (sub-dollar stocks trade in finer ticks). */
export const roundPx = (v: number) => (v < 1 ? Math.round(v * 10000) / 10000 : round2(v));
/** Default stop suggestion: 20% from the entry reference, on the losing side. */
export const SUGGESTED_STOP_PCT = 20;
export const suggestedStop = (ref: number, long: boolean) => roundPx(ref * (long ? 1 - SUGGESTED_STOP_PCT / 100 : 1 + SUGGESTED_STOP_PCT / 100));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : NaN);

/** Parse and check the form: every field required (target optional). */
export function parseIdea(raw: Record<string, unknown>): { idea: IdeaInput | null; errors: string[] } {
  const errors: string[] = [];
  const ticker = String(raw.ticker ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-/]{0,9}$/.test(ticker)) errors.push("Ticker is required (letters, e.g. AAPL or BRK/B)");
  const direction = raw.direction === "long" || raw.direction === "short" ? raw.direction : null;
  if (!direction) errors.push("Direction is required (long or short)");
  const entryType = raw.entryType === "market" || raw.entryType === "limit" || raw.entryType === "stop" ? raw.entryType : null;
  if (!entryType) errors.push("Entry type is required (market, limit or stop)");
  const limitPrice = num(raw.limitPrice);
  if (entryType === "limit" && !(limitPrice > 0)) errors.push("Limit price is required for a limit entry");
  if (entryType === "stop" && !(limitPrice > 0)) errors.push("Entry price is required for a stop entry");
  const stop = num(raw.stop);
  if (!(stop > 0)) errors.push("Stop price is required");
  const targetRaw = raw.target === null || raw.target === undefined || raw.target === "" ? null : num(raw.target);
  if (targetRaw !== null && !(targetRaw > 0)) errors.push("Target must be a price (or left empty)");
  const thesis = String(raw.thesis ?? "").trim();
  if (thesis.length < 10) errors.push("Thesis is required (1–3 sentences)");
  if (thesis.length > 600) errors.push("Thesis is too long (keep it to 1–3 sentences)");
  const invalidation = String(raw.invalidation ?? "").trim();
  if (invalidation.length > 400) errors.push("Invalidation is too long");
  const daysGiven = raw.days !== undefined && raw.days !== null && raw.days !== "";
  const days = daysGiven ? num(raw.days) : null;
  if (days !== null && !(days >= 1 && days <= 365 && Number.isInteger(days))) errors.push("Time frame must be whole days, 1–365 (or left out)");
  const source = SOURCES.includes(raw.source as Source) ? (raw.source as Source) : null;
  const benchRaw = String(raw.benchmark ?? "").trim().toUpperCase();
  if (benchRaw && !/^[A-Z][A-Z0-9.\-/]{0,9}$/.test(benchRaw)) errors.push("Benchmark ETF must be a ticker (e.g. XBI) or left empty");
  if (!source) errors.push("Source is required");
  if ("shares" in raw || "quantity" in raw || "size" in raw) errors.push("Size can't be set here (fixed in Settings)");
  const txt = (k: string, label: string, min: number, max: number, required = true) => {
    const v = String(raw[k] ?? "").trim();
    if (required && v.length < min) errors.push(`${label} is required`);
    if (v.length > max) errors.push(`${label} is too long`);
    return v;
  };
  if (invalidation.length < 5) errors.push("What proves it wrong is required (the thesis kill criteria, separate from the stop)");
  const stageNum = num(raw.stage);
  const stage = [0, 1, 2, 3, 4].includes(stageNum) ? (stageNum as Stage) : null;
  if (stage === null) errors.push("Stage is required (0–4)");
  const lateStageAck = raw.lateStageAck === true;
  if (stage === 3 && direction === "long" && !lateStageAck) errors.push('Late stage: crowd is in — tick "I understand" to go long at stage 3');
  // No longer on the form (kept optional so old trades and callers still parse).
  const marketBelieves = txt("marketBelieves", '"Market believes…"', 0, 300, false);
  const iBelieve = txt("iBelieve", '"I believe…"', 0, 300, false);
  const ideaNotes = txt("ideaNotes", "Notes", 0, 1000, false);
  const becauseData = txt("becauseData", '"Because of this data…"', 5, 300);
  const catalyst = txt("catalyst", "Catalyst", 5, 300);
  const catalystDate = txt("catalystDate", "Catalyst date or window", 0, 80, false);
  const priceImplies = txt("priceImplies", "What the price implies", 0, 300, false);
  let crowding: Crowding | null = null;
  const cr = raw.crowding as Record<string, unknown> | string | null | undefined;
  const level = typeof cr === "string" ? cr : (cr as Record<string, unknown> | null)?.level;
  if (level !== undefined && level !== null && level !== "") {
    if (!CROWDING_LEVELS.includes(level as Crowding["level"])) errors.push("Crowding must be low, normal or high");
    else crowding = { level: level as Crowding["level"], source: "manual" };
  }
  const planAdd = raw.planAdd === true;
  const addTrigger = planAdd ? txt("addTrigger", "Add trigger", 5, 200) : null;
  if (errors.length) return { idea: null, errors };
  return {
    idea: {
      ticker,
      direction: direction!,
      entryType: entryType!,
      limitPrice: entryType !== "market" ? roundPx(limitPrice) : null,
      stop: roundPx(stop),
      target: targetRaw === null ? null : roundPx(targetRaw),
      thesis,
      invalidation,
      days,
      source: source!,
      benchmark: benchRaw || null,
      stage: stage!,
      lateStageAck,
      marketBelieves,
      iBelieve,
      ideaNotes: ideaNotes || null,
      becauseData,
      catalyst,
      catalystDate,
      priceImplies: priceImplies || null,
      crowding,
      planAdd,
      addTrigger,
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
  const win = entrySession(idea.entryType, now);
  add("Session", win.ok, win.why);

  const last = quote?.last ?? null;
  add("Quote", last !== null && last > 0, last ? `${idea.ticker} last ${last}` : `No current quote for ${idea.ticker}`);
  if (last !== null && last > 0) {
    // Reference price for the risk: the limit for a limit entry (that's where it fills), else the last price.
    const ref = idea.entryType !== "market" && idea.limitPrice ? idea.limitPrice : last;
    const sideOk = idea.direction === "long" ? idea.stop < last && idea.stop < ref : idea.stop > last && idea.stop > ref;
    add(
      "Stop side",
      sideOk,
      sideOk
        ? `Stop ${idea.stop} is ${idea.direction === "long" ? "below" : "above"} the price`
        : `A ${idea.direction} stop must be ${idea.direction === "long" ? "below" : "above"} the current price (${last}) and the entry`,
    );
    const riskPct = (Math.abs(ref - idea.stop) / ref) * 100;
    // Any stop distance is allowed: the shadow size shrinks or grows to keep the risk at the set %.
    add("Risk to stop", true, `${riskPct.toFixed(2)}% of the entry price`);
    if (idea.entryType !== "market" && idea.limitPrice) {
      const lOk = idea.direction === "long" ? idea.limitPrice > idea.stop : idea.limitPrice < idea.stop;
      add("Limit vs stop", lOk, lOk ? "Entry price is on the right side of the stop" : "The entry price is past the stop");
    }
    if (idea.entryType === "stop" && idea.limitPrice) {
      const long = idea.direction === "long";
      const eOk = long ? idea.limitPrice > last : idea.limitPrice < last;
      add("Stop entry side", eOk, eOk ? `Enters if the price trades ${long ? "up" : "down"} through ${idea.limitPrice}` : `A ${idea.direction} stop entry must be ${long ? "above" : "below"} the current price ${last} (use Market to enter now)`);
    }
    if (idea.target) {
      const tOk = idea.direction === "long" ? idea.target > ref : idea.target < ref;
      add("Target side", tOk, tOk ? `Target ${idea.target}` : `A ${idea.direction} target must be ${idea.direction === "long" ? "above" : "below"} the entry`);
    }
  }
  if (idea.direction === "short") {
    // Only a flat "not shortable" blocks. Hard-to-borrow (or unknown) is allowed with a warning: Schwab
    // decides when the order arrives, and may charge a borrow fee.
    const ok = quote?.shortable !== false;
    add(
      "Shortable",
      ok,
      !ok
        ? "Schwab says it isn't shortable"
        : quote?.hardToBorrow
          ? "Warning: Schwab lists it as hard-to-borrow — allowed, but Schwab may reject the order or charge a borrow fee"
          : quote?.shortable === true
            ? "Schwab: shortable, not hard-to-borrow"
            : "Warning: couldn't confirm it's shortable — Schwab may reject the order",
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

  if (last !== null && last > 0 && c.accountValue) {
    const ref = idea.entryType !== "market" && idea.limitPrice ? idea.limitPrice : last;
    const size = shadowSize(c.accountValue, settings, ref, idea.stop);
    const ex = shadowExposure(c.trades, mode);
    // With a planned add only the 1/3 starter goes on now; the add is checked when it's triggered.
    const starter = starterShares(size.shares, idea.planAdd);
    const add$ = Math.round(starter * ref * 100) / 100;
    const gross = ex.gross + add$;
    const net = ex.net + (idea.direction === "long" ? add$ : -add$);
    const pctOf = (v: number) => (v / c.accountValue!) * 100;
    add(
      "Shadow size",
      starter > 0,
      starter > 0
        ? `${size.shares} sh full · ${size.positionPct}% position · ${size.riskPct}% risk${size.capped ? " (capped by max position)" : ""}${idea.planAdd ? ` · starter ${starter} sh now, add ${size.shares - starter} later` : ""}`
        : "Size works out to 0 shares",
    );
    add("Gross exposure", pctOf(gross) <= settings.maxGrossPct, `${pctOf(gross).toFixed(1)}% with this idea (max ${settings.maxGrossPct}%)`);
    add("Net exposure", Math.abs(pctOf(net)) <= settings.maxNetPct, `${pctOf(net) >= 0 ? "+" : ""}${pctOf(net).toFixed(1)}% with this idea (max ±${settings.maxNetPct}%)`);
  } else if (!c.accountValue) add("Exposure", false, "Account value unknown: can't size or check exposure");
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
  const overdue = overduePostMortems(c.trades, mode, now);
  add(
    "Post-mortems",
    overdue.length <= 2,
    overdue.length <= 2 ? `${overdue.length} overdue` : `${overdue.length} closed trades have no post-mortem after 3 trading days (${overdue.map((t) => t.ticker).join(", ")}): fill them in first`,
  );
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

/**
 * Market-relative return over entry → `price`: long = stock % − benchmark %; short = benchmark % − stock %
 * (the short is compared with shorting the benchmark). In R: ÷ the initial stop distance in %.
 */
export function excessReturn(
  t: Pick<Trade, "direction" | "entryPrice" | "priceAtSubmit" | "initialStop">,
  price: number,
  benchEntry: number | null | undefined,
  benchNow: number | null | undefined,
): { pct: number; r: number | null } | null {
  const entry = t.entryPrice ?? t.priceAtSubmit;
  if (!(entry > 0) || !(price > 0) || !benchEntry || !benchNow) return null;
  const stock = ((price - entry) / entry) * 100;
  const bench = ((benchNow - benchEntry) / benchEntry) * 100;
  const pct = t.direction === "long" ? stock - bench : bench - stock;
  const stopPct = (Math.abs(entry - t.initialStop) / entry) * 100;
  return { pct: Math.round(pct * 100) / 100, r: stopPct > 0 ? Math.round((pct / stopPct) * 100) / 100 : null };
}

export function closeOut(t: Trade, exitPrice: number, exitTime: number, reason: ExitReason, marks: { spy?: number | null; bench?: number | null } = {}): Trade {
  const spyX = excessReturn(t, exitPrice, t.spyEntry, marks.spy);
  const benchX = t.benchmark ? excessReturn(t, exitPrice, t.benchEntry, marks.bench) : null;
  return {
    ...closeOutRaw(t, exitPrice, exitTime, reason),
    spyExit: marks.spy ?? null,
    benchExit: t.benchmark ? (marks.bench ?? null) : null,
    excess: spyX?.pct ?? null,
    excessR: spyX?.r ?? null,
    benchExcess: benchX?.pct ?? null,
    benchExcessR: benchX?.r ?? null,
  };
}

function closeOutRaw(t: Trade, exitPrice: number, exitTime: number, reason: ExitReason): Trade {
  const entry = t.entryPrice ?? t.priceAtSubmit;
  const dir = t.direction === "long" ? 1 : -1;
  // Legs: the starter, plus the planned add once it has filled. Both exit at the same price.
  const legs = [{ price: entry, live: t.shares, shadow: t.shadowShares }];
  if (t.add?.status === "filled" && t.add.price) legs.push({ price: t.add.price, live: t.add.liveShares, shadow: t.add.shadowShares });
  const pl = legs.reduce((s, l) => s + (exitPrice - l.price) * dir * l.live, 0);
  const cost = legs.reduce((s, l) => s + l.price * l.live, 0);
  const shadowPl = legs.reduce((s, l) => s + (exitPrice - l.price) * dir * l.shadow, 0);
  const perShare = (exitPrice - entry) * dir;
  const risk = Math.abs(entry - t.initialStop) || t.riskPerShare;
  // R on the total planned risk (full shadow size × initial stop distance); older trades: per share.
  const r = t.plannedRisk && t.plannedRisk > 0 ? shadowPl / t.plannedRisk : risk > 0 ? perShare / risk : null;
  return {
    ...t,
    status: "closed",
    exitPrice: round2(exitPrice),
    exitTime,
    exitReason: reason,
    pl: round2(pl),
    plPct: cost > 0 ? Math.round((pl / cost) * 10000) / 100 : null,
    r: r === null ? null : Math.round(r * 100) / 100,
    shadowPl: round2(shadowPl),
  };
}

/** Starter/add split of the full shadow size: the starter is 1/3 with a planned add, else all of it. */
export function starterShares(full: number, planAdd: boolean | undefined): number {
  return planAdd ? Math.floor(full / 3) : full;
}

export interface AddCheck {
  checks: Check[];
  ok: boolean;
  /** Shadow shares the add gets (2/3 of full, capped by the max position), and the stop the 1% budget needs. */
  addShadowShares: number;
  requiredStop: number | null;
}

/**
 * The planned add: once per trade, only while the position is in profit (never averaging down), only after
 * the stop is moved so the whole position (starter + add) risks no more than the idea's risk budget, and
 * within the max position and the exposure caps. It doesn't count as a new idea.
 */
export function checkAdd(c: {
  trade: Trade;
  last: number | null;
  newStop: number;
  note: string;
  settings: StockSettings;
  trades: Trade[];
  killSwitch: boolean;
  now: number;
}): AddCheck {
  const { trade: t, last, newStop, settings } = c;
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  add("Kill switch", !c.killSwitch, c.killSwitch ? "Kill switch is on" : "Off");
  add("Planned add", !!t.planAdd, t.planAdd ? `Trigger: ${t.addTrigger}` : "This trade had no planned add");
  add("One add only", !t.add, t.add ? `Already added (${t.add.status})` : "Not used yet");
  add("Position open", t.status === "open" && !!t.entryPrice, t.status === "open" ? "Starter filled" : `Trade is ${t.status}`);
  add("Note", c.note.trim().length >= 5, c.note.trim().length >= 5 ? "Logged" : "Write one line on what happened");
  add("Session", regularSession(c.now), regularSession(c.now) ? "Regular session (market order)" : "Adds go in at market during the regular session (9:30–16:00 ET)");
  const e1 = t.entryPrice ?? 0;
  const p = last ?? 0;
  const long = t.direction === "long";
  const inProfit = !!last && e1 > 0 && (long ? p > e1 : p < e1);
  add("In profit", inProfit, last ? `Price ${p} vs average entry ${e1}${inProfit ? "" : ": never average down"}` : "No current price");

  // Size: the add gets the remaining 2/3, capped so the whole position stays within the max position.
  const acct = t.accountValue ?? 0;
  const full = t.fullShadowShares ?? t.shadowShares * 3;
  let s2 = Math.max(0, full - t.shadowShares);
  if (p > 0 && acct > 0) s2 = Math.max(0, Math.min(s2, Math.floor(((settings.maxPositionPct / 100) * acct - t.shadowShares * e1) / p)));
  add("Max position", s2 > 0, s2 > 0 ? `Add ${s2} shadow sh · position ${(((t.shadowShares * e1 + s2 * p) / (acct || 1)) * 100).toFixed(1)}% (max ${settings.maxPositionPct}%)` : "No room left under the max position");

  // Stop: the whole position may risk at most the idea's budget.
  const budget = (t.shadowRiskPct / 100) * acct;
  const s1 = t.shadowShares;
  let requiredStop: number | null = null;
  if (s1 + s2 > 0 && p > 0 && acct > 0) {
    const raw = long ? (s1 * e1 + s2 * p - budget) / (s1 + s2) : (s1 * e1 + s2 * p + budget) / (s1 + s2);
    requiredStop = long ? Math.ceil(raw * 100) / 100 : Math.floor(raw * 100) / 100;
  }
  const cur = t.stopHistory.at(-1)?.stop ?? t.initialStop;
  const sideOk = p > 0 && (long ? newStop < p : newStop > p);
  const tightOk = long ? newStop >= cur : newStop <= cur;
  const riskOk = requiredStop !== null && (long ? newStop >= requiredStop : newStop <= requiredStop);
  const risk = long ? s1 * (e1 - newStop) + s2 * (p - newStop) : s1 * (newStop - e1) + s2 * (newStop - p);
  add(
    "Stop for the full position",
    sideOk && tightOk && riskOk,
    !sideOk
      ? `The stop must be ${long ? "below" : "above"} the price (${p})`
      : !tightOk
        ? `Stops only tighten (current ${cur})`
        : riskOk
          ? `Risk on starter + add ${Math.round(risk).toLocaleString("en-US")} ≤ budget ${Math.round(budget).toLocaleString("en-US")}`
          : `Move the stop to ${long ? "at least" : "at most"} ${requiredStop} so starter + add risk ≤ ${t.shadowRiskPct}% (${Math.round(budget).toLocaleString("en-US")})`,
  );

  const mode: Mode = t.mode;
  const ex = shadowExposure(c.trades, mode);
  const add$ = s2 * p;
  const gross = acct ? ((ex.gross + add$) / acct) * 100 : 0;
  const net = acct ? ((ex.net + (long ? add$ : -add$)) / acct) * 100 : 0;
  add("Gross exposure", gross <= settings.maxGrossPct, `${gross.toFixed(1)}% with the add (max ${settings.maxGrossPct}%)`);
  add("Net exposure", Math.abs(net) <= settings.maxNetPct, `${net >= 0 ? "+" : ""}${net.toFixed(1)}% with the add (max ±${settings.maxNetPct}%)`);
  return { checks: out, ok: out.every((x) => x.ok), addShadowShares: s2, requiredStop };
}

/** Closed trades (this mode) still missing a post-mortem 3+ trading days after they closed. */
export function overduePostMortems(trades: Trade[], mode: Mode, now: number): Trade[] {
  const today = etParts(now).date;
  return trades.filter((t) => t.mode === mode && t.status === "closed" && !t.postMortem && t.exitTime && addTradingDays(etParts(t.exitTime).date, 3) <= today);
}

export function parsePostMortem(raw: Record<string, unknown>, now = Date.now()): { pm: PostMortem | null; errors: string[] } {
  const errors: string[] = [];
  const pick = <T extends string>(k: string, opts: readonly T[], label: string) => {
    const v = raw[k] as T;
    if (!opts.includes(v)) errors.push(`${label}: choose ${opts.join(" / ")}`);
    return v;
  };
  const thesisRight = pick("thesisRight", ["yes", "no", "partly"] as const, "Was the thesis right?");
  const catalystHappened = pick("catalystHappened", ["yes", "no", "not yet"] as const, "Did the catalyst happen?");
  const rightReason = pick("rightReason", ["yes", "no", "luck"] as const, "Did it work for the reason you gave?");
  const learned = String(raw.learned ?? "").trim();
  if (learned.length < 3) errors.push("One line on what you learned");
  if (learned.length > 300) errors.push("Keep the lesson to one line");
  return errors.length ? { pm: null, errors } : { pm: { thesisRight, catalystHappened, rightReason, learned, at: now }, errors };
}

export interface ShadowSize {
  shares: number;
  /** Position $ (shares × entry) and % of the account. */
  position: number;
  positionPct: number;
  /** $ risk to the stop and % of the account (below riskPct when the max-position cap binds). */
  risk: number;
  riskPct: number;
  capped: boolean;
}

/**
 * Full ("shadow") size: floor(risk% × account ÷ |entry − stop|), capped so shares × entry ≤ max position % of
 * the account. E.g. $1M, entry 50, stop 45 → $10,000 ÷ $5 = 2,000 shares ($100K, 10%).
 */
export function shadowSize(accountValue: number | null, s: Pick<StockSettings, "riskPct" | "maxPositionPct">, entry: number, stop: number): ShadowSize {
  const perShare = Math.abs(entry - stop);
  if (!accountValue || !(perShare > 0) || !(entry > 0)) return { shares: 0, position: 0, positionPct: 0, risk: 0, riskPct: 0, capped: false };
  const byRisk = Math.floor(((s.riskPct / 100) * accountValue) / perShare);
  const byCap = Math.floor(((s.maxPositionPct / 100) * accountValue) / entry);
  const shares = Math.max(0, Math.min(byRisk, byCap));
  const position = round2(shares * entry);
  const risk = round2(shares * perShare);
  return {
    shares,
    position,
    positionPct: Math.round((position / accountValue) * 10000) / 100,
    risk,
    riskPct: Math.round((risk / accountValue) * 10000) / 100,
    capped: byCap < byRisk,
  };
}

/** Shadow exposure of open ideas: gross (long + short $) and net (long − short $), at entry (or submit) price. */
export function shadowExposure(trades: Trade[], mode: Mode): { long: number; short: number; gross: number; net: number } {
  let long = 0;
  let short = 0;
  for (const t of trades) {
    if (t.mode !== mode || !isOpen(t)) continue;
    let v = t.shadowShares * (t.entryPrice ?? t.limitPrice ?? t.priceAtSubmit);
    if (t.add && t.add.status !== "cancelled") v += t.add.shadowShares * (t.add.price ?? t.add.priceAtSubmit);
    if (t.direction === "long") long += v;
    else short += v;
  }
  return { long: round2(long), short: round2(short), gross: round2(long + short), net: round2(long - short) };
}

export interface GroupRow {
  key: string;
  trades: number;
  winPct: number | null;
  avgR: number | null;
  totalR: number;
  shadowPl: number;
  avgExcess: number | null;
  avgExcessR: number | null;
}

export interface Summary {
  trades: number;
  /** Shadow P/L as % of the current account value (null if unknown). */
  shadowPlPct?: number | null;
  wins: number;
  winPct: number | null;
  avgR: number | null;
  totalR: number;
  shadowPl: number;
  pl: number;
  /** Average excess return vs SPY (%) and in R, over trades that have it. */
  avgExcess: number | null;
  avgExcessR: number | null;
  bySource: GroupRow[];
  byDirection: GroupRow[];
  byStage: GroupRow[];
  byCrowding: GroupRow[];
  byAdd: GroupRow[];
  /** From the post-mortems: did it work for the stated reason? */
  reasons: { filled: number; yes: number; luck: number; no: number };
}

export function summarize(trades: Trade[], mode: Mode): Summary {
  const closed = closedOfMode(trades, mode);
  const avg = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === "number");
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
  };
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
      avgExcess: avg(ts.map((t) => t.excess)),
      avgExcessR: avg(ts.map((t) => t.excessR)),
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
    byStage: group((t) => (t.stage === undefined || t.stage === null ? "not set" : STAGES[t.stage].label)),
    byCrowding: group((t) => t.crowding?.level ?? "not set"),
    byAdd: group((t) => (t.add?.status === "filled" ? "add used" : t.planAdd ? "add planned, not used" : "no add planned")),
    reasons: {
      filled: closed.filter((t) => t.postMortem).length,
      yes: closed.filter((t) => t.postMortem?.rightReason === "yes").length,
      luck: closed.filter((t) => t.postMortem?.rightReason === "luck").length,
      no: closed.filter((t) => t.postMortem?.rightReason === "no").length,
    },
  };
}

/** Display-only size-up rule: 40 closed trades with average R above 0 and no overrides. */
export function sizeUpEligible(s: Summary, overrides: number): boolean {
  return s.trades >= 40 && (s.avgR ?? 0) > 0 && overrides === 0;
}

/**
 * Size-up stage (display only): each block of 40 closed trades (in close order) with average R above 0, and no
 * overrides, earns the next step — 1/4, then 1/2, then full shadow size. A losing block stops the count there.
 */
export function sizeUpStage(trades: Trade[], mode: Mode, overrides: number): { stage: 0 | 1 | 2 | 3; label: string | null } {
  if (overrides > 0) return { stage: 0, label: null };
  const closed = closedOfMode(trades, mode);
  let stage = 0;
  for (let i = 0; i + 40 <= closed.length && stage < 3; i += 40) {
    const rs = closed.slice(i, i + 40).map((t) => t.r ?? 0);
    if (rs.reduce((a, b) => a + b, 0) / rs.length > 0) stage++;
    else break;
  }
  const labels = [null, "Eligible to trade 1/4 of shadow size live.", "Eligible to trade 1/2 of shadow size live.", "Eligible to trade full shadow size live."];
  return { stage: stage as 0 | 1 | 2 | 3, label: labels[stage] };
}

// ---- Schwab order JSON ----

const px = (v: number) => v.toFixed(v < 1 ? 4 : 2);

/** One bracket: the entry triggers an OCO of the stop and the target (or just the stop when there's no target). */
export function bracketOrder(idea: IdeaInput, shares: number, session: "NORMAL" | "SEAMLESS" = "NORMAL"): Record<string, unknown> {
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
    // The entry may work in extended hours; the stop and target are regular-session orders (Schwab stops
    // don't trigger outside it).
    session,
    // A resting entry (limit or stop) stays working until it fills or is cancelled; a market entry fills at once.
    duration: idea.entryType === "market" ? "DAY" : "GOOD_TILL_CANCEL",
    orderType: idea.entryType === "market" ? "MARKET" : idea.entryType === "stop" ? "STOP" : "LIMIT",
    ...(idea.entryType === "limit" ? { price: px(idea.limitPrice!) } : {}),
    ...(idea.entryType === "stop" ? { stopPrice: px(idea.limitPrice!) } : {}),
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

/** Pre-trade checks that can't be undone after the fact: an adopted trade must have a usable stop now. */
const ADOPT_HARD = new Set(["Quote", "Stop side", "Shortable"]);
/** Checks that don't apply to a trade that already happened. */
const ADOPT_SKIP = new Set(["Session", "Limit vs stop", "Stop entry side", "Target side"]);

/**
 * Adopting a position opened outside the app: the stop must be on the right side of the current price; any
 * other guardrail it breaks is recorded as an override (it can't be undone, but it's counted).
 */
export function adoptChecks(checks: Check[]): { hard: Check[]; overrides: Check[]; shown: Check[] } {
  const shown = checks.filter((c) => !ADOPT_SKIP.has(c.name));
  return {
    shown,
    hard: shown.filter((c) => !c.ok && ADOPT_HARD.has(c.name)),
    overrides: shown.filter((c) => !c.ok && !ADOPT_HARD.has(c.name)),
  };
}
