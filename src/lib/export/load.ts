// Gathers everything the advisor export needs through the existing cached Schwab fetchers (shared rate limiter,
// cross-instance cache), keeps the quote-snapshot ring buffer and the first-seen times, then builds the response.
// Read-only: no Schwab path is used here that the dashboard doesn't already use.
import "server-only";
import { cached } from "../cache";
import { listSnapshots } from "../eod";
import { gaugeRows } from "../gaugeCapture";
import { KEYS, kv } from "../kv";
import { uniqueEntries } from "../allocSim";
import type { OOTrade } from "../ooCsv";
import { buildScorecard } from "../scorecard";
import { cachedAccount, cachedDailyBars, cachedFillsSince, cachedFiveMinuteBars, cachedMinuteBars, cachedQuotes } from "../schwab/data";
import { tokenStatus } from "../schwab/tokens";
import { addDays, closedMaxAge, marketSession, todayET } from "../time";
import { buildAdvisorExport, buildBotRecords, type AdvisorExport, type AdvisorInput, type BotRecord, type QuoteSnapshot } from "./advisor";

/** First live day of the book (scorecard inception). */
const liveSince = () => process.env.LIVE_SINCE ?? "2026-10-27";
/** Calendar days of fills behind today for entries, outcomes, the book's daily P/L and each bot's last 10 days. */
const FILL_DAYS = 28;
/** Quote snapshots are kept this long. */
const SNAPSHOT_KEEP_MS = 12 * 60_000;
const SNAPSHOT_MAX = 200;

/** Max ages while the market is open vs. closed (closed: refetch once after the close, then every 5 minutes at most). */
const age = (openMs: number, now: number, live: boolean) => (live ? openMs : Math.min(closedMaxAge(now), 5 * 60_000));

/** Slow-moving per-bot facts (stored OO trades + scorecard), rebuilt every 10 minutes. */
async function botRecords(now: number): Promise<{ data: Record<string, BotRecord>; error: string | null }> {
  const res = await cached<Record<string, BotRecord>>("export:bots:v1", 10 * 60_000, async () => {
    const [oo, fills] = await Promise.all([kv().hgetall<OOTrade>(KEYS.ooTrades), cachedFillsSince(liveSince(), 5 * 60_000)]);
    const trades = uniqueEntries(Object.values(oo));
    const sc = fills.fills.length ? buildScorecard(fills.fills, trades, liveSince(), now) : null;
    return buildBotRecords(trades, sc);
  });
  return { data: res.data ?? {}, error: res.error };
}

/** Append the latest quotes to the ring buffer (keyed by Schwab's quote time) and return the recent snapshots. */
async function recordSnapshot(quotes: AdvisorInput["quotes"], now: number): Promise<QuoteSnapshot[]> {
  const store = kv();
  const prev = (await store.get<QuoteSnapshot[]>(KEYS.exportSnapshots)) ?? [];
  const spx = quotes.spx;
  const at = spx?.time ?? quotes.fetchedAt;
  let next = prev.filter((s) => Date.parse(s.at) >= now - SNAPSHOT_KEEP_MS);
  if (spx && spx.last !== null && at !== null && !next.some((s) => s.at === new Date(at).toISOString())) {
    next.push({ at: new Date(at).toISOString(), spx: spx.last, vix: quotes.vix?.last ?? null, vix9d: quotes.vix9d?.last ?? null });
    next.sort((a, b) => a.at.localeCompare(b.at));
    next = next.slice(-SNAPSHOT_MAX);
  }
  if (next.length !== prev.length || next.at(-1)?.at !== prev.at(-1)?.at) await store.set(KEYS.exportSnapshots, next, { ex: 3600 });
  return next;
}

/** When each of today's (and the requested range's) entries was first seen, recording the new ones now. */
async function seenTimes(entries: AdvisorExport["entries"], firstSeenAt: number): Promise<Record<string, number>> {
  const store = kv();
  const dates = [...new Set(entries.map((e) => todayET(Date.parse(e.filledAt))))];
  const seen: Record<string, number> = {};
  for (const date of dates) Object.assign(seen, await store.hgetall<number>(KEYS.exportSeen(date)));
  const byDate = new Map<string, [string, number][]>();
  for (const e of entries) {
    if (seen[e.id]) continue;
    const date = todayET(Date.parse(e.filledAt));
    byDate.set(date, [...(byDate.get(date) ?? []), [e.id, firstSeenAt]]);
    seen[e.id] = firstSeenAt;
  }
  for (const [date, rows] of byDate) await store.hsetnxMany(KEYS.exportSeen(date), rows);
  return seen;
}

/** Fetch (through the caches), build and return the export for entries at or after `since` (ms). */
export async function loadAdvisorExport(since: number, now = Date.now()): Promise<AdvisorExport> {
  const today = todayET(now);
  const phase = marketSession(now).phase;
  const live = phase === "open" || phase === "final";
  const token = await tokenStatus();
  const errors: string[] = [];
  const push = (e: string | null | undefined) => {
    if (e && !errors.includes(e)) errors.push(e);
  };

  const fillsFrom = addDays(today, -FILL_DAYS);
  const base: Omit<AdvisorInput, "fills" | "fillsFetchedAt" | "positions" | "quotes" | "snapshots" | "bars" | "bots"> = {
    now,
    since,
    connected: token.connected,
    errors,
    fillsFrom,
    gauge: [],
    eod: [],
    seenAt: {},
  };
  if (!token.connected) {
    push(token.lastError ?? "Schwab is not connected");
    return buildAdvisorExport({
      ...base,
      fills: [],
      fillsFetchedAt: null,
      positions: [],
      quotes: { spx: null, vix: null, vix9d: null, fetchedAt: null },
      snapshots: [],
      bars: { spx1m: [], spx5m: [], spxDaily: [], vixDaily: [], vix9dDaily: [] },
      bots: {},
    });
  }

  const [fills, acct, quotes, spx1m, spx5m, spxDaily, vixDaily, vix9dDaily, gauge, eod, bots] = await Promise.all([
    cachedFillsSince(fillsFrom, age(15_000, now, live)),
    cachedAccount(age(15_000, now, live)),
    cachedQuotes(["$SPX", "$VIX", "$VIX9D"], age(10_000, now, live)),
    cachedMinuteBars("$SPX", today, age(20_000, now, live)),
    cachedFiveMinuteBars("$SPX", 5, age(5 * 60_000, now, live)),
    cachedDailyBars("$SPX", age(30 * 60_000, now, live)),
    cachedDailyBars("$VIX", age(30 * 60_000, now, live)),
    cachedDailyBars("$VIX9D", age(30 * 60_000, now, live)),
    gaugeRows().catch((e: Error) => {
      push(`gauge: ${e.message}`);
      return [];
    }),
    listSnapshots().catch((e: Error) => {
      push(`eod: ${e.message}`);
      return [];
    }),
    botRecords(now),
  ]);
  fills.errors.forEach(push);
  for (const r of [acct, quotes, spx1m, spx5m, spxDaily, vixDaily, vix9dDaily]) push(r.error);
  push(bots.error);

  // The current week's window is the one that reaches today.
  const liveWindow = fills.windows.find((w) => w.from <= today && today < w.to) ?? fills.windows.at(-1);
  const q = { spx: quotes.data?.["$SPX"] ?? null, vix: quotes.data?.["$VIX"] ?? null, vix9d: quotes.data?.["$VIX9D"] ?? null, fetchedAt: quotes.fetchedAt };
  const snapshots = await recordSnapshot(q, now).catch((e: Error) => {
    push(`snapshots: ${e.message}`);
    return [] as QuoteSnapshot[];
  });

  const input: AdvisorInput = {
    ...base,
    fills: fills.fills,
    fillsFetchedAt: liveWindow?.fetchedAt ?? fills.fetchedAt,
    positions: acct.data?.positions ?? [],
    quotes: q,
    snapshots,
    bars: { spx1m: spx1m.data ?? [], spx5m: spx5m.data ?? [], spxDaily: spxDaily.data ?? [], vixDaily: vixDaily.data ?? [], vix9dDaily: vix9dDaily.data ?? [] },
    gauge,
    eod,
    bots: bots.data,
  };
  const first = buildAdvisorExport(input);
  if (!first.entries.length) return first;
  // detectedAt: when oo-trading first had the fill, i.e. the Schwab fetch that first contained it (now for new ones).
  input.seenAt = await seenTimes(first.entries, input.fillsFetchedAt ?? now).catch((e: Error) => {
    push(`seen: ${e.message}`);
    return {};
  });
  return buildAdvisorExport(input);
}
