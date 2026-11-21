import { describe, expect, it } from "vitest";
import { assertReadOnly, isAllowedSchwabPath } from "@/lib/schwab/readonly";

describe("read-only Schwab guard", () => {
  it("allows account, transaction and quote GETs", () => {
    expect(isAllowedSchwabPath("GET", "/trader/v1/accounts/accountNumbers")).toBe(true);
    expect(isAllowedSchwabPath("GET", "/trader/v1/accounts/ABC123?fields=positions")).toBe(true);
    expect(isAllowedSchwabPath("GET", "/trader/v1/accounts/ABC123/transactions?types=TRADE")).toBe(true);
    expect(isAllowedSchwabPath("GET", "/marketdata/v1/quotes?symbols=$SPX")).toBe(true);
    expect(isAllowedSchwabPath("GET", "/marketdata/v1/pricehistory?symbol=$SPX")).toBe(true);
    expect(isAllowedSchwabPath("GET", "/marketdata/v1/chains?symbol=$SPX")).toBe(true);
    expect(isAllowedSchwabPath("POST", "/marketdata/v1/chains")).toBe(false);
  });
  it("blocks orders and any non-GET", () => {
    expect(isAllowedSchwabPath("GET", "/trader/v1/accounts/ABC123/orders")).toBe(false);
    expect(isAllowedSchwabPath("POST", "/trader/v1/accounts/ABC123/orders")).toBe(false);
    expect(isAllowedSchwabPath("DELETE", "/trader/v1/accounts/ABC123/orders/1")).toBe(false);
    expect(isAllowedSchwabPath("POST", "/trader/v1/accounts/ABC123")).toBe(false);
    expect(isAllowedSchwabPath("GET", "/trader/v1/orders")).toBe(false);
    expect(() => assertReadOnly("PUT", "/trader/v1/accounts/x/orders/1")).toThrow(/read-only/);
  });
});

describe("Stock Trades order guard", async () => {
  const { assertEquityOnly, isAllowedOrderPath } = await import("@/lib/schwab/orderGuard");
  const { bracketOrder } = await import("@/lib/stocks/rules");
  it("allows only single-account order calls", () => {
    expect(isAllowedOrderPath("POST", "/trader/v1/accounts/ABC123/orders")).toBe(true);
    expect(isAllowedOrderPath("PUT", "/trader/v1/accounts/ABC123/orders/123")).toBe(true);
    expect(isAllowedOrderPath("DELETE", "/trader/v1/accounts/ABC123/orders/123")).toBe(true);
    expect(isAllowedOrderPath("POST", "/trader/v1/orders")).toBe(false);
    expect(isAllowedOrderPath("GET", "/trader/v1/accounts/ABC123/orders")).toBe(false); // no listing every order
    expect(isAllowedOrderPath("POST", "/trader/v1/accounts/ABC123/transactions")).toBe(false);
  });
  it("refuses non-equity legs anywhere in the order", () => {
    const o = bracketOrder({ ticker: "AAPL", direction: "long", entryType: "market", stop: 190, target: 220, thesis: "x", invalidation: "y", days: 5, source: "news" }, 1);
    expect(() => assertEquityOnly(o)).not.toThrow();
    const bad = JSON.parse(JSON.stringify(o).replace(/"EQUITY"/, '"OPTION"'));
    expect(() => assertEquityOnly(bad)).toThrow(/equity/);
  });
});
