import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import live from "./fixtures-live-entries.json";
import { exportSchema } from "./advisorContract";
import type { EodSnapshot } from "@/lib/eod";
import type { GaugeRow } from "@/lib/gauge";
import type { OOTrade } from "@/lib/ooCsv";
import { normalizeTransactions, type SchwabTransaction } from "@/lib/realized";
import type { Bar } from "@/lib/schwab/data";
import type { Position } from "@/lib/spreads";
import { classifySpread } from "@/lib/spreads";
import { bookEntryCandidates } from "@/lib/strategyRules";
import { addDays, etMidnightUtc, isTradingDay } from "@/lib/time";
import {
  BOOK_BOTS,
  buildAdvisorExport,
  buildBotRecords,
  entryId,
  ExportUnavailable,
  matchBot,
  parseSince,
  VIX_BUCKETS,
  type AdvisorInput,
} from "@/lib/export/advisor";

// The route imports server-only modules (KV); the loader is replaced so no Schwab or Redis is touched.
vi.mock("server-only", () => ({}));
const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock("@/lib/export/load", () => ({ loadAdvisorExport: loadMock }));
import { GET } from "@/app/api/export/advisor/route";

// ---------- Fixture: the live entries of Oct 27–30 as Schwab transactions ----------

const TODAY = "2026-10-30";
const NOW = etMidnightUtc(TODAY).getTime() + (15 * 60 + 55) * 60_000; // 15:55 ET, before the close
const SINCE = etMidnightUtc(TODAY).getTime();
const LAST4 = "9061";
const FEE = 1.13;
const sym = (exp: string, pc: "P" | "C", k: number) => `SPXW  ${exp.slice(2).replace(/-/g, "")}${pc}${String(k * 1000).padStart(8, "0")}`;
const etIso = (date: string, hms: string, plusMs = 0) => {
  const [h, m, s] = hms.split(":").map(Number);
  return new Date(etMidnightUtc(date).getTime() + ((h * 60 + m) * 60 + s) * 1000 + plusMs).toISOString();
};

type Leg = { putCall: "P" | "C"; strike: number; qty: number; expiration: string };
const orderIds: string[] = [];
const activityIds: string[] = [];
let activity = 27182818;

/** One Schwab transaction per leg (the account fields are what the real feed carries; none may leak). */
function order(orderId: number, timeIso: (i: number) => string, legs: [string, number, number][], effect: "OPENING" | "CLOSING"): SchwabTransaction[] {
  orderIds.push(String(orderId));
  return legs.map(([symbol, amount, price], i) => {
    const cost = -amount * price * 100;
    const f = FEE * Math.abs(amount);
    const id = ++activity;
    activityIds.push(String(id));
    return {
      activityId: id, time: timeIso(i), type: "TRADE", orderId, netAmount: cost - f,
      accountNumber: `1234${LAST4}`, hashValue: "ABCDEF0123456789HASH",
      transferItems: [
        { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, cost: -f, feeType: "COMMISSION" },
        { instrument: { assetType: "OPTION", symbol }, amount, price, cost, positionEffect: effect },
      ],
    } as SchwabTransaction;
  });
}

/** Overnight cash settlements (posted ~01:47 ET the next day) at the given per-share value. */
function settle(timeIso: string, legs: [string, number, number][]): SchwabTransaction[] {
  return legs.map(([symbol, amount, price]) => {
    const id = ++activity;
    activityIds.push(String(id));
    orderIds.push(String(id + 500_000));
    return {
      activityId: id, time: timeIso, type: "TRADE", orderId: id + 500_000, netAmount: -amount * price * 100,
      transferItems: [{ instrument: { assetType: "OPTION", symbol }, amount, price, cost: -amount * price * 100, positionEffect: "CLOSING" }],
    };
  });
}

const price = (qty: number) => (qty < 0 ? 2.0 : 0.5); // shorts sold at 2.00, longs bought at 0.50
const legsOf = (e: { legs: Leg[] }): [string, number, number][] => e.legs.map((l) => [sym(l.expiration, l.putCall, l.strike), l.qty, price(l.qty)]);

const fixture = (live as { date: string; time: string; want: string; legs: Leg[] }[]).map((e, i) => ({ ...e, orderId: 31415926 + i }));
// Oct 27 14:50:08 is a 1-lot BWB on the same strikes as the 4-lot one five seconds earlier: Schwab split one bot
// order in two, and mergeSplitOrders folds them back into one entry (as the scorecard does).
const distinct = fixture.filter((e) => !(e.date === "2026-10-27" && e.time === "14:50:08"));
const byKey = (date: string, time: string) => fixture.find((e) => e.date === date && e.time === time)!;
const stopped = byKey(TODAY, "13:30:03"); // 5d IC bought back at a loss at 14:10
const openIc = byKey(TODAY, "14:30:05");
const vixUp = byKey(TODAY, "15:51:26");

const txs: SchwabTransaction[] = [];
for (const e of fixture) {
  // Legs fill a couple of seconds apart: filledAt must be the latest one.
  txs.push(...order(e.orderId, (i) => etIso(e.date, e.time, i * 2000), legsOf(e), "OPENING"));
  if (e.date < TODAY) {
    const posted = new Date(etMidnightUtc(addDays(e.date, 1)).getTime() + (5 * 60 + 47) * 60_000).toISOString();
    // One BWB expires in the money (its short puts settle at 12.00), everything else worthless.
    const itm = e.date === "2026-10-28" && e.time === "14:50:03";
    txs.push(...settle(posted, legsOf(e).map(([s, q]) => [s, -q, itm && q < 0 ? 12 : 0])));
  }
}
txs.push(...order(99999999, () => etIso(TODAY, "14:10:30"), legsOf(stopped).map(([s, q]) => [s, -q, q < 0 ? 5.0 : 0.3]), "CLOSING"));
const fills = normalizeTransactions(txs, 0.88);

const position = (l: Leg, mark: number): Position => ({
  symbol: sym(l.expiration, l.putCall, l.strike), assetType: "OPTION", description: "", underlying: "SPX", expiration: l.expiration,
  putCall: l.putCall, strike: l.strike, qty: l.qty, avgPrice: price(l.qty), mark, marketValue: l.qty * mark * 100, plOpen: 0, plDay: 0,
});
const positions = [...openIc.legs, ...vixUp.legs].map((l) => position(l, l.qty < 0 ? 1.0 : 0.2));

const tradingDays = (end: string, n: number) => {
  const out: string[] = [];
  for (let d = end; out.length < n; d = addDays(d, -1)) if (isTradingDay(d)) out.unshift(d);
  return out;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const dailyBar = (date: string, close: number): Bar => ({ time: Date.parse(date + "T00:00:00Z") / 1000, open: r1(close - 10), high: r1(close + 20), low: r1(close - 30), close: r1(close) });
const minuteBar = (date: string, hm: string, c: number): Bar => ({ time: Date.parse(etIso(date, hm + ":00")) / 1000, open: c - 1, high: c + 2, low: c - 2, close: c });
const gaugeRow = (date: string, ratio: number | null, status: GaugeRow["status"]): GaugeRow => ({
  date, s10: 6800, K: 6800, call_mid: 20, put_mid: 22, straddle: 42, s16: ratio === null ? null : 6800 + 42 * ratio, move: ratio === null ? null : 42 * ratio,
  ratio, edge: null, straddle_pct: 0.6, status, captured_at: Date.parse(etIso(date, "10:00:00")),
});

const oo: OOTrade[] = [
  { key: "a", strategy: "! SPX 0DTE 5d IC 100-wide 1:30+2:30pm SL300", dateOpened: "2026-10-01", timeOpened: "13:30:00", legs: "", premium: 120, dateClosed: "2026-10-01", timeClosed: "16:00:00", reason: "Expired", pl: 2600, contracts: 26, fundsAtClose: null, openFees: 0, closeFees: 0, vix: 17.2, source: "s", uploadedAt: 1 },
  { key: "b", strategy: "! SPX 0DTE 5d IC 100-wide 1:30+2:30pm SL300", dateOpened: "2026-10-02", timeOpened: "14:30:00", legs: "", premium: 110, dateClosed: "2026-10-02", timeClosed: "15:10:00", reason: "Stop Loss", pl: -7800, contracts: 26, fundsAtClose: null, openFees: 0, closeFees: 0, vix: 23.9, source: "s", uploadedAt: 1 },
  { key: "c", strategy: "! SPX 0DTE 5d IC 100-wide 1:30+2:30pm SL300", dateOpened: "2026-10-03", timeOpened: "13:30:00", legs: "", premium: 125, dateClosed: "2026-10-03", timeClosed: "16:00:00", reason: "Expired", pl: 3250, contracts: 26, fundsAtClose: null, openFees: 0, closeFees: 0, vix: 14.1, source: "s", uploadedAt: 1 },
  { key: "d", strategy: "SPX BWB 1:50pm", dateOpened: "2026-10-03", timeOpened: "13:50:00", legs: "", premium: -50, dateClosed: "2026-10-03", timeClosed: "15:50:00", reason: "Time Exit", pl: 600, contracts: 6, fundsAtClose: null, openFees: 0, closeFees: 0, vix: null, source: "s", uploadedAt: 1 },
];

const input: AdvisorInput = {
  now: NOW,
  since: SINCE,
  connected: true,
  errors: [],
  fillsFetchedAt: NOW - 9_000,
  fills,
  fillsFrom: addDays(TODAY, -28),
  positions,
  quotes: {
    spx: { symbol: "$SPX", last: 6851.37, change: 21.37, changePct: 0.31, prevClose: 6830, time: NOW - 3_000 },
    vix: { symbol: "$VIX", last: 18.42, change: -0.3, changePct: -1.6, prevClose: 18.72, time: NOW - 3_000 },
    vix9d: null,
    fetchedAt: NOW - 2_500,
  },
  snapshots: [
    { at: new Date(NOW - 63_000).toISOString(), spx: 6849.1, vix: 18.5, vix9d: null },
    { at: new Date(NOW - 3_000).toISOString(), spx: 6851.37, vix: 18.42, vix9d: null },
  ],
  bars: {
    spx1m: ["09:30", "09:31", "09:32"].map((hm, i) => minuteBar(TODAY, hm, 6835 + i)),
    spx5m: ["09:30", "09:35"].map((hm, i) => minuteBar(TODAY, hm, 6835 + i)),
    spxDaily: tradingDays(addDays(TODAY, -1), 70).map((d, i) => dailyBar(d, 6700 + i)),
    vixDaily: tradingDays(addDays(TODAY, -1), 20).map((d, i) => dailyBar(d, 16 + i / 10)),
    vix9dDaily: [],
  },
  gauge: [
    ...tradingDays(addDays(TODAY, -1), 12).map((d, i) => gaugeRow(d, 0.5 + i * 0.1, "closed")),
    gaugeRow(TODAY, null, "open"),
  ],
  eod: tradingDays(addDays(TODAY, -1), 3).map((date, i): EodSnapshot => ({ date, takenAt: 0, netLiq: 400_000, startNetLiq: 399_000, dayPl: [1500, -4200, 800][i], realized: 0, openPl: 0, positions: [] })),
  bots: buildBotRecords(oo, null),
  seenAt: {},
};

const authed = (token: string | null, since: string | null = new Date(SINCE).toISOString()) =>
  new NextRequest(`http://localhost/api/export/advisor${since === null ? "" : `?since=${encodeURIComponent(since)}`}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

beforeEach(() => {
  process.env.OO_EXPORT_TOKEN = "export-token-for-tests";
  process.env.OO_INGEST_TOKEN = "ingest-token-for-tests";
  process.env.CRON_SECRET = "cron-secret-for-tests";
  process.env.SCHWAB_ACCOUNT_LAST4 = LAST4;
  loadMock.mockReset();
  loadMock.mockImplementation(async () => buildAdvisorExport(input));
});

describe("GET /api/export/advisor: auth", () => {
  it("401 without a token and with a wrong one", async () => {
    expect((await GET(authed(null))).status).toBe(401);
    expect((await GET(authed("wrong"))).status).toBe(401);
    expect(loadMock).not.toHaveBeenCalled();
  });
  it("only OO_EXPORT_TOKEN opens it, not the ingest token or the cron secret", async () => {
    expect((await GET(authed("ingest-token-for-tests"))).status).toBe(401);
    expect((await GET(authed("cron-secret-for-tests"))).status).toBe(401);
    expect((await GET(authed("export-token-for-tests"))).status).toBe(200);
  });
  it("401 when the token isn't configured at all", async () => {
    delete process.env.OO_EXPORT_TOKEN;
    expect((await GET(authed(""))).status).toBe(401);
  });
  it("400 on a bad since, default since is today's 00:00 ET", async () => {
    expect((await GET(authed("export-token-for-tests", "yesterday"))).status).toBe(400);
    expect(parseSince(null, NOW)).toBe(SINCE);
    expect(parseSince("2026-10-30T04:00:00.000Z", NOW)).toBe(SINCE);
    expect(parseSince("nope", NOW)).toBeNull();
  });
  it("503 while Schwab isn't connected", async () => {
    loadMock.mockImplementation(async () => buildAdvisorExport({ ...input, connected: false, errors: ["Schwab is not connected"] }));
    const res = await GET(authed("export-token-for-tests"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Schwab is not connected" });
    expect(() => buildAdvisorExport({ ...input, quotes: { ...input.quotes, vix: null } })).toThrow(ExportUnavailable);
  });
});

describe("GET /api/export/advisor: response", () => {
  it("validates against the advisor's contract", async () => {
    const res = await GET(authed("export-token-for-tests"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const parsed = exportSchema.safeParse(await res.json());
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 5))).toBe(true);
  });

  it("carries no account number, hash, last-4 or Schwab order/activity ids", async () => {
    const text = JSON.stringify(await (await GET(authed("export-token-for-tests"))).json());
    for (const needle of ["accountNumber", "hashValue", LAST4, "orderId", "activityId", "ABCDEF0123456789HASH", ...orderIds, ...activityIds]) {
      expect(text, `found ${needle}`).not.toContain(needle);
    }
    expect(input.fills.some((f) => f.orderId === String(stopped.orderId))).toBe(true); // the ids were there to leak
  });

  it("builds today's entries from the fixture with the expected bot and an exact match, oldest first", () => {
    const exp = buildAdvisorExport(input);
    const todays = fixture.filter((e) => e.date === TODAY).sort((a, b) => a.time.localeCompare(b.time));
    expect(exp.entries.map((e) => e.bot)).toEqual(todays.map((e) => e.want));
    expect(exp.entries.every((e) => e.match === "exact" && e.matchConfidence === 1 && e.candidates.length === 1)).toBe(true);
    expect(exp.entries.map((e) => e.filledAt)).toEqual(todays.map((e) => etIso(e.date, e.time, (e.legs.length - 1) * 2000))); // latest leg fill
    expect(exp.entries.every((e) => /^[0-9a-f]{24}$/.test(e.id))).toBe(true);
    expect(exp.entries[0]).toMatchObject({
      id: entryId(String(stopped.orderId)),
      bot: "5d IC",
      structure: "iron condor",
      underlying: "SPX",
      contracts: 13,
      netPrice: 3, // 2 × 2.00 sold − 2 × 0.50 bought, per 1-lot
      detectedAt: null,
      rules: { stop: "300% of credit (OO SL300)", target: "expire" },
    });
    expect(exp.entries[0].legs).toEqual(expect.arrayContaining(stopped.legs));
    expect(exp.entries[0].matchReason).toMatch(/iron condor, puts 100 wide, calls 100 wide, 0DTE, 13:30 ET: 5d IC in its entry window/);
    expect(exp.entries[2]).toMatchObject({ bot: "VIX-up PS", structure: "custom (4 legs)", contracts: 5 });
    // Every fixture entry (all four days) gets the bot the scorecard gave it.
    const all = buildAdvisorExport({ ...input, since: etMidnightUtc("2026-10-27").getTime() });
    expect(all.entries.map((e) => [e.filledAt.slice(0, 10), e.bot])).toEqual([...distinct].reverse().map((e) => [e.date, e.want]));
    expect(all.entries.find((e) => e.filledAt.startsWith("2026-10-27T18:50"))).toMatchObject({ bot: "BWB", contracts: 5 }); // 4 + 1 lots merged
    expect(all.entries.find((e) => e.bot === "FOMC")?.structure).toBe("long straddle");
    // detectedAt comes from the first-seen record.
    const seen = buildAdvisorExport({ ...input, seenAt: { [exp.entries[0].id]: NOW - 9_000 } });
    expect(seen.entries[0].detectedAt).toBe(new Date(NOW - 9_000).toISOString());
    expect(seen.entries[1].detectedAt).toBeNull();
  });

  it("reports an ambiguous structure as ambiguous, settled by the entry window when it can be", () => {
    const d = TODAY;
    const ic: Leg[] = [{ putCall: "P", strike: 6700, qty: 2, expiration: d }, { putCall: "P", strike: 6750, qty: -2, expiration: d }, { putCall: "C", strike: 6850, qty: -2, expiration: d }, { putCall: "C", strike: 6900, qty: 2, expiration: d }];
    // 13:32 ET is inside both the 8SMA IC and the $8 IC windows.
    const amb = matchBot(ic, d, 13 * 60 + 32, ["8SMA IC", "$8 IC"]);
    expect(amb).toMatchObject({ match: "ambiguous", bot: null, candidates: ["8SMA IC", "$8 IC"], matchConfidence: 0.5 });
    expect(amb.matchReason).toMatch(/fits 8SMA IC or \$8 IC; the entry time does not settle it/);
    // 13:27 ET is only in the 8SMA IC window: exact, but with a tie-break confidence.
    expect(matchBot(ic, d, 13 * 60 + 27, ["8SMA IC", "$8 IC"])).toMatchObject({ match: "exact", bot: "8SMA IC", candidates: ["8SMA IC", "$8 IC"], matchConfidence: 0.6 });
    // One candidate outside its window: still exact, lower confidence.
    expect(matchBot(ic, d, 10 * 60)).toMatchObject({ match: "exact", bot: "$8 IC", matchConfidence: 0.8 });
    expect(matchBot(ic, d, 10 * 60).matchReason).toMatch(/outside its entry window/);
    // Nothing fits: none.
    const odd: Leg[] = [{ putCall: "P", strike: 6700, qty: -1, expiration: d }];
    expect(matchBot(odd, d, 600)).toMatchObject({ match: "none", bot: null, candidates: [], matchConfidence: 0 });
    expect(bookEntryCandidates(odd, d)).toEqual([]);
    expect(bookEntryCandidates(ic, d)).toEqual(["$8 IC"]);
  });

  it("scores outcomes and today's book from the fills", () => {
    const exp = buildAdvisorExport(input);
    const stoppedId = entryId(String(stopped.orderId));
    // 13 lots: credit 3.00 → 3,900; bought back at 5.00 / sold at 0.30 → −12,220; fees 1.13 × 52 × 2.
    const stop = exp.outcomes.find((o) => o.entryId === stoppedId)!;
    expect(stop).toMatchObject({ bot: "5d IC", how: "stop", closedAt: etIso(TODAY, "14:10:30") });
    expect(stop.pl).toBeCloseTo(3900 - 12220 - 117.52, 2);
    // Yesterday's Short (16 lots) expired worthless: credit 1.50 → 2,400 − fees 1.13 × 32; settled at the bell.
    const short = exp.outcomes.find((o) => o.bot === "Short")!;
    expect(short).toMatchObject({ how: "expired", closedAt: "2026-10-29T20:00:00.000Z" });
    expect(short.pl).toBeCloseTo(2400 - 36.16, 2);
    // Outcomes cover the week before `since` (multi-day bots, overnight postings): every closed/expired entry.
    expect(exp.outcomes).toHaveLength(distinct.length - 2);
    expect(exp.outcomes.find((o) => o.closedAt.startsWith("2026-10-28") && o.pl < 0 && o.bot === "BWB")).toMatchObject({ how: "expired" }); // settled in the money
    // Only the order-closed loss is a stop; losses at expiration (the ITM BWB, the FOMC straddle) stay "expired".
    expect(exp.outcomes.filter((o) => o.how === "stop").map((o) => o.entryId)).toEqual([stoppedId]);
    expect(exp.outcomes.filter((o) => o.how === "expired")).toHaveLength(exp.outcomes.length - 1);

    expect(exp.book.today.map((t) => t.status)).toEqual(["stopped", "open", "open"]);
    const open = exp.book.today[1];
    expect(open.entryId).toBe(entryId(String(openIc.orderId)));
    // Open IC marked at 1.00 / 0.20: 3,900 credit − 2,080 at the mark − 58.76 fees.
    expect(open.pl).toBeCloseTo(3900 - 2080 - 58.76, 2);
    expect(exp.book.todayTotal).toBeCloseTo(exp.book.today.reduce((s, t) => s + t.pl, 0), 2);
    expect(exp.book.stoppedOutBots).toEqual(["5d IC"]);
    // Daily: EOD snapshots where they exist, else what closed that day; 15 trading days ending yesterday.
    expect(exp.book.daily).toHaveLength(15);
    expect(exp.book.daily.at(-1)).toEqual({ date: "2026-10-29", pl: 800 });
    expect(exp.book.daily.at(-4)!.date).toBe("2026-10-26");
    expect(exp.book.daily.at(-4)!.pl).toBe(0);
    expect(exp.book.drawdownFromHigh).toBeLessThanOrEqual(0);
  });

  it("gives every book bot a record with the five VIX buckets, its rules and its last 10 live days", () => {
    const exp = buildAdvisorExport(input);
    for (const bot of BOOK_BOTS) expect(Object.keys(exp.bots)).toContain(bot);
    const ic = exp.bots["5d IC"];
    expect(ic.backtest.byVixBucket.map((b) => b.bucket)).toEqual([...VIX_BUCKETS]);
    expect(ic.backtest.byVixBucket[1]).toEqual({ bucket: "15-20", trades: 1, winRate: 1, avgPl: 100 });
    expect(ic.backtest.byEntryTime).toEqual([
      { time: "13:30", trades: 2, winRate: 1, avgPl: 112.5 },
      { time: "14:30", trades: 1, winRate: 0, avgPl: -300 },
    ]);
    expect(ic.liveVsBacktest).toBeNull();
    expect(exp.bots.BWB.rules).toEqual({ stop: null, target: "time exit 15:50 ET, then expire" });
    expect(ic.last10Days).toHaveLength(10);
    expect(ic.last10Days.at(-1)!.date).toBe(TODAY);
    expect(ic.last10Days.at(-1)!.trades).toEqual([{ time: "13:30", pl: expect.any(Number) }]); // the stopped one; the open one isn't scored yet
    expect(ic.last10Days.at(-2)!.trades.map((t) => t.time)).toEqual(["13:30", "14:30"]);
  });

  it("passes quotes, snapshots, bars and the gauge through", () => {
    const exp = buildAdvisorExport(input);
    expect(exp.market.spx).toEqual({ last: 6851.37, quoteTime: new Date(NOW - 3_000).toISOString(), prevClose: 6830 });
    expect(exp.market.vix9d).toBeNull();
    expect(exp.market.snapshots.map((s) => s.spx)).toEqual([6849.1, 6851.37]);
    expect(exp.market.spxBars1m[0]).toEqual({ t: etIso(TODAY, "09:30:00"), o: 6834, h: 6837, l: 6833, c: 6835 });
    expect(exp.market.spxDaily60).toHaveLength(60);
    expect(exp.market.vixDaily15).toHaveLength(15);
    expect(exp.market.vix9dDaily15).toEqual([]);
    expect(exp.market.gauge.today).toEqual({ straddle: 42, strike: 6800, capturedAt: etIso(TODAY, "10:00:00") });
    expect(exp.market.gauge.avgMoveRatio10d).toBeCloseTo((0.7 + 1.6) / 2, 6); // mean of the last 10 closed days (0.7 … 1.6)
    expect(exp.schwab).toEqual({ connected: true, fillsFetchedAt: new Date(NOW - 9_000).toISOString(), errors: [] });
  });
});

describe("structure names", () => {
  it("knows straddles and strangles", () => {
    expect(classifySpread([{ putCall: "C", strike: 6800, qty: 5 }, { putCall: "P", strike: 6800, qty: 5 }])).toBe("Long straddle");
    expect(classifySpread([{ putCall: "C", strike: 6850, qty: -1 }, { putCall: "P", strike: 6750, qty: -1 }])).toBe("Short strangle");
  });
});
