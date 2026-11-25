import { describe, expect, it } from "vitest";
import { portfolioStats, UNCLASSIFIED } from "../src/lib/stocks/portfolio";

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
