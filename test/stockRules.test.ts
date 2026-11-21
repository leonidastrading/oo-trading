import { describe, expect, it } from "vitest";
import {
  bracketOrder,
  changeSettings,
  checkStopChange,
  closeOut,
  DEFAULT_SETTINGS,
  effectiveSettings,
  excessReturn,
  exitByDate,
  parseIdea,
  preTradeChecks,
  shadowSize,
  sizeUpStage,
  sizeUpEligible,
  streakLockUntil,
  summarize,
  weekStart,
  type IdeaInput,
  type Trade,
} from "@/lib/stocks/rules";

// 2026-11-18 is a Wednesday (EST, UTC−5).
const at = (date: string, hh: number, mm = 0) => Date.parse(`${date}T${String(hh + 5).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
const NOW = at("2026-11-18", 11);
const idea: IdeaInput = {
  ticker: "AAPL",
  direction: "long",
  entryType: "market",
  stop: 190,
  target: 220,
  thesis: "Breakout above the base on volume.",
  invalidation: "Close back inside the base.",
  days: 10,
  source: "trend scout",
};
const quote = { symbol: "AAPL", last: 200, bid: 199.9, ask: 200.1, shortable: true, hardToBorrow: false };
const trade = (o: Partial<Trade>): Trade => ({
  ...idea,
  id: Math.random().toString(36),
  mode: "dry",
  status: "open",
  shares: 1,
  submittedAt: NOW,
  priceAtSubmit: 200,
  initialStop: 190,
  riskPerShare: 10,
  accountValue: 100_000,
  shadowRiskPct: 0.5,
  shadowShares: 50,
  exitBy: "2026-11-30",
  entryPrice: 200,
  stopHistory: [{ at: NOW, stop: 190 }],
  targetHistory: [],
  notes: [],
  ...o,
});
const ctx = (o: Partial<Parameters<typeof preTradeChecks>[0]> = {}) => ({
  idea,
  quote,
  trades: [] as Trade[],
  settings: DEFAULT_SETTINGS,
  killSwitch: false,
  accountValue: 100_000,
  now: NOW,
  ...o,
});
const failed = (c: ReturnType<typeof preTradeChecks>) => c.filter((x) => !x.ok).map((x) => x.name);

describe("stock idea form", () => {
  it("requires every field and refuses a size", () => {
    expect(parseIdea({ ...idea }).errors).toEqual([]);
    const r = parseIdea({ ticker: "", direction: "up", thesis: "", source: "x", shares: 100 });
    expect(r.idea).toBeNull();
    expect(r.errors.join(" ")).toMatch(/Ticker[^]*Direction[^]*Entry type[^]*Stop[^]*Thesis[^]*Time frame[^]*Source[^]*Size/);
    expect(parseIdea({ ...idea, entryType: "limit" }).errors).toContain("Limit price is required for a limit entry");
    expect(parseIdea({ ...idea, target: "" }).idea?.target).toBeNull();
  });
});

describe("pre-trade checks", () => {
  it("passes a good long idea", () => {
    expect(failed(preTradeChecks(ctx()))).toEqual([]);
  });
  it("checks the stop side and the 1–25% risk", () => {
    expect(failed(preTradeChecks(ctx({ idea: { ...idea, stop: 205 } })))).toContain("Stop side");
    expect(failed(preTradeChecks(ctx({ idea: { ...idea, stop: 199 } })))).toContain("Risk to stop"); // 0.5%
    expect(failed(preTradeChecks(ctx({ idea: { ...idea, stop: 140 } })))).toContain("Risk to stop"); // 30%
    const short = { ...idea, direction: "short" as const, stop: 210, target: 180 };
    expect(failed(preTradeChecks(ctx({ idea: short })))).toEqual([]);
    expect(failed(preTradeChecks(ctx({ idea: short, quote: { ...quote, hardToBorrow: true } })))).toContain("Shortable");
    expect(failed(preTradeChecks(ctx({ idea: short, quote: { ...quote, shortable: null } })))).toContain("Shortable");
  });
  it("takes entries any time: market in the regular session, limit only outside it", () => {
    const lim = { ...idea, entryType: "limit" as const, limitPrice: 199 };
    expect(failed(preTradeChecks(ctx({ now: at("2026-11-18", 9, 31) })))).toEqual([]); // market, regular session
    expect(failed(preTradeChecks(ctx({ now: at("2026-11-18", 17) })))).toContain("Session"); // market after hours
    expect(failed(preTradeChecks(ctx({ idea: lim, now: at("2026-11-18", 17) })))).toEqual([]); // limit after hours
    expect(failed(preTradeChecks(ctx({ idea: lim, now: at("2026-11-26", 11) })))).toEqual([]); // limit on Thanksgiving
    expect(failed(preTradeChecks(ctx({ now: at("2026-11-26", 11) })))).toContain("Session");
    expect(failed(preTradeChecks(ctx({ killSwitch: true })))).toContain("Kill switch");
    expect((bracketOrder(lim, 1, "SEAMLESS") as { session: string }).session).toBe("SEAMLESS");
  });
  it("enforces max open, weekly count and one position per ticker (dry and live counted separately)", () => {
    const six = Array.from({ length: 20 }, (_, i) => trade({ ticker: `T${i}`, submittedAt: at("2026-11-10", 11) }));
    expect(failed(preTradeChecks(ctx({ trades: six })))).toContain("Max open ideas");
    const three = Array.from({ length: 20 }, (_, i) => trade({ ticker: `W${i}`, status: "closed", pl: 1 }));
    expect(failed(preTradeChecks(ctx({ trades: three })))).toContain("Ideas this week");
    expect(failed(preTradeChecks(ctx({ trades: three.map((t) => ({ ...t, mode: "live" as const })) })))).toEqual([]);
    expect(failed(preTradeChecks(ctx({ trades: [trade({ submittedAt: at("2026-11-10", 11) })] })))).toContain("One position per ticker");
  });
  it("locks out after a 2% shadow loss this week, and for 2 trading days after 3 losses in a row", () => {
    const loss = (d: string, shadowPl: number) => trade({ ticker: `L${d}${shadowPl}`, status: "closed", pl: -5, shadowPl, exitTime: at(d, 12), submittedAt: at("2026-11-09", 11) });
    expect(failed(preTradeChecks(ctx({ trades: [loss("2026-11-16", -3_100)] })))).toContain("Weekly loss lockout");
    expect(failed(preTradeChecks(ctx({ trades: [loss("2026-11-13", -3_100)] })))).not.toContain("Weekly loss lockout"); // last week
    const streak = [loss("2026-11-16", -10), loss("2026-11-16", -11), loss("2026-11-17", -12)];
    expect(streakLockUntil(streak, "dry")).toBe("2026-11-20");
    expect(failed(preTradeChecks(ctx({ trades: streak })))).toContain("Losing-streak lockout");
    expect(failed(preTradeChecks(ctx({ trades: streak, now: at("2026-11-20", 11) })))).not.toContain("Losing-streak lockout");
  });
});

describe("stops, results and settings", () => {
  it("only tightens stops", () => {
    const t = trade({});
    expect(checkStopChange(t, 185, 200)).toMatch(/tightened/);
    expect(checkStopChange(t, 195, 200)).toBeNull();
    expect(checkStopChange(t, 201, 200)).toMatch(/below/);
    expect(checkStopChange({ ...t, direction: "short", initialStop: 210, stopHistory: [{ at: 0, stop: 210 }] }, 215, 200)).toMatch(/tightened/);
  });
  it("computes P/L, R and shadow P/L", () => {
    const c = closeOut(trade({}), 215, NOW, "target");
    expect(c).toMatchObject({ pl: 15, plPct: 7.5, r: 1.5, shadowPl: 750, exitReason: "target" });
    // Spec example: $1M, entry 50, stop 45 → $10,000 ÷ $5 = 2,000 shares ($100K, 10%).
    expect(shadowSize(1_000_000, { riskPct: 1, maxPositionPct: 15 }, 50, 45)).toMatchObject({ shares: 2000, position: 100_000, positionPct: 10, risk: 10_000, riskPct: 1, capped: false });
    // A tight stop hits the 15% cap: risk comes out below 1%.
    expect(shadowSize(1_000_000, { riskPct: 1, maxPositionPct: 15 }, 50, 48)).toMatchObject({ shares: 3000, positionPct: 15, riskPct: 0.6, capped: true });
    const s = summarize([c, closeOut(trade({ source: "news" }), 190, NOW, "stop")], "dry");
    expect(s).toMatchObject({ trades: 2, wins: 1, totalR: 0.5 });
    expect(s.bySource.map((b) => b.key).sort()).toEqual(["news", "trend scout"]);
    expect(sizeUpEligible({ ...s, trades: 40, avgR: 0.2 }, 0)).toBe(true);
    expect(sizeUpEligible({ ...s, trades: 39, avgR: 0.2 }, 0)).toBe(false);
  });
  it("delays loosening 24 hours and applies tightening at once", () => {
    const r = changeSettings(null, { maxOpen: 25, maxPerWeek: 2, shares: 5 }, NOW);
    expect(r.delayed).toEqual(["maxOpen 20 → 25", "shares 1 → 5"]);
    expect(effectiveSettings(r.next, NOW)).toMatchObject({ maxOpen: 20, maxPerWeek: 2, shares: 1 });
    expect(effectiveSettings(r.next, NOW + 24 * 3600_000)).toMatchObject({ maxOpen: 25, shares: 5 });
    expect(changeSettings(null, { maxOpen: 500 }).errors.length).toBe(1);
  });
  it("builds a bracket: entry triggers OCO stop + target", () => {
    const o = bracketOrder(idea, 1) as { orderStrategyType: string; orderLegCollection: { instruction: string }[]; childOrderStrategies: { orderStrategyType: string; childOrderStrategies: { orderType: string }[] }[] };
    expect(o.orderStrategyType).toBe("TRIGGER");
    expect(o.orderLegCollection[0].instruction).toBe("BUY");
    expect(o.childOrderStrategies[0].orderStrategyType).toBe("OCO");
    expect(o.childOrderStrategies[0].childOrderStrategies.map((c) => c.orderType).sort()).toEqual(["LIMIT", "STOP"]);
    const s = bracketOrder({ ...idea, direction: "short", stop: 210, target: null }, 1) as { orderLegCollection: { instruction: string }[]; childOrderStrategies: { orderType: string; orderLegCollection: { instruction: string }[] }[] };
    expect(s.orderLegCollection[0].instruction).toBe("SELL_SHORT");
    expect(s.childOrderStrategies[0]).toMatchObject({ orderType: "STOP" });
    expect(s.childOrderStrategies[0].orderLegCollection[0].instruction).toBe("BUY_TO_COVER");
  });
  it("limits shadow gross and net exposure", () => {
    // 100k account; each open trade 50 sh × 200 = $10k long.
    const longs = Array.from({ length: 5 }, (_, i) => trade({ ticker: `X${i}`, submittedAt: at("2026-11-10", 11) })); // 50% long
    expect(failed(preTradeChecks(ctx({ trades: longs })))).toEqual(expect.arrayContaining(["Net exposure"])); // +65% > 50%
    const shorts = Array.from({ length: 4 }, (_, i) => trade({ ticker: `S${i}`, direction: "short", submittedAt: at("2026-11-10", 11) }));
    expect(failed(preTradeChecks(ctx({ trades: [...longs, ...shorts] })))).toContain("Gross exposure"); // 90% + 15%
  });
  it("size-up stages: 40 trades per step with average R above 0", () => {
    const won = (i: number) => trade({ ticker: `Z${i}`, status: "closed", pl: 1, r: 0.5, exitTime: NOW + i });
    expect(sizeUpStage(Array.from({ length: 39 }, (_, i) => won(i)), "dry", 0).stage).toBe(0);
    expect(sizeUpStage(Array.from({ length: 40 }, (_, i) => won(i)), "dry", 0).label).toMatch(/1\/4/);
    expect(sizeUpStage(Array.from({ length: 85 }, (_, i) => won(i)), "dry", 0).label).toMatch(/1\/2/);
    expect(sizeUpStage(Array.from({ length: 40 }, (_, i) => won(i)), "dry", 1).stage).toBe(0);
  });
  it("scores against SPY and the benchmark ETF", () => {
    // Long AAPL 200 → 215 (+7.5%), SPY 500 → 510 (+2%): +5.5% excess; stop distance 5% → 1.1R.
    const t = trade({ spyEntry: 500, benchmark: "XLK", benchEntry: 100 });
    expect(excessReturn(t, 215, 500, 510)).toEqual({ pct: 5.5, r: 1.1 });
    const c = closeOut(t, 215, NOW, "target", { spy: 510, bench: 104 });
    expect(c).toMatchObject({ spyExit: 510, excess: 5.5, excessR: 1.1, benchExit: 104, benchExcess: 3.5, benchExcessR: 0.7 });
    // Short: stock 200 → 190 (−5%), SPY +2% → excess = 2 − (−5) = +7%.
    const sh = trade({ direction: "short", initialStop: 210, spyEntry: 500 });
    expect(excessReturn(sh, 190, 500, 510)).toEqual({ pct: 7, r: 1.4 });
    // Without an entry mark there's no score.
    expect(closeOut(trade({}), 215, NOW, "target", { spy: 510 }).excess).toBeNull();
    const sum = summarize([c, closeOut(trade({ spyEntry: 500, source: "news" }), 190, NOW, "stop", { spy: 490 })], "dry");
    // Second: −5% vs SPY −2% → −3% (−0.6R). Average (5.5 − 3) / 2 = 1.25%, (1.1 − 0.6) / 2 = 0.25R.
    expect(sum).toMatchObject({ avgExcess: 1.25, avgExcessR: 0.25 });
    expect(sum.bySource.find((b) => b.key === "news")).toMatchObject({ avgExcess: -3, avgExcessR: -0.6 });
    expect(parseIdea({ ...idea, benchmark: "smh" }).idea?.benchmark).toBe("SMH");
    expect(parseIdea({ ...idea, benchmark: "" }).idea?.benchmark).toBeNull();
  });
  it("dates", () => {
    expect(weekStart("2026-11-22")).toBe("2026-11-16");
    expect(exitByDate("2026-11-18", 10)).toBe("2026-11-30"); // the 28th is a Saturday
  });
});
