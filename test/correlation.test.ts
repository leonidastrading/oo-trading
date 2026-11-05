import { describe, expect, it } from "vitest";
import { correlationMatrix } from "@/components/CorrelationMatrix";

describe("correlationMatrix", () => {
  it("is +1 for strategies that move together, −1 for opposites, with a portfolio column", () => {
    const pl = [100, -50, 30, -80];
    const daily = { days: ["d1", "d2", "d3", "d4"], pl: { A: pl, B: pl.map((x) => x * 2), C: pl.map((x) => -x * 0.5) } };
    const m = correlationMatrix(daily, ["A", "B", "C"]);
    expect(m[0][1]).toBeCloseTo(1, 6);
    expect(m[0][2]).toBeCloseTo(-1, 6);
    expect(m[1][1]).toBe(1);
    expect(m[0][3]).toBeCloseTo(1, 6); // portfolio = A + 2A − 0.5A
    expect(m).toHaveLength(4);
  });
});
