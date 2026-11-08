// 0DTE premium gauge captures (read-only Schwab market data): the 10:00 ET straddle snapshot and the 16:00 close.
import "server-only";
import { atmStrike, closeRow, tenDeltaPut, type GaugeRow } from "./gauge";
import { KEYS, kv } from "./kv";
import { fetchQuotes } from "./schwab/data";
import { schwabGet } from "./schwab/client";
import { etMidnightUtc, etParts, isTradingDay } from "./time";

interface ChainContract {
  symbol?: string;
  bid?: number;
  ask?: number;
  strikePrice?: number;
}
type ExpMap = Record<string, Record<string, ChainContract[]>>;
interface RawChain {
  status?: string;
  callExpDateMap?: ExpMap;
  putExpDateMap?: ExpMap;
}

/** Same-day SPXW contracts from a chain side, by strike. */
function sameDay(map: ExpMap | undefined, date: string): Map<number, ChainContract> {
  const out = new Map<number, ChainContract>();
  for (const [exp, strikes] of Object.entries(map ?? {})) {
    if (!exp.startsWith(date)) continue;
    for (const [k, cs] of Object.entries(strikes)) {
      const c = cs.find((x) => (x.symbol ?? "").startsWith("SPXW")) ?? cs[0];
      if (c) out.set(Number(k), c);
    }
  }
  return out;
}

/** Mid of a quote, or null when it's missing or crossed. */
const mid = (c: ChainContract | undefined) =>
  c && typeof c.bid === "number" && typeof c.ask === "number" && c.ask > 0 && c.bid >= 0 && c.bid <= c.ask ? (c.bid + c.ask) / 2 : null;

export async function gaugeRows(): Promise<GaugeRow[]> {
  return Object.values(await kv().hgetall<GaugeRow>(KEYS.gaugeDays)).sort((a, b) => a.date.localeCompare(b.date));
}

async function save(row: GaugeRow) {
  await kv().hset(KEYS.gaugeDays, row.date, row);
  return row;
}

const empty = (date: string, now: number): GaugeRow => ({
  date,
  s10: null,
  K: null,
  call_mid: null,
  put_mid: null,
  straddle: null,
  s16: null,
  move: null,
  ratio: null,
  edge: null,
  straddle_pct: null,
  status: "skipped",
  captured_at: now,
});

/**
 * 10:00 ET snapshot: SPX last → K (nearest 5), the same-day SPXW K call and put mids, and the 10-delta put.
 * Overwrites today's row (idempotent). A holiday schedule or a missing/crossed quote stores status "skipped".
 */
export async function captureOpen(now = Date.now()): Promise<GaugeRow> {
  const p = etParts(now);
  const date = p.date;
  try {
    const q = (await fetchQuotes(["$SPX"]))["$SPX"];
    const s10 = q?.last ?? null;
    if (s10 === null) return save({ ...empty(date, now), status: "error", reason: "no SPX quote" });
    const K = atmStrike(s10);
    const chain = await schwabGet<RawChain>("/marketdata/v1/chains", {
      symbol: "$SPX",
      contractType: "ALL",
      strikeCount: "80",
      fromDate: date,
      toDate: date,
      includeUnderlyingQuote: "false",
    });
    const calls = sameDay(chain.callExpDateMap, date);
    const puts = sameDay(chain.putExpDateMap, date);
    if (!calls.size && !puts.size) return save({ ...empty(date, now), s10, K, reason: "no same-day SPXW expiry" });
    const call_mid = mid(calls.get(K));
    const put_mid = mid(puts.get(K));
    if (call_mid === null || put_mid === null) {
      return save({ ...empty(date, now), s10, K, call_mid, put_mid, reason: `missing or crossed ${call_mid === null ? "call" : "put"} quote at ${K}` });
    }
    const straddle = Math.round((call_mid + put_mid) * 100) / 100;
    // Years to 16:00 ET today.
    const t = (etMidnightUtc(date).getTime() + 16 * 3600_000 - now) / (365 * 24 * 3600_000);
    const wing = tenDeltaPut(
      [...puts].map(([strike, c]) => ({ strike, mid: mid(c) ?? 0 })),
      s10,
      t,
    );
    return save({
      ...empty(date, now),
      s10,
      K,
      call_mid: Math.round(call_mid * 100) / 100,
      put_mid: Math.round(put_mid * 100) / 100,
      straddle,
      straddle_pct: Math.round((straddle / s10) * 100 * 10_000) / 10_000,
      status: "open",
      wing,
    });
  } catch (e) {
    return save({ ...empty(date, now), status: "error", reason: (e as Error).message.slice(0, 200) });
  }
}

/** After 16:00:30 ET: the SPX close (the quote's last once the session is over) completes today's row. */
export async function captureClose(now = Date.now()): Promise<GaugeRow | null> {
  const date = etParts(now).date;
  const row = (await kv().hgetall<GaugeRow>(KEYS.gaugeDays))[date];
  if (!row || (row.status !== "open" && row.status !== "closed")) return row ?? null;
  const q = (await fetchQuotes(["$SPX"]))["$SPX"];
  const closeAt = etMidnightUtc(date).getTime() + 16 * 3600_000;
  if (!q?.last || !q.time || q.time < closeAt - 60_000) return row; // no post-close print yet
  return save(closeRow(row, q.last, now));
}

/** The snapshot belongs to 10:00 ET; a late first capture (e.g. a page opened at 10:04) is accepted until 10:10. */
const OPEN_FROM = 10 * 3600;
const OPEN_UNTIL = 10 * 3600 + 10 * 60;
const CLOSE_FROM = 16 * 3600 + 30;

/**
 * Run whichever step is due: the 10:00 snapshot (10:00:00–10:10 ET; `overwrite` re-takes it, as a scheduled
 * call does) or the close (from 16:00:30 ET, any time later that day).
 */
export async function captureDue(now = Date.now(), opts: { overwrite?: boolean } = {}): Promise<{ step: string; row: GaugeRow | null }> {
  const p = etParts(now);
  if (!isTradingDay(p.date)) return { step: "none (not a trading day)", row: null };
  const secs = p.minutesOfDay * 60 + p.second;
  const today = (await kv().hgetall<GaugeRow>(KEYS.gaugeDays))[p.date];
  if (secs >= CLOSE_FROM) return { step: "close", row: await captureClose(now) };
  if (secs >= OPEN_FROM && secs < OPEN_UNTIL && (opts.overwrite || !today)) return { step: "open", row: await captureOpen(now) };
  return { step: "none", row: today ?? null };
}
