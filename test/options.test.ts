import { describe, expect, it } from "vitest";
import { analyzeClose, breakevens, expiryPnl, parseOptionSymbol, payoffCurve, type OptionLeg, type PutCall } from "@/lib/options";

const leg = (qty: number, putCall: PutCall, strike: number, avgPrice: number): OptionLeg => ({
  symbol: `SPXW  261020${putCall}${String(strike * 1000).padStart(8, "0")}`,
  underlying: "SPX",
  root: "SPXW",
  expiration: "2026-10-20",
  putCall,
  strike,
  qty,
  avgPrice,
});

describe("parseOptionSymbol", () => {
  it("parses Schwab/OCC symbols", () => {
    expect(parseOptionSymbol("SPXW  261020P07720000")).toEqual({
      root: "SPXW",
      expiration: "2026-10-20",
      putCall: "P",
      strike: 7720,
    });
    expect(parseOptionSymbol("SPY   261231C00612500")?.strike).toBe(612.5);
    expect(parseOptionSymbol("AAPL")).toBeNull();
  });
});

describe("2:1 put broken-wing butterfly", () => {
  // +9 P7750 @28.16, -18 P7720 @4.84, +9 P7675 @0.32
  const bwb = [leg(9, "P", 7750, 28.16), leg(-18, "P", 7720, 4.84), leg(9, "P", 7675, 0.32)];
  // net debit = 9*28.16 + 9*0.32 - 18*4.84 = 169.2 per 1 share-unit -> $16,920
  it("has the expected net debit", () => {
    expect(expiryPnl(bwb, 8000)).toBeCloseTo(-16920, 2);
  });
  it("peaks at the short strike", () => {
    // at 7720: long 7750 put worth 30 x 9 = 270 -> $27,000 - 16,920
    expect(expiryPnl(bwb, 7720)).toBeCloseTo(27000 - 16920, 2);
    const a = analyzeClose(bwb, 7720)!;
    expect(a.best.price).toBe(7720);
    expect(a.best.range).toBeNull();
  });
  it("loses the broken wing on the downside", () => {
    // Below 7675: 9*(7750-S) - 18*(7720-S) + 9*(7675-S) = 9*7750 + 9*7675 - 18*7720 = -135 -> -$13,500
    expect(expiryPnl(bwb, 7600)).toBeCloseTo(-13500 - 16920, 2);
  });
  it("finds breakevens on both sides", () => {
    const be = breakevens(payoffCurve(bwb, 7600, 7800));
    expect(be).toHaveLength(2);
    // Upper: 9*(7750-S)*100 = 16920 -> S = 7731.2
    expect(be[1]).toBeCloseTo(7731.2, 1);
    // Lower: 9*(7750-S) - 18*(7720-S) = 169.2 -> S = 7708.8
    expect(be[0]).toBeCloseTo(7708.8, 1);
  });
});

describe("4-leg iron condor", () => {
  // -18 P7680 .41, -18 C7755 .41, +18 P7580 .07, +18 C7855 .05 -> credit 0.70 = $1,260
  const ic = [leg(-18, "P", 7680, 0.41), leg(-18, "C", 7755, 0.41), leg(18, "P", 7580, 0.07), leg(18, "C", 7855, 0.05)];
  it("keeps the full credit between the shorts (flat max range)", () => {
    const a = analyzeClose(ic, 7720)!;
    expect(a.best.pnl).toBeCloseTo(1260, 2);
    expect(a.best.range).toEqual({ low: 7680, high: 7755 });
  });
  it("max loss is width minus credit beyond the wings", () => {
    expect(expiryPnl(ic, 7500)).toBeCloseTo(-(100 * 18 * 100) + 1260, 2);
    expect(expiryPnl(ic, 7950)).toBeCloseTo(-(100 * 18 * 100) + 1260, 2);
  });
  it("breakevens are short strikes ± credit", () => {
    const a = analyzeClose(ic, 7720)!;
    expect(a.profitZone?.lower).toBeCloseTo(7679.3, 2);
    expect(a.profitZone?.upper).toBeCloseTo(7755.7, 2);
  });
});

describe("today's book (best SPX close)", () => {
  const book: OptionLeg[] = [
    leg(-18, "P", 7680, 0.41), leg(-18, "C", 7755, 0.41), leg(18, "P", 7580, 0.07), leg(18, "C", 7855, 0.05),
    leg(-18, "P", 7720, 4.84), leg(9, "P", 7750, 28.16), leg(9, "P", 7675, 0.32),
    leg(-18, "P", 7720, 4.54), leg(9, "P", 7750, 29.61), leg(9, "P", 7675, 0.22),
    leg(-18, "P", 7690, 0.44), leg(-18, "C", 7740, 0.31), leg(18, "P", 7590, 0.07), leg(18, "C", 7840, 0.03),
    leg(-18, "P", 7715, 6.0), leg(9, "P", 7745, 32.43), leg(9, "P", 7670, 0.17),
  ];

  it("best close is 7720 with ≈ +$24,795", () => {
    const a = analyzeClose(book, 7718)!;
    expect(a.best.price).toBe(7720);
    expect(a.best.range).toBeNull();
    expect(a.best.pnl).toBeCloseTo(24795, 0);
  });

  it("P/L at 7710 ≈ +$6,795 and at 7730 ≈ −$2,205", () => {
    expect(expiryPnl(book, 7710)).toBeCloseTo(6795, 0);
    expect(expiryPnl(book, 7730)).toBeCloseTo(-2205, 0);
  });

  it("profit zone brackets the best close", () => {
    const a = analyzeClose(book, 7718)!;
    const { lower, upper } = a.profitZone!;
    expect(lower!).toBeGreaterThan(7705);
    expect(lower!).toBeLessThan(7710);
    expect(upper!).toBeGreaterThan(7725);
    expect(upper!).toBeLessThan(7730);
    // Breakevens are rounded to 0.01 pt; the curve moves ~$2,700/pt here.
    expect(Math.abs(expiryPnl(book, lower!))).toBeLessThan(30);
    expect(Math.abs(expiryPnl(book, upper!))).toBeLessThan(30);
  });

  it("covers ±3% and builds a ±50pt table in 5pt steps", () => {
    const a = analyzeClose(book, 7718)!;
    expect(a.lo).toBe(Math.ceil(7718 * 0.97));
    expect(a.hi).toBe(Math.floor(7718 * 1.03));
    expect(a.table).toHaveLength(21);
    expect(a.table.find((r) => r.isCurrent)!.price).toBe(7720);
    expect(a.table.find((r) => r.isBest)!.price).toBe(7720);
    expect(a.worst.pnl).toBeLessThan(-100000);
    expect(a.worst.atEdge).toBe(true);
  });
});

describe("open-ended upside (orphan long calls)", () => {
  // Live book from 2026-10-21: put spreads plus long calls with no short calls above.
  const book: OptionLeg[] = [
    leg(11, "P", 7510, 2.31), leg(-11, "P", 7585, 5.19), leg(21, "P", 7625, 0.17), leg(-21, "P", 7725, 4.97),
    leg(27, "C", 7880, 0.03), leg(18, "C", 7890, 0.03), leg(18, "C", 7895, 0.03),
  ];
  const a = analyzeClose(book, 7757.17)!;

  it("flags a best close at the range edge instead of presenting it as a target", () => {
    expect(a.best.atEdge).toBe(true);
    expect(a.best.price).toBe(a.hi);
  });
  it("reports the flat zone around the current price", () => {
    expect(a.spotZone).toEqual({ range: { low: 7725, high: 7880 }, pnl: a.pnlAtSpot });
    // Displayed avg prices are rounded to cents, so allow a few dollars vs. the live +$13,054.
    expect(Math.abs(a.pnlAtSpot - 13054)).toBeLessThan(20);
  });
  it("has a lower breakeven only", () => {
    expect(a.profitZone?.lower).toBeGreaterThan(7715);
    expect(a.profitZone?.lower).toBeLessThan(7725);
    expect(a.profitZone?.upper).toBeNull();
  });
  it("does not mark a flat ±50 table as all-best", () => {
    expect(a.table.filter((r) => r.isBest).length).toBeLessThan(a.table.length);
  });
});
