import { describe, expect, it } from "vitest";
import { classifySpread, groupSpreads, normalizePosition, toLeg, type SchwabPosition } from "@/lib/spreads";

const opt = (symbol: string, qty: number, avg: number, mv: number, extra: Partial<SchwabPosition> = {}): SchwabPosition => ({
  longQuantity: qty > 0 ? qty : 0,
  shortQuantity: qty < 0 ? -qty : 0,
  averagePrice: avg,
  marketValue: mv,
  currentDayProfitLoss: 10,
  instrument: { assetType: "OPTION", symbol, putCall: symbol.includes("P0") ? "PUT" : "CALL", underlyingSymbol: "$SPX" },
  ...extra,
});

describe("normalizePosition", () => {
  it("computes signed qty, mark and open P/L for a short option", () => {
    const p = normalizePosition(opt("SPXW  261020P07720000", -18, 4.84, -3600));
    expect(p.qty).toBe(-18);
    expect(p.underlying).toBe("SPX");
    expect(p.expiration).toBe("2026-10-20");
    expect(p.mark).toBeCloseTo(2, 5);
    // sold for 4.84, now 2.00 -> +2.84 * 18 * 100
    expect(p.plOpen).toBeCloseTo(5112, 2);
    expect(toLeg(p)).toMatchObject({ qty: -18, strike: 7720, putCall: "P", avgPrice: 4.84 });
  });
  it("prefers Schwab's open P/L fields when present", () => {
    const p = normalizePosition(opt("SPXW  261020P07750000", 9, 28.16, 30000, { longOpenProfitLoss: 4656 }));
    expect(p.plOpen).toBe(4656);
  });
});

describe("groupSpreads", () => {
  const positions = [
    opt("SPXW  261020P07720000", -18, 4.84, -3600),
    opt("SPXW  261020P07750000", 9, 28.16, 30000),
    opt("SPXW  261020P07675000", 9, 0.32, 90),
    opt("SPXW  261022P07600000", -10, 3, -2000),
    opt("SPXW  261022P07525000", 10, 1, 500),
    { longQuantity: 100, averagePrice: 500, marketValue: 51000, instrument: { assetType: "EQUITY", symbol: "SPY" } },
  ].map(normalizePosition);

  const groups = groupSpreads(positions, "2026-10-20");

  it("groups by underlying + expiration, sorted by expiration", () => {
    expect(groups.map((g) => g.key)).toEqual(["SPX|2026-10-20", "SPX|2026-10-22", "SPY|SPY"]);
    expect(groups[0].isToday).toBe(true);
    expect(groups[0].dte).toBe(0);
    expect(groups[1].dte).toBe(2);
    expect(groups[1].isToday).toBe(false);
  });
  it("sorts legs by strike and labels structures", () => {
    expect(groups[0].positions.map((p) => p.strike)).toEqual([7675, 7720, 7750]);
    expect(groups[0].label).toBe("Put broken-wing butterfly");
    expect(groups[1].label).toBe("Put credit spread");
    expect(groups[2].label).toBe("Stock");
  });
  it("sums group P/L", () => {
    expect(groups[0].plDay).toBe(30);
  });
});

describe("classifySpread", () => {
  const L = (putCall: "P" | "C", strike: number, qty: number) => ({ putCall, strike, qty });
  it("names common structures", () => {
    expect(classifySpread([L("P", 7580, 18), L("P", 7680, -18), L("C", 7755, -18), L("C", 7855, 18)])).toBe("Iron condor");
    expect(classifySpread([L("P", 7600, 1), L("P", 7700, -1), L("C", 7700, -1), L("C", 7800, 1)])).toBe("Iron butterfly");
    expect(classifySpread([L("P", 7650, 1), L("P", 7700, -2), L("P", 7750, 1)])).toBe("Put butterfly");
    expect(classifySpread([L("C", 7800, 2), L("C", 7850, -2)])).toBe("Call debit spread");
    expect(classifySpread([L("P", 7600, -1)])).toBe("Short Put");
  });
});
