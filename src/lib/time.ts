// All market/time logic is in America/New_York.
export const TZ = "America/New_York";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

export interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sun
  date: string; // YYYY-MM-DD
  minutesOfDay: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function etParts(d: Date | number = Date.now()): EtParts {
  const parts = Object.fromEntries(fmt.formatToParts(new Date(d)).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    minutesOfDay: hour * 60 + minute,
  };
}

export function todayET(d: Date | number = Date.now()): string {
  return etParts(d).date;
}

/** Offset of ET from UTC in minutes at the given instant (e.g. -240 for EDT). */
export function etOffsetMinutes(d: Date | number): number {
  const p = etParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const t = typeof d === "number" ? d : d.getTime();
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
}

/** UTC instant of 00:00 ET on the given YYYY-MM-DD. */
export function etMidnightUtc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 12); // midday avoids DST edge
  const off = etOffsetMinutes(guess);
  return new Date(Date.UTC(y, m - 1, d) - off * 60000);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function formatTimeET(ms: number | null | undefined): string {
  if (!ms) return "—";
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms)) + " ET"
  );
}

export function formatDateTimeET(ms: number | null | undefined): string {
  if (!ms) return "—";
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms)) + " ET"
  );
}

// NYSE full-day holidays (Cboe index options follow the NYSE calendar).
const HOLIDAYS = new Set([
  "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

// 1:00 PM ET early closes.
const EARLY_CLOSES = new Set(["2025-07-03", "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24", "2027-11-26"]);

export function isTradingDay(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd !== 0 && wd !== 6 && !HOLIDAYS.has(date);
}

export type MarketPhase = "open" | "final" | "closed";

export interface Session {
  phase: MarketPhase;
  date: string;
  tradingDay: boolean;
  /** Minutes of day (ET) the dashboard's polling window opens/closes. */
  openMin: number;
  closeMin: number;
}

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60 + 15;
const EARLY_CLOSE_MIN = 13 * 60 + 15;
const FINAL_WINDOW_MIN = 45; // 15:30–16:15

export function marketSession(now: Date | number = Date.now()): Session {
  const p = etParts(now);
  const tradingDay = isTradingDay(p.date);
  const closeMin = EARLY_CLOSES.has(p.date) ? EARLY_CLOSE_MIN : CLOSE_MIN;
  let phase: MarketPhase = "closed";
  if (tradingDay && p.minutesOfDay >= OPEN_MIN && p.minutesOfDay < closeMin) {
    phase = p.minutesOfDay >= closeMin - FINAL_WINDOW_MIN ? "final" : "open";
  }
  return { phase, date: p.date, tradingDay, openMin: OPEN_MIN, closeMin };
}

export interface RefreshPolicy {
  /** Positions + marks + balances + SPX quote (one account call returns positions and balances). */
  positionsMs: number;
  transactionsMs: number;
  /** null => no auto-polling. */
  pollMs: number | null;
}

export function refreshPolicy(phase: MarketPhase): RefreshPolicy {
  switch (phase) {
    case "final":
      return { positionsMs: 10_000, transactionsMs: 60_000, pollMs: 10_000 };
    case "open":
      return { positionsMs: 15_000, transactionsMs: 60_000, pollMs: 15_000 };
    default:
      return { positionsMs: Infinity, transactionsMs: Infinity, pollMs: null };
  }
}

export const MANUAL_REFRESH_MIN_MS = 30_000;

/** Date of the most recent session that has started (today after 9:30 ET on a trading day, else the prior trading day). */
export function lastSessionDate(now: Date | number = Date.now()): string {
  const p = etParts(now);
  let d = p.date;
  if (isTradingDay(d) && p.minutesOfDay >= OPEN_MIN) return d;
  for (let i = 0; i < 10; i++) {
    d = addDays(d, -1);
    if (isTradingDay(d)) return d;
  }
  return p.date;
}

/** Latest date a backtest can cover: the last trading day before today (ET). OO never runs the current day. */
export function lastBacktestableDate(now: Date | number = Date.now()): string {
  let d = etParts(now).date;
  for (let i = 0; i < 10; i++) {
    d = addDays(d, -1);
    if (isTradingDay(d)) return d;
  }
  return d;
}
