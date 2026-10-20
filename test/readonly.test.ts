import { describe, expect, it } from "vitest";
import { assertReadOnly, isAllowedSchwabPath } from "@/lib/schwab/readonly";

describe("read-only Schwab guard", () => {
  it("allows account, transaction and quote GETs", () => {
    expect(isAllowedSchwabPath("GET", "/trader/v1/accounts/accountNumbers")).toBe(true);
    expect(isAllowedSchwabPath("GET", "/trader/v1/accounts/ABC123?fields=positions")).toBe(true);
    expect(isAllowedSchwabPath("GET", "/trader/v1/accounts/ABC123/transactions?types=TRADE")).toBe(true);
    expect(isAllowedSchwabPath("GET", "/marketdata/v1/quotes?symbols=$SPX")).toBe(true);
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
