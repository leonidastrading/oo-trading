import { describe, expect, it } from "vitest";
import { classifySpread, groupSpreads, normalizePosition, splitByEntry, toLeg, type EntryLot, type SchwabPosition } from "@/lib/spreads";

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

describe("splitByEntry (Schwab nets shared strikes; split them back per order)", () => {
  const S = (pc: "P" | "C", k: number) => `SPXW  261022${pc}${String(k * 1000).padStart(8, "0")}`;
  const P = (symbol: string, qty: number, avg: number, mark: number) =>
    normalizePosition(opt(symbol, qty, avg, qty * mark * 100, { currentDayProfitLoss: qty * (mark - avg) * 100 }));
  // Live book 2026-10-22 as Schwab shows it (netted), and the two IC entries from Option Omega.
  const positions = [
    P(S("P", 7505), 36, 0.095, 0.08), P(S("P", 7605), -36, 0.67, 0.48),
    P(S("C", 7690), -18, 0.35, 0.38), P(S("C", 7710), -18, 0.6, 0.13),
    P(S("C", 7790), 18, 0.08, 0.08), P(S("C", 7810), 18, 0.12, 0.03),
  ];
  const lot = (symbol: string, qty: number, price: number, orderId: string, time: number) => [symbol, { qty, price, orderId, time }] as const;
  const lotList = [
    lot(S("P", 7605), -18, 0.74, "A", 1), lot(S("C", 7710), -18, 0.6, "A", 1), lot(S("P", 7505), 18, 0.12, "A", 1), lot(S("C", 7810), 18, 0.12, "A", 1),
    lot(S("P", 7605), -18, 0.6, "B", 2), lot(S("C", 7690), -18, 0.35, "B", 2), lot(S("P", 7505), 18, 0.07, "B", 2), lot(S("C", 7790), 18, 0.08, "B", 2),
  ];
  const lots = new Map<string, EntryLot[]>();
  for (const [s, l] of lotList) lots.set(s, [...(lots.get(s) ?? []), l]);

  const groups = groupSpreads(splitByEntry(positions, lots), "2026-10-22");

  it("shows two iron condors instead of one 6-leg custom group", () => {
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(["Iron condor", "Iron condor"]);
    expect(groups.map((g) => g.positions.length)).toEqual([4, 4]);
    expect(groups.map((g) => g.enteredAt)).toEqual([1, 2]);
  });

  it("uses each entry's own fill prices and keeps quantities intact", () => {
    const a = groups[0].positions.find((p) => p.symbol === S("P", 7605))!;
    const b = groups[1].positions.find((p) => p.symbol === S("P", 7605))!;
    expect([a.qty, a.avgPrice, b.qty, b.avgPrice]).toEqual([-18, 0.74, -18, 0.6]);
    const total = (sym: string) => groups.flatMap((g) => g.positions).filter((p) => p.symbol === sym).reduce((s, p) => s + p.qty, 0);
    expect(total(S("P", 7605))).toBe(-36);
    expect(total(S("P", 7505))).toBe(36);
  });

  it("keeps legs without matching fills at Schwab's numbers", () => {
    const g = groupSpreads(splitByEntry(positions, new Map()), "2026-10-22");
    expect(g).toHaveLength(1);
    expect(g[0].plOpen).toBeCloseTo(positions.reduce((s, p) => s + p.plOpen, 0), 6);
  });
});
