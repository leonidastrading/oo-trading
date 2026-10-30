import { describe, expect, it } from "vitest";
import { expiredOrders, pendingExpired, type ExpiredOpts } from "@/lib/expired";
import { expiryPnl } from "@/lib/options";
import type { Fill } from "@/lib/realized";
import { toLeg, type Position } from "@/lib/spreads";

const pos = (underlying: string, putCall: "P" | "C", strike: number, qty: number, avgPrice: number, expiration = "2026-10-21"): Position => ({
  symbol: `${underlying === "SPX" ? "SPXW " : underlying.padEnd(6)}${expiration.slice(2).replace(/-/g, "")}${putCall}${String(strike * 1000).padStart(8, "0")}`,
  assetType: "OPTION",
  description: "",
  underlying,
  expiration,
  putCall,
  strike,
  qty,
  avgPrice,
  mark: 0.03,
  marketValue: 0,
  plOpen: 0,
  plDay: 0,
});

// Live book from 2026-10-21, settled at 7757.17.
const book = [
  pos("SPX", "P", 7510, 11, 2.31), pos("SPX", "P", 7585, -11, 5.19), pos("SPX", "P", 7625, 21, 0.17),
  pos("SPX", "P", 7725, -21, 4.97), pos("SPX", "C", 7880, 27, 0.03), pos("SPX", "C", 7890, 18, 0.03),
  pos("SPX", "C", 7895, 18, 0.03),
];
const base: ExpiredOpts = { sessionDate: "2026-10-21", today: "2026-10-21", afterClose: true, settle: { SPX: 7757.17 }, fills: [] };

describe("expired options pending Schwab posting", () => {
  it("values today's SPX legs at settlement after the close", () => {
    const pending = pendingExpired(book, base);
    expect(pending).toHaveLength(7);
    const [order] = expiredOrders(pending, base);
    const legs = book.map(toLeg).filter((l) => l !== null);
    expect(order.realized).toBeCloseTo(expiryPnl(legs, 7757.17), 2);
    expect(Math.abs(order.realized - 13054)).toBeLessThan(20); // display rounding of avg prices
    expect(order.pending).toEqual({ settle: 7757.17 });
    expect(order.legs.every((l) => l.fill.fees === 0)).toBe(true);
  });

  it("does nothing before the close", () => {
    expect(pendingExpired(book, { ...base, afterClose: false })).toHaveLength(0);
  });

  it("still applies overnight, before Schwab posts", () => {
    expect(pendingExpired(book, { ...base, today: "2026-10-22", afterClose: false })).toHaveLength(7);
  });

  it("skips legs Schwab has already posted", () => {
    const posted = { symbol: book[3].symbol, settlement: true, bookDate: "2026-10-21" } as Fill;
    expect(pendingExpired(book, { ...base, fills: [posted] })).toHaveLength(6);
  });

  it("ignores stock options, other expirations and missing prices", () => {
    const others = [pos("SPY", "P", 600, -5, 1), pos("SPX", "P", 7600, -5, 3, "2026-10-23")];
    expect(pendingExpired(others, base)).toHaveLength(0);
    expect(pendingExpired(book, { ...base, settle: {} })).toHaveLength(0);
  });
});

describe("legs Schwab dropped overnight before posting", () => {
  const fill = (symbol: string, qty: number, price: number, orderId: string): Fill => ({
    id: `${orderId}-${symbol}`,
    time: Date.parse("2026-10-28T17:30:00Z"),
    orderId,
    type: "TRADE",
    symbol,
    assetType: "OPTION",
    underlying: "SPX",
    expiration: "2026-10-28",
    putCall: symbol.includes("P0") ? "P" : "C",
    strike: Number(symbol.slice(-8)) / 1000,
    qty,
    price,
    fees: 0,
    schwabFees: 0,
    cash: -qty * price * 100,
    effect: "OPENING",
    bookDate: "2026-10-28",
    settlement: false,
  });
  const short = "SPXW  261028P07655000";
  const long = "SPXW  261028P07555000";
  const fills = [fill(short, -13, 2.0, "1"), fill(long, 13, 0.2, "1")];

  it("rebuilds expired legs from the fills when they've left the account", async () => {
    const { ghostExpired } = await import("@/lib/expired");
    const ghosts = ghostExpired([], fills, "2026-10-28");
    expect(ghosts.map((g) => [g.symbol, g.qty, g.avgPrice])).toEqual([
      [short, -13, 2],
      [long, 13, 0.2],
    ]);
    // Still in the account → not a ghost; another day → not a ghost.
    expect(ghostExpired([{ ...ghosts[0] }], fills, "2026-10-28").map((g) => g.symbol)).toEqual([long]);
    expect(ghostExpired([], fills, "2026-10-27")).toEqual([]);
    // Valued at settlement next morning (expired OTM: keep the 1.80 credit × 13).
    const opts: ExpiredOpts = { sessionDate: "2026-10-28", today: "2026-10-29", afterClose: false, settle: { SPX: 7700 }, fills };
    const [order] = expiredOrders(pendingExpired(ghosts, opts), opts);
    expect(order.realized).toBeCloseTo(13 * 1.8 * 100);
  });
});

describe("stale position snapshot after Schwab posts the settlement", () => {
  it("treats a settled leg as closed", async () => {
    const { settledSymbols } = await import("@/lib/expired");
    const leg = "SPXW  261029C07705000";
    const settled = { symbol: leg, settlement: true, expiration: "2026-10-29" } as Fill;
    const trade = { symbol: "SPXW  261030P07600000", settlement: false, expiration: "2026-10-30" } as Fill;
    expect(settledSymbols([settled, trade], "2026-10-30")).toEqual([leg]);
    expect(settledSymbols([settled], "2026-10-29")).toEqual([]);
  });
});
