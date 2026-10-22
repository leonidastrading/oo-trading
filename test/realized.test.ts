import { describe, expect, it } from "vitest";
import { countOpenEntries, feesOn, groupClosesByOrder, normalizeTransactions, realizedOn, type SchwabTransaction } from "@/lib/realized";

const tx = (
  id: number,
  time: string,
  orderId: number,
  symbol: string,
  amount: number,
  price: number,
  effect: "OPENING" | "CLOSING",
  fee = 0.66,
): SchwabTransaction => ({
  activityId: id,
  time,
  type: "TRADE",
  orderId,
  netAmount: -amount * price * 100 - fee * Math.abs(amount),
  transferItems: [
    { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, cost: -fee * Math.abs(amount), feeType: "COMMISSION" },
    { instrument: { assetType: "OPTION", symbol }, amount, price, cost: -amount * price * 100, positionEffect: effect },
  ],
});

describe("realized P/L", () => {
  const P = "SPXW  261020P07720000";
  const fills = normalizeTransactions([
    tx(1, "2026-10-19T15:00:00+0000", 10, P, -10, 5, "OPENING"), // yesterday: sold 10 @5
    tx(2, "2026-10-20T14:00:00+0000", 11, P, -8, 6, "OPENING"), // today: sold 8 @6
    tx(3, "2026-10-20T18:00:00+0000", 12, P, 12, 2, "CLOSING"), // today: bought 12 @2 (FIFO: 10 from yday, 2 from today)
    tx(4, "2026-10-20T18:05:00+0000", 13, "SPXW  261020C07800000", 5, 0.5, "CLOSING"), // basis unknown
  ]);

  it("normalizes fills with signed qty, fees and cash", () => {
    expect(fills[0]).toMatchObject({ qty: -10, price: 5, fees: 6.6, cash: 5000 - 6.6, effect: "OPENING" });
  });

  it("FIFO-matches today's closes", () => {
    const closes = realizedOn(fills, "2026-10-20");
    expect(closes).toHaveLength(2);
    const [c, unknown] = closes;
    // 10 @ (5-2) and 2 @ (6-2), minus fees: opens 6.6 + 2*0.66, close 12*0.66
    expect(c.closedQty).toBe(12);
    expect(c.realized).toBeCloseTo(3000 + 800 - 6.6 - 1.32 - 7.92, 2);
    expect(unknown.realized).toBeNull();
    const orders = groupClosesByOrder(closes);
    expect(orders.find((o) => o.orderId === "13")!.unknownBasis).toBe(true);
  });
});

describe("fixed per-contract fees", () => {
  const P = "SPXW  261020P07720000";
  const fills = normalizeTransactions(
    [
      tx(1, "2026-10-20T14:00:00+0000", 20, P, -10, 5, "OPENING", 0.66),
      tx(2, "2026-10-20T18:00:00+0000", 21, P, 10, 2, "CLOSING", 0.66),
    ],
    0.88,
  );

  it("charges $0.88 per contract per side instead of Schwab's reported fee", () => {
    expect(fills.map((f) => f.fees)).toEqual([8.8, 8.8]);
    expect(fills[0].cash).toBeCloseTo(5000 - 8.8, 2);
  });

  it("nets the rate into realized P/L and totals fees for the day", () => {
    const [c] = realizedOn(fills, "2026-10-20");
    expect(c.realized).toBeCloseTo(3000 - 17.6, 2);
    expect(feesOn(fills, "2026-10-20")).toEqual({ contracts: 20, fees: 17.6 });
    expect(feesOn(fills, "2026-10-21")).toEqual({ contracts: 0, fees: 0 });
  });

  it("charges nothing on expiration/settlement rows", () => {
    const [f] = normalizeTransactions(
      [{ activityId: 9, time: "2026-10-20T21:00:00+0000", type: "RECEIVE_AND_DELIVER", netAmount: 0,
         transferItems: [{ instrument: { assetType: "OPTION", symbol: P }, amount: 10, positionEffect: "CLOSING" }] }],
      0.88,
    );
    expect(f.fees).toBe(0);
  });
});

describe("overnight cash settlements (Schwab posts ~01:45 ET next day)", () => {
  // Oct 20 put sold 8 @ 5.00; expired ITM at SPX 7712.57 -> settled 8 @ 37.43, posted 2026-10-21 01:47:50 ET.
  const P = "SPXW  261020P07750000";
  const fills = normalizeTransactions(
    [
      tx(1, "2026-10-20T18:00:00+0000", 30, P, -8, 5, "OPENING", 0.88),
      tx(2, "2026-10-21T05:47:50+0000", 31, P, 8, 37.43, "CLOSING", 0),
    ],
    0.88,
  );

  it("books the settlement on the expiration date, with no commission", () => {
    const s = fills[1];
    expect(s.bookDate).toBe("2026-10-20");
    expect(s.settlement).toBe(true);
    expect(s.fees).toBe(0);
  });

  it("realizes it on the expiration date, not the posting date", () => {
    expect(realizedOn(fills, "2026-10-21")).toHaveLength(0);
    const closes = realizedOn(fills, "2026-10-20");
    expect(closes).toHaveLength(1);
    expect(closes[0].realized).toBeCloseTo((5 - 37.43) * 8 * 100 - 8 * 0.88, 2);
  });

  it("excludes settlements from contract counts and fees", () => {
    expect(feesOn(fills, "2026-10-21")).toEqual({ contracts: 0, fees: 0 });
    expect(feesOn(fills, "2026-10-20")).toEqual({ contracts: 8, fees: 7.04 });
  });
});

describe("countOpenEntries", () => {
  const S = (pc: "P" | "C", k: number) => `SPXW  261022${pc}${String(k * 1000).padStart(8, "0")}`;
  const t = "2026-10-22T14:30:05+0000"; // same second for every entry
  // One transaction per leg; legs of one order share the orderId.
  const order = (orderId: number, legs: [string, number][], time = t, effect: "OPENING" | "CLOSING" = "OPENING") =>
    legs.map(([sym, qty], i) => tx(orderId * 10 + i, time, orderId, sym, qty, 1, effect, 0.88));
  const pos = (symbol: string, qty: number, expiration = "2026-10-22") => ({ symbol, qty, underlying: "SPX", expiration });

  const bwbA = order(1, [[S("P", 7720), -18], [S("P", 7750), 9], [S("P", 7675), 9]]);
  const bwbB = order(2, [[S("P", 7720), -18], [S("P", 7750), 9], [S("P", 7675), 9]]);
  const ic = order(3, [[S("P", 7680), -18], [S("C", 7755), -18], [S("P", 7580), 18], [S("C", 7855), 18]]);
  const book = [
    pos(S("P", 7720), -36), pos(S("P", 7750), 18), pos(S("P", 7675), 18),
    pos(S("P", 7680), -18), pos(S("C", 7755), -18), pos(S("P", 7580), 18), pos(S("C", 7855), 18),
  ];

  it("counts each order once, even when entries share strikes and the same second", () => {
    expect(countOpenEntries(normalizeTransactions([...bwbA, ...bwbB, ...ic], 0.88), book)).toBe(3);
  });

  it("drops an entry once it is fully closed", () => {
    const close = order(4, [[S("P", 7680), 18], [S("C", 7755), 18], [S("P", 7580), -18], [S("C", 7855), -18]], "2026-10-22T17:00:00+0000", "CLOSING");
    const fills = normalizeTransactions([...bwbA, ...bwbB, ...ic, ...close], 0.88);
    expect(countOpenEntries(fills, book.slice(0, 3))).toBe(2);
  });

  it("groups legs opened before the lookback window by underlying + expiration", () => {
    const older = [pos(S("P", 7600), -10, "2026-10-23"), pos(S("P", 7525), 10, "2026-10-23")];
    expect(countOpenEntries(normalizeTransactions(ic, 0.88), [...book.slice(3), ...older])).toBe(2);
  });
});
