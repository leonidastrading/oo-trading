import { describe, expect, it } from "vitest";
import { portfolioStats, UNCLASSIFIED } from "../src/lib/stocks/portfolio";
import { closeOut, dailyClosedCurve, openPlSample, splitForPartial, type Trade } from "../src/lib/stocks/rules";

describe("portfolio stats", () => {
  const s = portfolioStats([
    { ticker: "A", long: true, value: 300, dayPct: 1.2, sector: "Technology" },
    { ticker: "B", long: false, value: 200, dayPct: -0.5, sector: "Technology" },
    { ticker: "C", long: false, value: 400, dayPct: 2, sector: "Finance" },
    { ticker: "D", long: true, value: 100, dayPct: null, sector: "" },
  ]);
  it("splits long and short and counts today's movers", () => {
    expect(s).toMatchObject({ positions: 4, long: 400, short: 600, invested: 1000, longCount: 2, shortCount: 2, advancers: 2, decliners: 1, unchanged: 0, inFavour: 2, against: 1 });
  });
  it("rolls up sectors, largest first, with the short share of each", () => {
    expect(s.sectors.map((r) => r.sector)).toEqual(["Technology", "Finance", UNCLASSIFIED]);
    expect(s.sectors[0]).toMatchObject({ positions: 2, long: 300, short: 200, total: 500, pctOfInvested: 50, shortPct: 40 });
    expect(s.sectors[1]).toMatchObject({ pctOfInvested: 40, shortPct: 100 });
  });
});

describe("equity curves", () => {
  const base = { mode: "dry", direction: "long", status: "open", shares: 1, shadowShares: 100, entryPrice: 50 } as unknown as Trade;
  it("samples open P/L at shadow size for dry runs and skips unpriced or unfilled trades", () => {
    const prices: Record<string, number> = { A: 52, B: 21, D: 99 };
    const s = openPlSample(
      [
        { ...base, ticker: "A" },
        { ...base, ticker: "B", direction: "short", shadowShares: 10, entryPrice: 20 },
        { ...base, ticker: "C" },
        { ...base, ticker: "D", status: "pending" },
      ] as Trade[],
      (t) => prices[t] ?? null,
      1,
    );
    expect(s).toEqual({ t: 1, pl: 190, cost: 5200, n: 2 });
  });
  it("adds closed trades up by closing day", () => {
    const day = (d: string) => Date.parse(d + "T18:00:00Z");
    const c = dailyClosedCurve(
      [
        { ...base, status: "closed", exitTime: day("2026-11-24"), shadowPl: 100, pl: 1 },
        { ...base, status: "closed", exitTime: day("2026-11-24"), shadowPl: -40, pl: 1 },
        { ...base, status: "closed", exitTime: day("2026-11-25"), shadowPl: 25, pl: 1 },
        { ...base, status: "closed", exitTime: day("2026-11-25"), shadowPl: 999, mode: "live" },
      ] as Trade[],
      "dry",
    );
    expect(c).toEqual([
      { date: "2026-11-24", day: 60, total: 60, trades: 2 },
      { date: "2026-11-25", day: 25, total: 85, trades: 1 },
    ]);
  });
});

describe("partial exits", () => {
  const t = {
    id: "a", mode: "dry", direction: "long", status: "open", ticker: "X", shares: 1000, shadowShares: 1000, fullShadowShares: 1000,
    entryPrice: 50, initialStop: 40, stop: 40, plannedRisk: 10000, stopHistory: [], targetHistory: [], notes: [],
  } as unknown as Trade;
  it("splits shares and planned risk; the slice remembers where it came from", () => {
    const s = splitForPartial(t, 25, "b")!;
    expect(s.slice).toMatchObject({ id: "b", partialOf: "a", shares: 250, shadowShares: 250, plannedRisk: 2500 });
    expect(s.rest).toMatchObject({ id: "a", shares: 750, shadowShares: 750, plannedRisk: 7500 });
    expect(s.rest.partialOf).toBeUndefined();
    expect(splitForPartial(t, 100, "b")).toBeNull();
    expect(splitForPartial({ ...t, status: "pending" } as Trade, 50, "b")).toBeNull();
  });
  it("scores the closed slice on its own shares, with the same R as the whole position would get", () => {
    const s = splitForPartial(t, 50, "b")!;
    const done = closeOut(s.slice, 55, 1, "manual", { spy: null, bench: null });
    expect(done).toMatchObject({ status: "closed", shadowPl: 2500, r: 0.5 });
  });
});
