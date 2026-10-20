import { describe, expect, it } from "vitest";
import { groupClosesByOrder, normalizeTransactions, realizedOn, type SchwabTransaction } from "@/lib/realized";

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
